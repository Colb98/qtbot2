const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, AttachmentBuilder } = require('discord.js');
const { canManageKimlan, isSuperAdmin } = require('../utils');
const { data } = require('../state');
const kimlan = require('../services/kimlan');
const partyAssignment = require('../services/partyAssignment');
const partyImage = require('../services/partyImage');
const log = require('../../logger');

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

const RATE_LIMIT_MS = 30 * 1000;
const lastUseByGuild = new Map();

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
        members.push({ id: uid, name: uid, faction: reg.class });
    }
    if (missing > 0) warnings.push(`${missing} thành viên đã đăng ký nhưng thiếu phái, bị bỏ qua.`);
    return members;
}

function renderMetricsText(result, mode) {
    const m = mode === 'sa' ? result.metricsSA : result.metricsGreedy;
    const pct = (a, b) => b > 0 ? (100 * a / b).toFixed(1) : '0.0';
    const lines = [];
    lines.push(`**Chia party — ${mode === 'sa' ? 'SIMULATED ANNEALING' : 'GREEDY'}**`);
    lines.push(`Kim lan buff (sub): ${m.subSatisfied}/${m.totalKimlanMembers} (${pct(m.subSatisfied, m.totalKimlanMembers)}%) | Sub có T/B: ${m.subsWithEither}/${m.totalSubs} | Phái TB/sub: ${m.avgFactionsPerSub.toFixed(2)}`);
    if (result.pushInfo && result.pushInfo.created) {
        lines.push(`Party đẩy trụ: ${result.pushInfo.clCount} Cửu Linh + ${result.pushInfo.tvCount} Tố Vấn`);
    } else if (result.pushInfo && result.pushInfo.enabled) {
        lines.push(`Party đẩy trụ: không tạo được (không đủ Cửu Linh)`);
    }
    if (result.warnings.length > 0) {
        for (const w of result.warnings.slice(0, 2)) lines.push(`⚠ ${w}`);
        if (result.warnings.length > 2) lines.push(`⚠ +${result.warnings.length - 2} cảnh báo khác`);
    }
    return lines.join('\n').slice(0, 1900);
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

async function buildPayload(result, mode, cacheKey, guildId) {
    const buf = await partyImage.renderArrangement(result, mode, guildId);
    const attachment = new AttachmentBuilder(buf, { name: `arrange_${mode}.png` });
    return {
        content: renderMetricsText(result, mode),
        files: [attachment],
        components: [buildRow(mode, cacheKey)]
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('arrange')
        .setDescription('Chia party bang chiến (greedy + simulated annealing)')
        .addBooleanOption(o => o.setName('day_tru')
            .setDescription('Dồn Cửu Linh + 2 Tố Vấn vào 1 party đẩy trụ (default: true)')
            .setRequired(false)),
    async execute(interaction) {
        const fail = reason => ({ content: `Lệnh không thành công vì ${reason}`, flags: MessageFlags.Ephemeral });
        // if (!canManageKimlan(interaction)) {
        //     await interaction.reply(fail('bạn không có quyền quản lý kim lan'));
        //     return;
        // }
        if (!isSuperAdmin(interaction.member.id)) {
            const last = lastUseByGuild.get(interaction.guildId) || 0;
            const remaining = RATE_LIMIT_MS - (Date.now() - last);
            if (remaining > 0) {
                await interaction.reply(fail(`/arrange vừa được dùng, vui lòng chờ ${Math.ceil(remaining / 1000)} giây`));
                return;
            }
        }
        lastUseByGuild.set(interaction.guildId, Date.now());
        await interaction.deferReply();

        const warnings = [];
        const members = buildMembers(interaction.guildId, warnings);
        if (members.length === 0) {
            await interaction.editReply({ content: 'Không có ai đăng ký bang chiến (hoặc đều thiếu phái).' });
            return;
        }
        const dayTru = interaction.options.getBoolean('day_tru') ?? true;
        const kimlanGroups = kimlan.getKimlanGroupsForGuild(interaction.guildId);
        const t0 = Date.now();
        const result = partyAssignment.arrange(members, kimlanGroups, { dayTru });
        log.info(`/arrange: ${members.length} thành viên, ${kimlanGroups.length} kim lan, day_tru=${dayTru}, ${Date.now() - t0}ms`);
        result.warnings = warnings.concat(result.warnings);

        const cacheKey = newCacheKey();
        cache.set(cacheKey, { result, generatedAt: Date.now(), guildId: interaction.guildId, dayTru });

        const payload = await buildPayload(result, 'greedy', cacheKey, interaction.guildId);
        await interaction.editReply(payload);
    },
    async handleButton(interaction) {
        const id = interaction.customId;
        if (!id.startsWith('arrange_')) return false;
        const parts = id.split('_');
        if (parts.length !== 3) return false;
        const mode = parts[1] === 's' ? 'sa' : 'greedy';
        const cacheKey = parts[2];
        const entry = cache.get(cacheKey);
        if (!entry) {
            await interaction.reply({ content: 'Kết quả đã hết hạn, chạy lại /arrange.', flags: MessageFlags.Ephemeral });
            return true;
        }
        await interaction.deferUpdate();
        const payload = await buildPayload(entry.result, mode, cacheKey, entry.guildId);
        await interaction.editReply(payload);
        return true;
    }
};
