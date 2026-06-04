const {
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');
const log = require('../../logger');
const client = require('../client');
const { data, saveData } = require('../state');
const { addNgoc, renderEmote, fmt, todayStr } = require('./currency');
const economy = require('../config/economy');
const { genEquation } = require('./mathGen');
const metrics = require('./metrics');

const HARD_CAP_MS = 24 * 60 * 60 * 1000;
const TIMER_GRACE_MS = 2000;

const TIERS = {
    small:  { key: 'SMALL',  label: 'Boss Nhỏ',  emoji: '🟢' },
    medium: { key: 'MEDIUM', label: 'Boss Vừa',  emoji: '🟡' },
    big:    { key: 'BIG',    label: 'Boss Lớn',  emoji: '🔴' }
};

const sessions = new Map(); // threadId -> raid session
const threads  = new Map(); // threadId -> { hardCapTimer }
const _msgLocks = new Map();

function hasThread(threadId) {
    return threads.has(threadId);
}

function cfgFor(tier) {
    return economy.MATHBOSS[TIERS[tier].key];
}

// ── Daily caps (summon count per tier, ngọc earned) ─────────────────────────

function ensureRoot() {
    if (!data.mathBoss) data.mathBoss = {};
    if (!data.mathBoss.summonCaps) data.mathBoss.summonCaps = {};
    if (!data.mathBoss.ngocCaps)   data.mathBoss.ngocCaps   = {};
}

function getSummonCap(guildId, userId) {
    ensureRoot();
    if (!data.mathBoss.summonCaps[guildId]) data.mathBoss.summonCaps[guildId] = {};
    const existing = data.mathBoss.summonCaps[guildId][userId];
    const today = todayStr();
    if (!existing || existing.date !== today) {
        data.mathBoss.summonCaps[guildId][userId] = { date: today, small: 0, medium: 0, big: 0 };
    }
    return data.mathBoss.summonCaps[guildId][userId];
}

// Returns { ok, used, cap }. Does NOT consume; call consumeSummon after success.
function checkSummon(guildId, userId, tier) {
    const cap = getSummonCap(guildId, userId);
    const limit = cfgFor(tier).SUMMON_CAP;
    return { ok: cap[tier] < limit, used: cap[tier], cap: limit };
}

function consumeSummon(guildId, userId, tier) {
    const cap = getSummonCap(guildId, userId);
    cap[tier]++;
    saveData();
}

function getNgocCap(guildId, userId) {
    ensureRoot();
    if (!data.mathBoss.ngocCaps[guildId]) data.mathBoss.ngocCaps[guildId] = {};
    const existing = data.mathBoss.ngocCaps[guildId][userId];
    const today = todayStr();
    if (!existing || existing.date !== today) {
        data.mathBoss.ngocCaps[guildId][userId] = { date: today, earned: 0 };
    }
    return data.mathBoss.ngocCaps[guildId][userId];
}

function earnNgoc(guildId, userId, amount) {
    const cap = getNgocCap(guildId, userId);
    const remaining = economy.MATHBOSS.NGOC_DAILY_CAP - cap.earned;
    const actual = Math.min(amount, Math.max(0, remaining));
    if (actual > 0) {
        cap.earned += actual;
        addNgoc(guildId, userId, actual);
    }
    return actual;
}

// Drop stale per-user daily summon/ngọc-cap entries from previous days.
function pruneDaily(today) {
    ensureRoot();
    today = today || todayStr();
    let removed = 0;
    for (const mapName of ['summonCaps', 'ngocCaps']) {
        const m = data.mathBoss[mapName] || {};
        for (const guildId of Object.keys(m)) {
            const g = m[guildId];
            for (const uid of Object.keys(g)) {
                if (!g[uid] || g[uid].date !== today) { delete g[uid]; removed++; }
            }
            if (Object.keys(g).length === 0) delete m[guildId];
        }
    }
    if (removed) saveData();
    return removed;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEquation(tier) {
    const c = cfgFor(tier);
    return genEquation({ nums: 2, min: c.MIN, max: c.MAX, ops: c.OPS, multMax: economy.MATHBOSS.MULT_MAX_FACTOR });
}

function livingPlayers(session) {
    return [...session.players.values()].filter(p => p.hp > 0);
}

function maxLivingHp(session) {
    const living = livingPlayers(session);
    if (living.length === 0) return cfgFor(session.tier).PLAYER_HP;
    return Math.max(...living.map(p => p.hp));
}

// New joiners enter at the current top living HP (capped at base) so a fresh
// body can't reset a near-dead team's survivability.
function ensurePlayer(session, userId, displayName) {
    let p = session.players.get(userId);
    if (p) {
        if (displayName) p.displayName = displayName;
        return p;
    }
    const startHp = Math.min(maxLivingHp(session), cfgFor(session.tier).PLAYER_HP);
    p = { hp: startHp, maxHp: cfgFor(session.tier).PLAYER_HP, dmg: 0, displayName: displayName || userId };
    session.players.set(userId, p);
    return p;
}

function hpBar(session) {
    const parts = [`${TIERS[session.tier].emoji} **Boss** ${session.bossHp}/${session.bossMaxHp} ❤️`];
    for (const [uid, p] of session.players) {
        const heart = p.hp > 0 ? '❤️' : '💀';
        parts.push(`<@${uid}> ${Math.max(0, p.hp)}/${p.maxHp} ${heart}`);
    }
    return parts.join(' · ');
}

// ── Timer helpers ──────────────────────────────────────────────────────────

function armTimer(session) {
    if (session.timer) clearTimeout(session.timer);
    const c = cfgFor(session.tier);
    session.timer = setTimeout(() => onTurnTimeout(session.threadId), c.TIME_S * 1000 + TIMER_GRACE_MS);
}

function armThreadHardCap(threadInfo, threadId) {
    if (threadInfo.hardCapTimer) clearTimeout(threadInfo.hardCapTimer);
    threadInfo.hardCapTimer = setTimeout(() => closeThread(threadId, { reason: 'hard_cap' }), HARD_CAP_MS);
}

// ── Turn flow ───────────────────────────────────────────────────────────────

async function startTurn(session, thread) {
    const c = cfgFor(session.tier);
    session.turn++;
    session.equations = [];
    for (let i = 0; i < c.EQ; i++) {
        const eq = makeEquation(session.tier);
        session.equations.push({ text: eq.text, answer: eq.answer, solved: false });
    }
    session.solvedThisTurn = 0;

    const endUnix = Math.floor((Date.now() + c.TIME_S * 1000) / 1000);
    const eqLines = session.equations.map((eq, i) =>
        c.EQ > 1 ? `**${i + 1}.** ${eq.text} = ?` : `## ${eq.text} = ?`
    );
    await thread.send(
        `⚔️ **Lượt ${session.turn}** — giải ${c.EQ > 1 ? `cả **${c.EQ}** phép tính` : 'phép tính'} (gõ đáp án):\n` +
        eqLines.join('\n') + `\n⏱️ Trước <t:${endUnix}:R>`
    ).catch(e => log.warn('mathBoss: send turn failed', e));

    armTimer(session);
}

async function onTurnTimeout(threadId) {
    const session = sessions.get(threadId);
    if (!session || session.ended) return;
    session.timer = null;
    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (!thread) { sessions.delete(threadId); return; }
    await resolveTurn(session, thread, { timedOut: true });
}

// Apply the boss retaliation + wipe rules, post HP, then start the next turn or
// end the raid. Called when a turn completes (all solved) or times out.
async function resolveTurn(session, thread, { timedOut }) {
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    const c = cfgFor(session.tier);

    if (timedOut) {
        const unsolved = session.equations.filter(eq => !eq.solved).map(eq => `${eq.text} = ${eq.answer}`);
        if (unsolved.length) {
            await thread.send(`⏰ Hết giờ! Chưa giải: ${unsolved.join(' · ')}`).catch(() => {});
        }
    }

    // Track consecutive fully-failed turns (zero equations solved).
    if (session.solvedThisTurn === 0) session.consecutiveFails++;
    else session.consecutiveFails = 0;

    // Big-boss wipe rule.
    if (c.MOVESET === 'wipe' && session.consecutiveFails >= c.WIPE_AFTER_FAILS) {
        for (const p of session.players.values()) p.hp = 0;
        await thread.send(`💥 **${TIERS[session.tier].label} nổi giận!** Sau ${session.consecutiveFails} lượt thất bại, cả đội bị quét sạch.`).catch(() => {});
        return endRaid(session, thread, { victory: false });
    }

    // Boss only retaliates on an imperfect turn. Solve every equation in the turn
    // and the boss takes its damage but does NOT counterattack — so flawless play
    // can win without losing HP, while misses still hurt.
    const allSolved = session.solvedThisTurn >= session.equations.length;
    const living = livingPlayers(session);
    if (allSolved) {
        await thread.send(`🛡️ Cả đội giải đúng **hết** — boss không kịp phản đòn!`).catch(() => {});
    } else if (living.length > 0) {
        let attackLine;
        if (c.MOVESET === 'aoe' && Math.random() < c.AOE_CHANCE) {
            for (const p of living) p.hp -= c.BOSS_ATK;
            attackLine = `💢 Boss tung đòn **diện rộng** (-${c.BOSS_ATK} ❤️ cho cả đội)!`;
        } else {
            const target = living[Math.floor(Math.random() * living.length)];
            target.hp -= c.BOSS_ATK;
            const tid = [...session.players.entries()].find(([, p]) => p === target)[0];
            attackLine = `💢 Boss tấn công <@${tid}> (-${c.BOSS_ATK} ❤️).`;
        }
        await thread.send({ content: attackLine, allowedMentions: { parse: [] } }).catch(() => {});
    }

    await thread.send({ content: hpBar(session), allowedMentions: { parse: [] } }).catch(() => {});

    if (livingPlayers(session).length === 0) {
        return endRaid(session, thread, { victory: false });
    }
    await startTurn(session, thread);
}

async function endRaid(session, thread, { victory }) {
    if (session.ended) return;
    session.ended = true;
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    sessions.delete(session.threadId);

    const lines = [];
    let totalAwarded = 0;
    if (victory) {
        lines.push(`🎉 **Hạ gục ${TIERS[session.tier].label}!**`);
        const totalDmg = [...session.players.values()].reduce((a, p) => a + p.dmg, 0);
        const pool = cfgFor(session.tier).NGOC_POOL;
        if (totalDmg > 0) {
            for (const [uid, p] of session.players) {
                if (p.dmg <= 0) continue;
                const share = Math.floor(pool * p.dmg / totalDmg);
                const got = earnNgoc(session.guildId, uid, share);
                totalAwarded += got;
                const capNote = got < share ? ' (đã đạt cap ngày)' : '';
                lines.push(`• <@${uid}> — ${p.dmg} sát thương → +**${fmt(got)}** ${renderEmote('ngoc')}${capNote}`);
            }
            saveData();
        }
    } else {
        lines.push(`☠️ **Cả đội đã bị ${TIERS[session.tier].label} đánh bại.** Không có thưởng.`);
    }

    metrics.recordMathBoss({
        guildId: session.guildId,
        tier: session.tier,
        victory,
        ngocAwarded: totalAwarded,
        userIds: [...session.players.keys()]
    });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('boss_close_init').setLabel('Đóng thread').setStyle(ButtonStyle.Secondary)
    );
    await thread.send({ content: lines.join('\n'), components: [row], allowedMentions: { parse: [] } }).catch(() => {});
}

// ── Start ────────────────────────────────────────────────────────────────────

async function startSession({ channel, invokerId, invokerName, tier }) {
    if (channel.type !== ChannelType.GuildText) throw new Error('not_text_channel');
    const c = cfgFor(tier);
    const info = TIERS[tier];

    const thread = await channel.threads.create({
        name: `${info.label} — Math Raid`,
        autoArchiveDuration: 1440,
        type: ChannelType.PublicThread,
        reason: `Math Boss (${tier}) started by ${invokerId}`
    });
    threads.set(thread.id, { hardCapTimer: null });
    armThreadHardCap(threads.get(thread.id), thread.id);

    const session = {
        guildId: thread.guildId,
        threadId: thread.id,
        tier,
        bossHp: c.BOSS_HP,
        bossMaxHp: c.BOSS_HP,
        players: new Map(),
        turn: 0,
        equations: [],
        solvedThisTurn: 0,
        consecutiveFails: 0,
        timer: null,
        ended: false
    };
    sessions.set(thread.id, session);
    ensurePlayer(session, invokerId, invokerName);

    const moveset = {
        single: 'Mỗi lượt boss đánh **1 người** ngẫu nhiên.',
        aoe: `Boss thường đánh 1 người, nhưng **${Math.round(c.AOE_CHANCE * 100)}%** mỗi lượt sẽ đánh **cả đội**.`,
        wipe: `Boss đánh 1 người mỗi lượt, và sau **${c.WIPE_AFTER_FAILS}** lượt cả đội không giải được sẽ **quét sạch cả đội**.`
    }[c.MOVESET];

    const joinRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('boss_join').setLabel('Tham gia raid').setStyle(ButtonStyle.Success)
    );
    await thread.send({
        content:
            `${info.emoji} **${info.label}** xuất hiện! HP **${c.BOSS_HP}** · ${c.EQ} phép tính/lượt · ⏱️ ${c.TIME_S}s/lượt\n` +
            `🩸 Mỗi người máu **${c.PLAYER_HP}** · 🛡️ Moveset: ${moveset}\n` +
            `✅ Giải **đúng hết** phép tính trong lượt → boss **không phản đòn** lượt đó (chỉ trượt mới ăn đòn).\n` +
            `🏆 Hạ boss → chia **${fmt(c.NGOC_POOL)}** ${renderEmote('ngoc')} theo sát thương (cap ${fmt(economy.MATHBOSS.NGOC_DAILY_CAP)}/ngày/người).\n` +
            `Gõ đáp án để đánh. Người mới có thể **vào giữa trận** (bấm nút) — máu bằng người cao nhất đang sống.`,
        components: [joinRow],
        allowedMentions: { parse: [] }
    }).catch(e => log.warn('mathBoss: send intro failed', e));

    await startTurn(session, thread);
    return thread;
}

