const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, AttachmentBuilder } = require('discord.js');
const { canManageKimlan, getUserDisplayName } = require('../utils');
const { data } = require('../state');
const kimlan = require('../services/kimlan');
const partyAssignment = require('../services/partyAssignment');
const log = require('../../logger');

const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CONTENT = 1900;
const cache = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of cache.entries()) {
        if (now - v.generatedAt > CACHE_TTL_MS) cache.delete(k);
    }
}, 5 * 60 * 1000).unref?.();

function newCacheKey() {
    return Math.random().toString(36).slice(2, 10);
}

function buildMembers(guildId, warnings) {
    const participants = data.participants && data.participants[guildId] ? data.participants[guildId] : {};
    const regs = data.registrations && data.registrations[guildId] ? data.registrations[guildId] : {};
    const members = [];
    let missing = 0;
    for (const uid of Object.keys(participants)) {
        if (!participants[uid]) continue;
        const reg = regs[uid];
        if (!reg || !reg.class) { missing++; continue; }
        members.push({
            id: uid,
            name: getUserDisplayName(uid, guildId),
            faction: reg.class
        });
    }
    if (missing > 0) warnings.push(`${missing} thành viên đã đăng ký nhưng thiếu phái, bị bỏ qua.`);
    return members;
}

function renderView(result, mode, guildId) {
    const title = mode === 'sa' ? 'SIMULATED ANNEALING' : 'GREEDY';
    const subsArr = mode === 'sa' ? result.saSubs : result.greedySubs;
    const metrics = mode === 'sa' ? result.metricsSA : result.metricsGreedy;
    const lines = [];
    lines.push(`=== ${title} ===`);
    lines.push('');

    for (let pi = 0; pi < result.parties.length; pi++) {
        const p = result.parties[pi];
        lines.push(`Party ${pi + 1} (${p.members.length} người):`);
        const subs = subsArr[pi];
        for (let si = 0; si < subs.length; si++) {
            const sub = subs[si];
            if (sub.length === 0) {
                lines.push(`  Sub ${si + 1}: (trống)`);
            } else {
                const names = sub.map(m => getUserDisplayName(m.id, guildId));
                lines.push(`  Sub ${si + 1}: ${names.join(', ')}`);
            }
        }
        lines.push('');
    }

    lines.push('— Metrics —');
    const pct = (a, b) => b > 0 ? (100 * a / b).toFixed(1) : '0.0';
    lines.push(`Kim lan buff (party): ${metrics.partySatisfied}/${metrics.totalKimlanMembers} (${pct(metrics.partySatisfied, metrics.totalKimlanMembers)}%)`);
    lines.push(`Kim lan buff (sub):   ${metrics.subSatisfied}/${metrics.totalKimlanMembers} (${pct(metrics.subSatisfied, metrics.totalKimlanMembers)}%)`);
    lines.push(`Sub có Tank: ${metrics.subsWithTank}/${metrics.totalSubs} | Sub có Buff: ${metrics.subsWithBuff}/${metrics.totalSubs} | T hoặc B: ${metrics.subsWithEither}/${metrics.totalSubs}`);
    lines.push(`Phái TB / sub: ${metrics.avgFactionsPerSub.toFixed(2)} (max lý thuyết 6.0)`);
    lines.push(`Party có T/B: ${metrics.partiesWithEither}/${metrics.numParties}`);

    if (result.warnings.length > 0) {
        lines.push('');
        for (const w of result.warnings) lines.push(`⚠ ${w}`);
    }

    return lines.join('\n');
}

function buildRow(mode, cacheKey) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`arrange_g_${cacheKey}`)
            .setLabel(mode === 'greedy' ? '• GREEDY' : 'GREEDY')
            .setStyle(mode === 'greedy' ? ButtonStyle.Secondary : ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`arrange_s_${cacheKey}`)
            .setLabel(mode === 'sa' ? '• SA' : 'SA')
            .setStyle(mode === 'sa' ? ButtonStyle.Secondary : ButtonStyle.Primary)
    );
}

function buildPayload(result, mode, cacheKey, guildId) {
    const body = renderView(result, mode, guildId);
    const row = buildRow(mode, cacheKey);
    if (body.length + 8 <= MAX_CONTENT) {
        return { content: '```\n' + body + '\n```', components: [row], files: [] };
    }
    const attachment = new AttachmentBuilder(Buffer.from(body, 'utf8'), { name: `arrange_${mode}.txt` });
    const summary = body.split('\n').slice(-10).join('\n');
    return {
        content: 'Kết quả quá dài, đính kèm file. Tóm tắt:\n```\n' + summary.slice(-1800) + '\n```',
        components: [row],
        files: [attachment]
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('arrange')
        .setDescription('Chia party bang chiến (greedy + simulated annealing)'),
    async execute(interaction) {
        const fail = reason => ({ content: `Lệnh không thành công vì ${reason}`, flags: MessageFlags.Ephemeral });
        if (!canManageKimlan(interaction)) {
            await interaction.reply(fail('bạn không có quyền quản lý kim lan'));
            return;
        }
        await interaction.deferReply();

        const warnings = [];
        const members = buildMembers(interaction.guildId, warnings);
        if (members.length === 0) {
            await interaction.editReply({ content: 'Không có ai đăng ký bang chiến (hoặc đều thiếu phái).' });
            return;
        }
        const kimlanGroups = kimlan.getKimlanGroupsForGuild(interaction.guildId);
        const t0 = Date.now();
        const result = partyAssignment.arrange(members, kimlanGroups);
        log.info(`/arrange: ${members.length} thành viên, ${kimlanGroups.length} nhóm kim lan, ${Date.now() - t0}ms`);
        result.warnings = warnings.concat(result.warnings);

        const cacheKey = newCacheKey();
        cache.set(cacheKey, { result, generatedAt: Date.now(), guildId: interaction.guildId });

        const payload = buildPayload(result, 'greedy', cacheKey, interaction.guildId);
        await interaction.editReply(payload);
    },
    async handleButton(interaction) {
        const id = interaction.customId;
        if (!id.startsWith('arrange_')) return false;
        const parts = id.split('_');
        if (parts.length !== 3) return false;
        const modeChar = parts[1];
        const cacheKey = parts[2];
        const mode = modeChar === 's' ? 'sa' : 'greedy';
        const entry = cache.get(cacheKey);
        if (!entry) {
            await interaction.reply({ content: 'Kết quả đã hết hạn, chạy lại /arrange.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const payload = buildPayload(entry.result, mode, cacheKey, entry.guildId);
        await interaction.update(payload);
        return true;
    }
};
