const { data, saveData } = require('../state');
const economy = require('../config/economy');
const { todayStr, fmt, renderEmote, getWallet, bankedTotal } = require('./currency');
const metrics = require('./metrics');

// Rút quẻ (!rutque / !fortune) — one fortune draw per user per GMT+7 day.
// The draw sets a luck state that the casino games (coinflip / slot / tổng /
// mặt) read: rateMult shifts win probability, jackpotMult boosts jackpot-tier
// payouts, and two rare tiers carry a special mechanic (Đại Hung "reverse",
// Đại Cát "man decay"). The fortune itself never pays anything; no draw =
// neutral day. State lives in data.rutque[guildId][userId] =
// { date, tier, redraws, man: { pts, decayed } } and is swept by pruneDaily.
// All numbers live in economy.RUTQUE (live-tunable via the admin panel).

// Labels / flavor are display strings, deliberately NOT in economy config
// (the admin override panel only patches numeric leaves).
const TIER_META = {
    tieu_cat: {
        label: 'Tiểu Cát', emoji: '🌤️', special: null,
        flavor: 'Gió nhẹ mây lành, thuận buồm xuôi gió.'
    },
    trung_cat: {
        label: 'Trung Cát', emoji: '🌞', special: null,
        flavor: 'Cát tinh chiếu mệnh, làm gì cũng hên.'
    },
    dai_cat: {
        label: 'Đại Cát', emoji: '🌕', special: 'man_decay',
        flavor: 'Trời quang mây tạnh, vạn sự hanh thông!'
        // Mãn Chiêu Tổn is intentionally NOT announced at draw time — the
        // status view's fuzzy meter is the only warning the player gets.
    },
    tieu_hung: {
        label: 'Tiểu Hung', emoji: '🌥️', special: null,
        flavor: 'Trời hơi âm u, ra ngõ nhớ nhìn chân.'
    },
    trung_hung: {
        label: 'Trung Hung', emoji: '🌧️', special: null,
        flavor: 'Mưa dầm gió bấc, đi đứng khó khăn…',
        // The x1.5 jackpot boost is hidden — hint only, it reveals itself
        // through the 🌟 event line when it actually fires.
        hint: '🌩️ *Nhưng nghe đồn: giữa cơn mưa dầm, có kẻ nhặt được vàng — trúng lớn ngày này… lớn hơn thường lệ.*'
    },
    dai_hung: {
        label: 'Đại Hung', emoji: '🌑', special: 'reverse',
        flavor: 'Mây đen giăng lối, sao dữ chiếu mệnh…',
        // Fuzzy hint at the reverse mechanic — no numbers.
        hint: '🌌 *Người xưa có câu: cùng tắc biến, biến tắc thông. Vận rủi tận cùng… biết đâu là lúc **nghịch thiên cải mệnh**.*'
    }
};

const NEUTRAL_MODS = Object.freeze({
    active: false, tier: null, rateMult: 1, jackpotMult: 1, special: null, decayed: false
});

// ── State accessors ─────────────────────────────────────────────────────────

// Today's entry, or null if the user hasn't drawn (yet) today.
function getEntry(guildId, userId) {
    const g = data.rutque && data.rutque[guildId];
    const e = g && g[userId];
    if (!e || e.date !== todayStr()) return null;
    if (!e.man) e.man = { pts: 0, decayed: false };
    return e;
}

function rollTier() {
    const tiers = economy.RUTQUE.TIERS || {};
    const keys = Object.keys(TIER_META).filter(k => tiers[k]);
    const total = keys.reduce((s, k) => s + (tiers[k].WEIGHT || 0), 0);
    let r = Math.random() * total;
    for (const k of keys) {
        r -= (tiers[k].WEIGHT || 0);
        if (r < 0) return k;
    }
    return keys[keys.length - 1];
}

function draw(guildId, userId) {
    const existing = getEntry(guildId, userId);
    if (existing) return { already: true, entry: existing };
    data.rutque = data.rutque || {};
    data.rutque[guildId] = data.rutque[guildId] || {};
    const entry = { date: todayStr(), tier: rollTier(), redraws: 0, man: { pts: 0, decayed: false } };
    data.rutque[guildId][userId] = entry;
    saveData();
    return { ok: true, tier: entry.tier, entry };
}

