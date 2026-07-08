const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { data, saveData } = require('../state');
const economy = require('../config/economy');
const { todayStr, addNgoc, addItem, getWallet, renderEmote, fmt } = require('./currency');
const { khodoButton } = require('./uiButtons');

// Câu cá (!cauca / !fishing) — daily faucet with pre-rendered GIF endings.
// The GIFs live in assets/fishing/gif/ (gitignored while the art is under
// review — regenerate with scripts/gen_fishing_gifs.py, ship alongside code).
// Odds/rewards are economy.FISHING (live-tunable); daily count is stored in
// data.fishing[guildId][userId] = { date, count } and swept by pruneDaily.

const GIF_DIR = path.resolve(__dirname, '..', '..', 'assets', 'fishing', 'gif');

// Flavor text per ending, posted after the GIF reveals it.
const OUTCOME_TEXT = {
    small:    { emoji: '🐟', label: 'Cá nhỏ', line: 'Một chú cá nhỏ cắn câu!' },
    tuna:     { emoji: '🐟', label: 'Cá ngừ', line: 'Cá ngừ to đùng, kéo mỏi cả tay!' },
    catfish:  { emoji: '😾', label: 'Cá trê', line: 'Cá trê quái quỷ quẫy tung làm hỏng đồ câu của bạn!' },
    puffle:   { emoji: '🐡', label: 'Cá nóc', line: 'Cá nóc phồng gai đâm rách lưới của bạn!' },
    treasure: { emoji: '💰', label: 'Rương báu', line: 'Bạn kéo lên cả một RƯƠNG BÁU VẬT dưới đáy hồ!' },
    kelp:     { emoji: '🌿', label: 'Rong biển', line: 'Chỉ là một nhúm rong biển… ướt nhẹp.' },
    nothing:  { emoji: '🌙', label: 'Không có gì', line: 'Bạn câu cá đến khuya nhưng chẳng câu được gì.' }
};

function gifPath(outcome) {
    return path.join(GIF_DIR, `${outcome}.gif`);
}

function getEntry(guildId, userId) {
    data.fishing = data.fishing || {};
    data.fishing[guildId] = data.fishing[guildId] || {};
    const today = todayStr();
    const e = data.fishing[guildId][userId];
    if (!e || e.date !== today) {
        data.fishing[guildId][userId] = { date: today, count: 0 };
    }
    return data.fishing[guildId][userId];
}

// Consume one cast. Returns { ok, remaining, limit }.
function tryUseCast(guildId, userId) {
    const limit = economy.FISHING.DAILY_LIMIT;
    const e = getEntry(guildId, userId);
    if (e.count >= limit) return { ok: false, remaining: 0, limit };
    e.count += 1;
    saveData();
    return { ok: true, remaining: limit - e.count, limit };
}

function rollOutcome() {
    const outcomes = economy.FISHING.OUTCOMES;
    const keys = Object.keys(outcomes);
    const total = keys.reduce((s, k) => s + (outcomes[k].weight || 0), 0);
    let r = Math.random() * total;
    for (const k of keys) {
        r -= (outcomes[k].weight || 0);
        if (r < 0) return k;
    }
    return keys[keys.length - 1];
}

// Apply the ending's reward. Negative ngọc is deducted straight from the free
// wallet and MAY push it below 0 — that debt is the price of the catfish.
// Returns { ngocDelta, thienthuong }.
function settle(guildId, userId, outcome) {
    const o = economy.FISHING.OUTCOMES[outcome] || {};
    const ngocDelta = o.ngoc || 0;
    const tt = o.thienthuong || 0;
    if (ngocDelta !== 0) addNgoc(guildId, userId, ngocDelta);
    if (tt > 0) addItem(guildId, userId, 'thienthuong', tt);
    return { ngocDelta, thienthuong: tt };
}

// 🎣 Câu tiếp button + 📦 Kho đồ, appended to the settle reply so the player
// can recast without retyping !cauca. The button disables at 0 lượt.
function buildFishingRow(userId, remaining, limit) {
    const canCast = remaining > 0;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`cauca:again:${userId}`)
            .setLabel(canCast ? `🎣 Câu tiếp (còn ${remaining}/${limit})` : 'Hết lượt hôm nay')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!canCast),
        khodoButton()
    );
}

// One end-to-end cast: consume a daily use, play the GIF, wait for the reveal,
// settle the reward and post the result (with the 🎣/📦 buttons) as a reply to
// the GIF message. Shared by the !cauca command and the 🎣 Câu tiếp button.
// `send` posts the GIF message (msg.reply / interaction.followUp) and returns
// it; `metrics`/`season` are injected so this module stays dependency-light.
// Returns { ok:false, reason:'limit', limit } when the daily cap is hit.
async function runFishingCast({ guildId, userId, displayName, send, metrics, season }) {
    const cast = tryUseCast(guildId, userId);
    if (!cast.ok) return { ok: false, reason: 'limit', limit: cast.limit };
    const outcome = rollOutcome();
    // Same neutral filename for every ending so the attachment name doesn't
    // spoil the result before the GIF gets there.
    const gifMsg = await send({
        content: `🎣 **${displayName}** quăng cần câu... (hôm nay còn **${cast.remaining}/${cast.limit}** lượt)`,
        files: [new AttachmentBuilder(gifPath(outcome), { name: 'cauca.gif' })]
    });
    await new Promise(r => setTimeout(r, economy.FISHING.REVEAL_DELAY_MS));
    const res = settle(guildId, userId, outcome);
    if (res.thienthuong > 0 && season) season.bumpScoreTime(guildId, userId);
    if (metrics && metrics.recordFishing) {
        metrics.recordFishing({ guildId, outcome, ngocDelta: res.ngocDelta, ttDelta: res.thienthuong, userId });
    }
    const t = OUTCOME_TEXT[outcome];
    const rewards = [];
    if (res.ngocDelta > 0) rewards.push(`+${fmt(res.ngocDelta)} ${renderEmote('ngoc')}`);
    if (res.ngocDelta < 0) rewards.push(`**−${fmt(-res.ngocDelta)}** ${renderEmote('ngoc')}`);
    if (res.thienthuong > 0) rewards.push(`+${fmt(res.thienthuong)} ${renderEmote('thienthuong')} Thiên Thưởng`);
    const w = getWallet(guildId, userId);
    await gifMsg.reply({
        content: `${t.emoji} **${t.label}!** ${t.line}\n` +
            `${rewards.length ? rewards.join(' · ') : 'Không nhận được gì.'} — số dư: ${fmt(w.ngoc + w.lockedNgoc)} ${renderEmote('ngoc')}`,
        components: [buildFishingRow(userId, cast.remaining, cast.limit)]
    });
    return { ok: true, outcome };
}

function pruneDaily(today) {
    today = today || todayStr();
    let removed = 0;
    const f = data.fishing || {};
    for (const guildId of Object.keys(f)) {
        const g = f[guildId];
        for (const uid of Object.keys(g)) {
            if (!g[uid] || g[uid].date !== today) { delete g[uid]; removed++; }
        }
        if (Object.keys(g).length === 0) delete f[guildId];
    }
    if (removed) saveData();
    return removed;
}

module.exports = {
    OUTCOME_TEXT,
    gifPath,
    tryUseCast,
    rollOutcome,
    settle,
    buildFishingRow,
    runFishingCast,
    pruneDaily
};