// ── Thread closing ─────────────────────────────────────────────────────────

async function closeThread(threadId, { reason }) {
    const threadInfo = threads.get(threadId);
    if (threadInfo) {
        if (threadInfo.hardCapTimer) clearTimeout(threadInfo.hardCapTimer);
        threads.delete(threadId);
    }
    const session = sessions.get(threadId);
    if (session && !session.ended) {
        session.ended = true;
        if (session.timer) clearTimeout(session.timer);
    }
    sessions.delete(threadId);

    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (thread) {
        const m = reason === 'hard_cap'
            ? '⏰ Thread không hoạt động quá 24 giờ. Đóng thread.'
            : '🔒 Thread đã được đóng.';
        await thread.send(m).catch(() => {});
        await thread.setLocked(true).catch(() => {});
        await thread.setArchived(true).catch(() => {});
    }
}

// ── Button handling ────────────────────────────────────────────────────────

async function handleButtonInteraction(interaction) {
    if (!interaction.isButton()) return false;
    if (!interaction.customId.startsWith('boss_')) return false;

    const id = interaction.customId;
    const threadId = interaction.channel.id;

    if (id === 'boss_join') {
        const session = sessions.get(threadId);
        if (!session || session.ended) {
            await interaction.reply({ content: 'Raid này đã kết thúc.', flags: MessageFlags.Ephemeral }).catch(() => {});
            return true;
        }
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const existing = session.players.get(interaction.user.id);
        const p = ensurePlayer(session, interaction.user.id, member ? member.displayName : interaction.user.username);
        if (existing) {
            await interaction.reply({ content: 'Bạn đã ở trong raid rồi.', flags: MessageFlags.Ephemeral }).catch(() => {});
        } else {
            await interaction.reply({ content: `⚔️ <@${interaction.user.id}> tham gia raid với **${p.hp}** máu!`, allowedMentions: { parse: [] } }).catch(() => {});
        }
        return true;
    }

    if (id === 'boss_close_init') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`boss_close_ok_${interaction.user.id}`).setLabel('OK').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`boss_close_cancel_${interaction.user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        );
        await interaction.reply({ content: `<@${interaction.user.id}> xác nhận đóng thread?`, components: [row], allowedMentions: { parse: [] } }).catch(() => {});
        return true;
    }

    if (id.startsWith('boss_close_ok_') || id.startsWith('boss_close_cancel_')) {
        const parts = id.split('_');
        const action = parts[2];
        const typerId = parts.slice(3).join('_');
        if (interaction.user.id !== typerId) {
            await interaction.reply({ content: 'Chỉ người gọi đóng thread mới có thể xác nhận.', flags: MessageFlags.Ephemeral }).catch(() => {});
            return true;
        }
        if (action === 'cancel') {
            await interaction.update({ content: '❎ Đã hủy đóng thread.', components: [] }).catch(() => {});
            return true;
        }
        await interaction.update({ content: '✅ Đang đóng thread...', components: [] }).catch(() => {});
        await closeThread(threadId, { reason: 'manual' });
        return true;
    }

    return false;
}

// ── Message handling ───────────────────────────────────────────────────────

async function handleThreadMessage(msg) {
    const threadId = msg.channel.id;
    const prev = _msgLocks.get(threadId) || Promise.resolve();
    const current = prev.then(() => _handleThreadMessageImpl(msg))
        .catch(e => log.warn('mathBoss: handleThreadMessage error', e));
    _msgLocks.set(threadId, current);
    current.finally(() => {
        if (_msgLocks.get(threadId) === current) _msgLocks.delete(threadId);
    });
    return current;
}

async function _handleThreadMessageImpl(msg) {
    const threadInfo = threads.get(msg.channel.id);
    if (!threadInfo) return;
    if (msg.author.bot) return;

    armThreadHardCap(threadInfo, msg.channel.id);

    const raw = msg.content.trim();
    if (!raw) return;

    if (raw.toLowerCase() === 'close') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`boss_close_ok_${msg.author.id}`).setLabel('OK').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`boss_close_cancel_${msg.author.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        );
        await msg.reply({ content: `<@${msg.author.id}> xác nhận đóng thread?`, components: [row], allowedMentions: { parse: [] } }).catch(() => {});
        return;
    }

    const session = sessions.get(msg.channel.id);
    if (!session || session.ended) return;
    if (!/^-?\d+$/.test(raw)) return; // only numeric answers; chat is allowed

    const num = parseInt(raw, 10);

    // A KO'd player cannot act; everyone else auto-joins on their first answer.
    const existing = session.players.get(msg.author.id);
    if (existing && existing.hp <= 0) return;
    const member = existing ? null : await msg.guild.members.fetch(msg.author.id).catch(() => null);
    const player = ensurePlayer(session, msg.author.id, existing ? null : (member ? member.displayName : msg.author.username));

    // Match the number against the first still-unsolved equation of this turn.
    const eq = session.equations.find(e => !e.solved && e.answer === num);
    if (!eq) return;

    eq.solved = true;
    session.solvedThisTurn++;
    const c = cfgFor(session.tier);
    player.dmg += c.DMG_PER_EQ;
    session.bossHp -= c.DMG_PER_EQ;
    await msg.react('⚔️').catch(() => {});

    if (session.bossHp <= 0) {
        await msg.channel.send({ content: hpBar(session), allowedMentions: { parse: [] } }).catch(() => {});
        return endRaid(session, msg.channel, { victory: true });
    }

    if (session.solvedThisTurn >= session.equations.length) {
        await resolveTurn(session, msg.channel, { timedOut: false });
    }
}

module.exports = {
    hasThread,
    startSession,
    handleThreadMessage,
    handleButtonInteraction,
    checkSummon,
    consumeSummon,
    pruneDaily,
    TIERS
};