// Pure re-roll — can land on the same or a worse tier. The caller checks
// funds and spends BEFORE calling. Escalating price via redraws counter.
// entry.man is deliberately NOT reset: Mãn Chiêu Tổn points/decay are
// per-DAY, so re-rolling back into Đại Cát never refreshes a spent buff.
function redraw(guildId, userId) {
    const entry = getEntry(guildId, userId);
    if (!entry) return { error: 'not_drawn' };
    entry.tier = rollTier();
    entry.redraws = (entry.redraws || 0) + 1;
    saveData();
    return { ok: true, tier: entry.tier, entry };
}

// max(base, 1% of total ngọc) × 2^(redraws today) — wealth-scaled so whales
// can't fish for Đại Cát with pocket change. Total INCLUDES the bank két
// (like !topngoc), so parking ngọc there before a redraw doesn't dodge it.
function getRedrawPrice(guildId, userId) {
    const R = economy.RUTQUE;
    const entry = getEntry(guildId, userId);
    const n = entry ? (entry.redraws || 0) : 0;
    const w = getWallet(guildId, userId);
    const totalNgoc = w.ngoc + (w.lockedNgoc || 0) + bankedTotal(w);
    const base = Math.max(R.REDRAW_BASE_COST, Math.floor(totalNgoc * R.REDRAW_WEALTH_PCT));
    return Math.round(base * Math.pow(R.REDRAW_COST_MULT, n));
}

// Superadmin test helper — force a tier for today (resets decay state).
function setTier(guildId, userId, tier) {
    if (!TIER_META[tier]) return { error: 'bad_tier' };
    data.rutque = data.rutque || {};
    data.rutque[guildId] = data.rutque[guildId] || {};
    const prev = getEntry(guildId, userId);
    const entry = { date: todayStr(), tier, redraws: prev ? (prev.redraws || 0) : 0, man: { pts: 0, decayed: false } };
    data.rutque[guildId][userId] = entry;
    saveData();
    return { ok: true, entry };
}

// ── Game-facing reads ────────────────────────────────────────────────────────

// The one call games make at roll time. Neutral when not drawn today.
// A decayed Đại Cát becomes a hidden mild debuff (DECAY_RATE_MULT) — never
// announced, never shown. jackpotMult stays at the tier value even when
// decayed: the per-jackpot luck roll (manJackpotLuck) decides how often the
// boost actually lands, so the player keeps seeing occasional x1.35 hits.
function getModifiers(guildId, userId) {
    const entry = getEntry(guildId, userId);
    if (!entry) return NEUTRAL_MODS;
    const R = economy.RUTQUE;
    const t = (R.TIERS || {})[entry.tier];
    if (!t) return NEUTRAL_MODS;
    if (entry.tier === 'dai_cat' && entry.man.decayed) {
        return { active: true, tier: entry.tier, rateMult: R.DECAY_RATE_MULT, jackpotMult: t.JACKPOT_MULT || 1, special: 'man_decay', decayed: true };
    }
    return {
        active: true,
        tier: entry.tier,
        rateMult: t.RATE_MULT || 1,
        jackpotMult: t.JACKPOT_MULT || 1,
        special: TIER_META[entry.tier].special,
        decayed: false
    };
}

// P(a Đại Cát jackpot still gets the full boost). 1 below MAN_THRESHOLD,
// fading linearly to MAN_JACKPOT_LUCKY_MIN at MAN_JACKPOT_FADE_END, pinned
// at the minimum once decay has fired. Non-Đại-Cát entries always return 1.
// The gradual fade (instead of a hard cutoff) is what denies the player a
// "jackpots stopped boosting — luck is dead, stop now" indicator.
function manJackpotLuck(entry) {
    if (!entry || entry.tier !== 'dai_cat') return 1;
    const R = economy.RUTQUE;
    const min = R.MAN_JACKPOT_LUCKY_MIN;
    if (entry.man.decayed) return min;
    const pts = entry.man.pts || 0;
    if (pts <= R.MAN_THRESHOLD) return 1;
    if (pts >= R.MAN_JACKPOT_FADE_END) return min;
    const t = (pts - R.MAN_THRESHOLD) / (R.MAN_JACKPOT_FADE_END - R.MAN_THRESHOLD);
    return 1 - t * (1 - min);
}

function pointsForNet(net) {
    const R = economy.RUTQUE;
    if (net > R.MAN_BIG_NET) return R.MAN_BIG_PTS;
    if (net > R.MAN_MID_NET) return R.MAN_MID_PTS;
    if (net > R.MAN_SMALL_NET) return R.MAN_SMALL_PTS;
    if (net > 0) return R.MAN_TINY_PTS;
    return 0;
}

// The one call games make per win event, AFTER computing their base payout:
// applies the jackpot boost (on the jackpot-tier portion), then the Đại Hung
// reverse roll on the boosted payout, then scores Đại Cát decay points on the
// final net. Returns the adjusted payout plus ready-to-append display lines.
// `stake` gates reverse eligibility (payout must be a genuine double-up, see
// REVERSE_MIN_PAYOUT_RATIO) and feeds the decay net; no-op when not drawn.
function applyWinPayout(guildId, userId, { payout, stake = 0, jackpotPortion = 0, game } = {}) {
    const mods = getModifiers(guildId, userId);
    if (!mods.active || !(payout > 0)) return { payout, events: [], eventLines: [] };
    const R = economy.RUTQUE;
    const events = [];
    const entry = getEntry(guildId, userId);

    // manJackpotLuck is 1 outside Đại Cát, so the roll only ever bites there.
    if (jackpotPortion > 0 && mods.jackpotMult > 1 && Math.random() < manJackpotLuck(entry)) {
        const extra = Math.round(jackpotPortion * (mods.jackpotMult - 1));
        if (extra > 0) {
            payout += extra;
            events.push({ type: 'jackpot', extra, jackpotMult: mods.jackpotMult, tier: mods.tier });
            metrics.recordRutqueEffect({ guildId, type: 'jackpot', amount: extra, userId });
        }
    }

    if (mods.special === 'reverse'
        && payout >= (R.REVERSE_MIN_PAYOUT_RATIO || 2) * stake
        && Math.random() < (R.REVERSE_PROC || 0)) {
        const bonus = Math.round(payout * ((R.REVERSE_MULT || 1) - 1));
        if (bonus > 0) {
            payout += bonus;
            events.push({ type: 'reverse', bonus });
            metrics.recordRutqueEffect({ guildId, type: 'reverse', amount: bonus, userId });
        }
    }

    if (mods.special === 'man_decay' && !mods.decayed) {
        const pts = pointsForNet(payout - stake);
        if (entry && pts > 0) {
            entry.man.pts += pts;
            if (entry.man.pts > R.MAN_THRESHOLD) {
                const hazard = Math.min(1, (entry.man.pts - R.MAN_THRESHOLD) * (R.MAN_STEP_PER_POINT || 0));
                if (Math.random() < hazard) {
                    // Silent by design — no event line, no card change. The
                    // only signal is jackpot boosts thinning out, which the
                    // fade already made ambiguous.
                    entry.man.decayed = true;
                    metrics.recordRutqueEffect({ guildId, type: 'decay', userId });
                }
            }
            saveData();
        }
    }

    return { payout, events, eventLines: formatEvents(events) };
}

// ── Probability helpers shared by the games ─────────────────────────────────

// Exact-normalized weight scaling for weighted pools (slot): winner weights
// scale by rateMult, all other weights by s = (T − rW)/(T − W), so P(win)
// becomes exactly rateMult × base while the mix INSIDE winners (jackpot share)
// and inside losers is preserved. Naive winner-only scaling under-delivers
// (r=1.3 on the slot pool → effective ~1.25). No-op when the target is
// unreachable (rW ≥ T).
function scaleWinWeights(entries, isWin, rateMult) {
    if (!rateMult || rateMult === 1) return entries;
    const T = entries.reduce((s, e) => s + (e.weight || 0), 0);
    const W = entries.reduce((s, e) => s + (isWin(e) ? (e.weight || 0) : 0), 0);
    if (W <= 0 || W >= T || rateMult * W >= T) return entries;
    const s = (T - rateMult * W) / (T - W);
    return entries.map(e => ({ ...e, weight: (e.weight || 0) * (isWin(e) ? rateMult : s) }));
}

// Hidden single-reroll probability for the dice games, where the outcome is a
// deterministic function of one honest roll. Rerolling a loss (boost) or a win
// (nerf) with the exact q below yields P' = rateMult × P0. A fixed q = |r−1|
// would self-attenuate at high P0 (Đại Hung mặt would land at 0.83 instead of
// 0.70 — enough to flip the tier +EV with reverse). q clamps to 1 when the
// target is out of reach of a single reroll.
function rerollPlan(P0, rateMult) {
    if (!(P0 > 0) || P0 >= 1 || !rateMult || rateMult === 1) return { direction: null, q: 0 };
    if (rateMult > 1) return { direction: 'boost', q: Math.min(1, (rateMult - 1) / (1 - P0)) };
    return { direction: 'nerf', q: Math.min(1, (1 - rateMult) / (1 - P0)) };
}

// ── Display ──────────────────────────────────────────────────────────────────

function formatEvents(events) {
    const R = economy.RUTQUE;
    const ngoc = renderEmote('ngoc');
    return events.map(ev => {
        if (ev.type === 'reverse') {
            return `⚡ **NGHỊCH THIÊN CẢI MỆNH!** Vận rủi đảo chiều — ×${R.REVERSE_MULT}! (+${fmt(ev.bonus)} ${ngoc})`;
        }
        if (ev.type === 'jackpot') {
            return `🌟 Quẻ ${TIER_META[ev.tier].label} ứng nghiệm — jackpot ×${ev.jackpotMult}! (+${fmt(ev.extra)} ${ngoc})`;
        }
        return '';
    }).filter(Boolean);
}

// Fuzzy Đại Cát meter — bands only, never numbers: the decay proc is a hidden
// dice roll, so an exact percentage would read as the bot cheating. Past the
// threshold and after decay it reads IDENTICALLY ("đang mờ dần") so the
// player can never pinpoint when the luck actually died.
function fuzzyMeter(entry) {
    const R = economy.RUTQUE;
    const ratio = ((entry.man && entry.man.pts) || 0) / (R.MAN_THRESHOLD || 1);
    if ((entry.man && entry.man.decayed) || ratio > 0.75) return '✨ Vận khí: đang mờ dần.';
    if (ratio > 0.5) return '✨✨ Vận khí: lay động.';
    if (ratio > 0.25) return '✨✨✨ Vận khí: dồi dào.';
    return '✨✨✨✨ Vận khí: sung mãn.';
}

// Note: no decayed special-case — a spent Đại Cát still shows the full buff
// line. That deception is intentional (see manJackpotLuck).
function effectLine(entry) {
    const t = (economy.RUTQUE.TIERS || {})[entry.tier] || {};
    const pctShift = Math.round(((t.RATE_MULT || 1) - 1) * 100);
    if (entry.tier === 'dai_cat') {
        return `🌟 Tỉ lệ thắng +${pctShift}% · Jackpot ×${t.JACKPOT_MULT} hôm nay!`;
    }
    if (pctShift >= 0) return `✨ Tỉ lệ thắng +${pctShift}% hôm nay.`;
    return `🕯️ Tỉ lệ thắng −${Math.abs(pctShift)}% hôm nay.`;
}

// The tier card shown on draw / status / redraw. guildId/userId are needed
// for the wealth-scaled next-redraw price in the footer.
function formatCard({ displayName, guildId, userId, entry, isStatus = false, redrawPaid = 0 }) {
    const meta = TIER_META[entry.tier];
    const lines = [];
    lines.push(isStatus
        ? `🎴 Quẻ hôm nay của **${displayName}**`
        : `🎴 **${displayName}** rút quẻ hôm nay…`);
    lines.push(`# ${meta.emoji} ${meta.label.toUpperCase()}`);
    lines.push(`*${meta.flavor}*`);
    lines.push(effectLine(entry));
    if (meta.hint) lines.push(meta.hint);
    if (entry.tier === 'dai_cat' && isStatus) {
        lines.push(fuzzyMeter(entry));
    }
    const footer = [];
    if (redrawPaid > 0) footer.push(`Đã đổi quẻ (−${fmt(redrawPaid)} ngọc) — quẻ mới thay quẻ cũ hoàn toàn.`);
    footer.push(`Ứng với coinflip · slot · tổng · mặt, hết hiệu lực lúc 0:00. \`!rutque lai\` đổi quẻ (${fmt(getRedrawPrice(guildId, userId))} ngọc).`);
    lines.push(`-# ${footer.join(' ')}`);
    return lines.join('\n');
}

function pruneDaily(today) {
    today = today || todayStr();
    let removed = 0;
    const f = data.rutque || {};
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
    TIER_META,
    getEntry,
    draw,
    redraw,
    setTier,
    getRedrawPrice,
    getModifiers,
    manJackpotLuck,
    applyWinPayout,
    scaleWinWeights,
    rerollPlan,
    formatEvents,
    formatCard,
    fuzzyMeter,
    pruneDaily
};
