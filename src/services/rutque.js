const { data, saveData } = require('../state');
const economy = require('../config/economy');
const { todayStr, fmt, renderEmote, getWallet, addNgoc, spendNgocForGame, bankedTotal } = require('./currency');
const metrics = require('./metrics');

// ── Quẻ Bói ("rút quẻ") — fortune-draw meta-layer over the casino games ──────
//
// A parallel scoring layer ("điểm phúc") on top of coinflip / mặt / tổng /
// slot. Core invariant: the quẻ NEVER modifies any game's odds or payouts —
// games run 100% unchanged. After each game round settles, the game calls
// `onGameResult(...)`; the quẻ scores that round (only if the bet ≥ the tier's
// per-game minimum) and settles in ngọc at the quẻ's natural end (or on break /
// bank). All rewards/penalties are FLAT per tier (anti-whale), scaled by the
// tier multiplier. Cát meters are SIGNED: wins add points, losses subtract,
// and a meter that ends negative CHARGES the player at settlement on the same
// convex curve (see ngocValue). Quẻ lifetime is counted in QUALIFYING ROUNDS,
// with a 7-day auto-settle safety valve.
//
// State: data.queboi[guildId][userId] = { que, draws }
//   que   = null | { type, tier, rounds_left, points, stacks, win_streak,
//                    consec_losses, tokens, wins, losses, last_round, created_at }
//   draws = { date, total, thien }
//
// All numbers live in economy.QUE_BOI (live-tunable via the admin panel).
// Processing is synchronous end-to-end, so the single-threaded event loop
// guarantees two near-simultaneous bets settle sequentially against quẻ state
// (the per-user lock the spec asks for).

const QUE_TYPES = ['TIEU_CAT', 'TRUNG_CAT', 'DAI_CAT', 'TIEU_HUNG', 'TRUNG_HUNG', 'DAI_HUNG'];

// Display meta (Vietnamese). Kept out of economy config (numeric leaves only).
const QUE_META = {
    TIEU_CAT:   { name: 'Chuyển', emoji: '🟢', kind: 'cat', flavor: 'Gió lành thổi tới, mỗi bước một chuyển.' },
    TRUNG_CAT:  { name: 'Phúc',   emoji: '🟢', kind: 'cat', flavor: 'Phúc tinh chiếu mệnh — biết đủ là hơn.' },
    DAI_CAT:    { name: 'Liên',   emoji: '🟢', kind: 'cat', flavor: 'Liên hoàn cát khánh — thắng nối thắng.' },
    TIEU_HUNG:  { name: 'Kiệt',   emoji: '🔴', kind: 'hung', flavor: 'Sức tàn lực kiệt — giữ mình cho vững.' },
    TRUNG_HUNG: { name: 'Nghịch', emoji: '🔴', kind: 'hung', flavor: 'Nghịch cảnh vây quanh — thắng liền mới thoát.' },
    DAI_HUNG:   { name: 'Kiếp',   emoji: '🔴', kind: 'hung', flavor: 'Kiếp nạn giáng đầu — hoạ trung hữu phúc.' }
};

// Tier: stored 1..5. Accept both diacritic and ascii keys.
const TIER_KEYS = ['pham', 'linh', 'huyen', 'dia', 'thien'];
const TIER_NAMES = ['Phàm', 'Linh', 'Huyền', 'Địa', 'Thiên'];
const TIER_ALIASES = {
    pham: 1, 'phàm': 1, '1': 1,
    linh: 2, '2': 2,
    huyen: 3, 'huyền': 3, '3': 3,
    dia: 4, 'địa': 4, 'đia': 4, '4': 4,
    thien: 5, 'thiên': 5, '5': 5
};

const GAMES = ['coinflip', 'mat', 'tong', 'slot'];

// ── Small helpers ────────────────────────────────────────────────────────────

const Q = () => economy.QUE_BOI;
function tierMult(tier) { return Q().TIER_MULT[tier - 1] || 1; }
function tierName(tier) { return TIER_NAMES[tier - 1] || `Bậc ${tier}`; }
function minBetFor(tier, game) {
    const g = Q().MIN_BET[game];
    return g ? (g[tier - 1] || 0) : 0;
}
function pointsPerWin(game) { return Q().POINTS_PER_WIN[game] || 1; }
function ngocEmote() { return renderEmote('ngoc'); }
// Convex payout curve, SIGNED: ±cap × (|p|/cap)^EXP × VALUE × mult. A full
// positive meter pays the same ceiling as the old linear formula; partial
// banks pay progressively less (EXP 2 ⇒ half the points ≈ a quarter of the
// ngọc). Negative meters charge the player on the same curve at settlement.
// EXP is live-tunable (1 restores linear).
function ngocValue(points, tier) {
    const cap = Q().POINT_CAP;
    const p = Math.max(-cap, Math.min(points, cap));
    const exp = Q().POINT_CURVE_EXP || 1;
    const v = Math.round(cap * Math.pow(Math.abs(p) / cap, exp) * Q().POINT_VALUE) * tierMult(tier);
    return p < 0 ? -v : v;
}

// Cheapest bet that makes a round COUNT at this tier (the smallest per-game
// min across all four games). Below this, drawing the tier is pointless — you
// could never play a qualifying round.
function minPossibleBet(tier) {
    const bets = GAMES.map(g => minBetFor(tier, g)).filter(v => v > 0);
    return bets.length ? Math.min(...bets) : 0;
}

// Worst-case single-settlement CHARGE at this tier — the largest amount a bad
// draw could take: a full negative cát meter, or a fully-stacked Nghịch/Kiếp.
// Used to warn a player whose whole balance is smaller than this.
function tierRisk(tier) {
    const cap = Q().POINT_CAP;
    const negMeter = Math.abs(ngocValue(-cap, tier));
    const kiep = Q().KIEP_PENALTY_PER_STACK * (Q().LIFETIME.DAI_HUNG || 0) * tierMult(tier);
    const nghich = Q().NGHICH_PENALTY_PER_STACK * (Q().LIFETIME.TRUNG_HUNG || 0) * tierMult(tier);
    return Math.max(negMeter, kiep, nghich);
}

// Total wealth counted for the draw gates: ví + locked + két (same scope as
// !topngoc). Két can't be bet directly, but it's the player's real net worth
// and settlement penalties can wipe it out via withdrawals, so both gates use it.
function totalWealth(guildId, userId) {
    const w = getWallet(guildId, userId);
    return (w.ngoc || 0) + (w.lockedNgoc || 0) + bankedTotal(w);
}

// Tiers the player can afford to play a qualifying round at (wealth ≥ min bet).
function affordableTiers(wealth) {
    const out = [];
    for (let t = 1; t <= 5; t++) {
        const mb = minPossibleBet(t);
        if (wealth >= mb) out.push({ tier: t, key: TIER_KEYS[t - 1], name: TIER_NAMES[t - 1], minBet: mb });
    }
    return out;
}

// ── "Tempt & scare" helpers ──────────────────────────────────────────────────
// The full-meter payout ("glory") a point/pool meter can reach at this tier.
function fullGlory(tier) { return ngocValue(Q().POINT_CAP, tier); }

// Best-case points the meter can STILL reach given rounds left, modelling each
// quẻ's growth: additive quẻ (Chuyển/Phúc/Kiệt) gain ppw per win; Liên (Đại Cát)
// doubles. This makes the dangled glory REALISTIC — you can't hit 20đ with only
// 1 round left, so a Phúc at 3đ with 1 mặt-round left shows 5đ, not 20đ.
function maxReachablePoints(q, ppw) {
    const cap = Q().POINT_CAP;
    const k = Math.max(0, q.rounds_left);
    if (q.type === 'DAI_CAT') {
        let p = q.points;
        for (let i = 0; i < k && p < cap; i++) p = p <= 0 ? ppw : Math.min(cap, p * 2);
        return Math.min(cap, Math.max(p, q.points));
    }
    return Math.min(cap, q.points + ppw * k);
}

// ppw to assume for a projection outside a live round (status / draw view): the
// game last played, else the best-case game for a freshly-drawn quẻ.
function assumedPpw(q) {
    const g = q.last_round && q.last_round.game;
    return g ? pointsPerWin(g) : Math.max(...GAMES.map(gm => pointsPerWin(gm)));
}

// Compact glory tag for a cát/Kiệt meter: the realistic ceiling reachable in the
// rounds left (or a "kịch trần" flag once maxed). Empty when no upside remains.
function gloryTag(q, ppw) {
    const cap = Q().POINT_CAP;
    if (q.points >= cap) return ` · 🌟 KỊCH TRẦN ${fmt(fullGlory(q.tier))}!`;
    const reach = maxReachablePoints(q, ppw);
    if (reach <= q.points) return '';
    const label = reach >= cap ? `đủ ${cap}đ` : `tối đa ${reach}đ`;
    return ` · 🌟 ${label} = ${fmt(ngocValue(reach, q.tier))}`;
}

// Worst-case penalty a stacking hung quẻ (Nghịch/Kiếp) grows to if EVERY round
// left is also a loss (current stacks + rounds left — already realistic, not the
// full-lifetime theoretical max). Scares players into escaping now (!goque /
// breaking the streak) instead of riding it out.
function worstStackPenalty(q) {
    const key = q.type === 'DAI_HUNG' ? 'KIEP_PENALTY_PER_STACK' : 'NGHICH_PENALTY_PER_STACK';
    const maxStacks = q.stacks + Math.max(0, q.rounds_left);
    return Q()[key] * maxStacks * tierMult(q.tier);
}

function getState(guildId, userId) {
    data.queboi = data.queboi || {};
    data.queboi[guildId] = data.queboi[guildId] || {};
    if (!data.queboi[guildId][userId]) {
        data.queboi[guildId][userId] = { que: null, draws: { date: todayStr(), total: 0, thien: 0 } };
    }
    const st = data.queboi[guildId][userId];
    if (!st.draws || st.draws.date !== todayStr()) {
        st.draws = { date: todayStr(), total: 0, thien: 0 };
    }
    return st;
}

// Active quẻ (does not auto-settle — caller runs checkAutoSettle first).
function getActive(guildId, userId) {
    const st = getState(guildId, userId);
    return st.que || null;
}

function snapshot(q) {
    return {
        rounds_left: q.rounds_left, points: q.points, stacks: q.stacks,
        win_streak: q.win_streak, consec_losses: q.consec_losses,
        tokens: q.tokens, wins: q.wins, losses: q.losses
    };
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function rollQueType() {
    const w = Q().DRAW_WEIGHTS;
    const keys = QUE_TYPES.filter(k => (w[k] || 0) > 0);
    const total = keys.reduce((s, k) => s + w[k], 0);
    let r = Math.random() * total;
    for (const k of keys) { r -= w[k]; if (r < 0) return k; }
    return keys[keys.length - 1];
}

function drawAvailability(guildId, userId) {
    const st = getState(guildId, userId);
    const total = st.draws.total || 0;
    const thien = st.draws.thien || 0;
    return {
        total, thien,
        totalLeft: Math.max(0, Q().DAILY_LIMIT - total),
        thienLeft: Math.max(0, Q().THIEN_DAILY_LIMIT - thien),
        active: st.que || null
    };
}

// Draw a random quẻ at the chosen tier. tierArg: key/alias/number.
function draw(guildId, userId, tierArg) {
    const st = getState(guildId, userId);
    if (st.que) return { error: 'active' };
    const tier = TIER_ALIASES[String(tierArg || '').toLowerCase()];
    if (!tier) return { error: 'bad_tier' };
    if ((st.draws.total || 0) >= Q().DAILY_LIMIT) return { error: 'daily_limit' };
    if (tier === 5 && (st.draws.thien || 0) >= Q().THIEN_DAILY_LIMIT) return { error: 'thien_limit' };

    // Balance gates. Block if the player can't even afford a qualifying round at
    // this tier; warn (but allow) if a bad draw could exceed their whole balance.
    const wealth = totalWealth(guildId, userId);
    const minBet = minPossibleBet(tier);
    if (wealth < minBet) {
        return { error: 'too_poor', tier, minBet, wealth, affordable: affordableTiers(wealth) };
    }

    const type = rollQueType();
    st.que = newQue(type, tier);
    st.draws.total = (st.draws.total || 0) + 1;
    if (tier === 5) st.draws.thien = (st.draws.thien || 0) + 1;
    saveData();
    metrics.recordRutque({ guildId, action: 'draw', tier: type, bac: TIER_KEYS[tier - 1], userId });
    const risk = tierRisk(tier);
    const warning = wealth < risk ? { risk, wealth, tier } : null;
    return { ok: true, que: st.que, warning };
}

function newQue(type, tier) {
    return {
        type, tier,
        rounds_left: Q().LIFETIME[type],
        points: 0,
        stacks: 0,
        win_streak: 0,
        consec_losses: 0,
        tokens: type === 'TIEU_CAT' ? Q().TIEU_CAT_TOKENS : 0,
        wins: 0,
        losses: 0,
        last_round: null,
        created_at: Date.now()
    };
}

// Superadmin test helper — force a quẻ type + tier (no draw-count charge).
function setQue(guildId, userId, typeArg, tierArg) {
    const type = String(typeArg || '').toUpperCase();
    if (!QUE_TYPES.includes(type)) return { error: 'bad_type' };
    const tier = TIER_ALIASES[String(tierArg || '').toLowerCase()] || 1;
    const st = getState(guildId, userId);
    st.que = newQue(type, tier);
    saveData();
    return { ok: true, que: st.que };
}

// ── Round processing ─────────────────────────────────────────────────────────

// The one call each game makes AFTER settling a round's wallet/payout. Returns
// { lines } — inline guide + any settlement/auto-settle lines to append to the
// game's result message. `won` is net-profit (payout > bet).
function onGameResult({ guildId, userId, game, bet, won }) {
    const st = getState(guildId, userId);
    const lines = [];
    const auto = checkAutoSettle(guildId, userId);
    if (auto) lines.push(...auto.lines);

    const q = st.que;
    if (!q) return { lines };

    const minBet = minBetFor(q.tier, game);
    if (bet < minBet) {
        lines.push(`⚪ Ván này không tính vào quẻ (cược dưới ngưỡng bậc ${tierName(q.tier)}: cần ≥ ${fmt(minBet)}).`);
        return { lines };
    }

    // Qualifying round.
    const before = snapshot(q);
    q.rounds_left -= 1;
    if (won) q.wins += 1; else q.losses += 1;
    const { line, settleReason } = applyRound(q, game, won, bet);
    q.last_round = { game, bet, won, before };
    if (line) lines.push(line);

    if (settleReason) {
        st.__ref = { guildId, userId };
        const res = settle(st, settleReason);
        lines.push(...res.lines);
    } else {
        saveData();
    }
    return { lines };
}

// Mutates q for one qualifying round. Returns { line, settleReason }.
// Order (spec §9): win → streak++ → apply points/double → break checks → clamp.
// loss → streak reset → loss effect.
function applyRound(q, game, won, bet) {
    const cap = Q().POINT_CAP;
    const ppw = pointsPerWin(game);
    const mult = tierMult(q.tier);
    const t = tierName(q.tier);
    const meta = QUE_META[q.type];
    let settleReason = null;
    let line = '';

    switch (q.type) {
        case 'TIEU_CAT': {
            if (won) {
                q.points = Math.min(cap, q.points + ppw);
                line = `${meta.emoji} Quẻ Chuyển [${t}]: ${q.points} điểm phúc → ${fmt(ngocValue(q.points, q.tier))} ${ngocEmote()}${gloryTag(q, ppw)} | còn ${q.rounds_left} ván | ${q.tokens} lá xoá dấu`;
            } else {
                q.points = Math.max(-cap, q.points - ppw);
                const warn = q.points < 0 ? ` ⚠️ ÂM: kết toán sẽ TRỪ ${fmt(-ngocValue(q.points, q.tier))} ${ngocEmote()}` : '';
                line = `${meta.emoji} Quẻ Chuyển [${t}]: ${q.points} điểm (−${ppw})${warn} | còn ${q.rounds_left} ván | ${q.tokens > 0 ? `Gõ \`!xoadau\` để ván này không tính (${q.tokens} lá còn lại)` : 'hết lá xoá dấu'}`;
            }
            if (q.rounds_left <= 0) settleReason = 'natural';
            break;
        }
        case 'TRUNG_CAT': {
            if (won) {
                q.points = Math.min(cap, q.points + ppw);
                q.consec_losses = 0;
                line = `${meta.emoji} Quẻ Phúc [${t}]: ${q.points} điểm → ${fmt(ngocValue(q.points, q.tier))} ${ngocEmote()}${gloryTag(q, ppw)} | còn ${q.rounds_left} ván | \`!bank\` chốt non (gồng tiếp ăn dày hơn)`;
            } else {
                q.points = Math.max(-cap, q.points - ppw);
                q.consec_losses += 1;
                if (q.consec_losses >= 2) {
                    // Double-loss slump: positive meters halve, negative dig deeper.
                    q.points = q.points > 0 ? Math.floor(q.points / 2) : Math.max(-cap, q.points - ppw);
                    q.consec_losses = 0;
                    line = `${meta.emoji} Quẻ Phúc [${t}]: 📉 Sụt mạnh! Còn ${q.points} điểm (${fmt(ngocValue(q.points, q.tier))} ${ngocEmote()}) | còn ${q.rounds_left} ván`;
                } else {
                    const warn = q.points < 0 ? `kết toán ÂM sẽ TRỪ ${fmt(-ngocValue(q.points, q.tier))} ${ngocEmote()}` : `\`!bank\` để chốt ${fmt(ngocValue(q.points, q.tier))} ${ngocEmote()} ngay`;
                    line = `${meta.emoji} Quẻ Phúc [${t}]: ${q.points} điểm (−${ppw}) | ⚠️ Thua thêm 1 ván nữa sẽ sụt mạnh! | ${warn}`;
                }
            }
            if (q.rounds_left <= 0) settleReason = 'natural';
            break;
        }
        case 'DAI_CAT': {
            if (won) {
                q.win_streak += 1;
                q.points = q.points <= 0 ? ppw : Math.min(cap, q.points * 2);
                const next = Math.min(cap, q.points * 2);
                line = `${meta.emoji} Quẻ Liên [${t}]: chuỗi ${q.win_streak} | meter ${q.points} điểm → ${fmt(ngocValue(q.points, q.tier))} ${ngocEmote()}${gloryTag(q, ppw)} | Thắng tiếp → ${next} điểm, thua → ĐẢO CHIỀU ÂM | \`!bank\` chốt non`;
            } else {
                q.win_streak = 0;
                // Mirror of the win side: losses chain too — the meter flips
                // negative and doubles with each consecutive loss.
                q.points = q.points >= 0 ? -ppw : Math.max(-cap, q.points * 2);
                line = `${meta.emoji} Quẻ Liên [${t}]: 💥 Meter đảo chiều: ${q.points} điểm (${fmt(ngocValue(q.points, q.tier))} ${ngocEmote()}) | thua tiếp → ×2 sâu hơn, thắng 1 ván → về +${ppw} | còn ${q.rounds_left} ván`;
            }
            if (q.rounds_left <= 0) settleReason = 'natural';
            break;
        }
        case 'TIEU_HUNG': {
            if (won) {
                q.points = Math.min(cap, q.points + ppw);
                line = `🔴 Quẻ Kiệt [${t}]: giữ ${q.points} điểm (~${fmt(ngocValue(q.points, q.tier))} ${ngocEmote()})${gloryTag(q)} | đã thua ${q.stacks}/${Q().TIEU_HUNG_MAX_LOSSES} cho phép | còn ${q.rounds_left} ván`;
            } else {
                q.stacks += 1;
                if (q.stacks > Q().TIEU_HUNG_MAX_LOSSES) {
                    line = `🔴 Quẻ Kiệt [${t}]: 🗳️ Mất trắng pool ${q.points} điểm (~${fmt(ngocValue(q.points, q.tier))} ${ngocEmote()}). Quẻ còn ${q.rounds_left} ván (không còn gì để mất).`;
                } else {
                    line = `🔴 Quẻ Kiệt [${t}]: giữ ${q.points} điểm (~${fmt(ngocValue(q.points, q.tier))} ${ngocEmote()})${gloryTag(q)} | ⚠️ đã thua ${q.stacks}/${Q().TIEU_HUNG_MAX_LOSSES} — thua quá là mất trắng | còn ${q.rounds_left} ván`;
                }
            }
            if (q.rounds_left <= 0) settleReason = 'natural';
            break;
        }
        case 'TRUNG_HUNG': {
            if (won) {
                q.win_streak += 1;
                if (q.win_streak >= Q().NGHICH_BREAK_STREAK) {
                    settleReason = 'nghich_break';
                    line = `🔴 Quẻ Nghịch [${t}]: ✨ Thắng ${q.win_streak} ván liền — PHÁ QUẺ! Xoá sạch stack, không phạt.`;
                } else {
                    line = `🔴 Quẻ Nghịch [${t}]: chuỗi thắng ${q.win_streak}/${Q().NGHICH_BREAK_STREAK} để phá quẻ | ${q.stacks} stack | còn ${q.rounds_left} ván`;
                }
            } else {
                q.win_streak = 0;
                q.stacks += 1;
                const penalty = Q().NGHICH_PENALTY_PER_STACK * q.stacks * mult;
                const worst = worstStackPenalty(q);
                const fee = Q().NGHICH_REMOVE_FEE * mult;
                line = `🔴 Quẻ Nghịch [${t}]: ${q.stacks} stack đen — phạt ${fmt(penalty)} ${ngocEmote()}${worst > penalty ? ` 📈 thua hết còn lại → **tối đa ${fmt(worst)}**!` : ''} | còn ${q.rounds_left} ván | Thoát: thắng ${Q().NGHICH_BREAK_STREAK} ván liền, hoặc \`!goque\` chỉ **${fmt(fee)}** (rẻ hơn nhiều)`;
            }
            if (!settleReason && q.rounds_left <= 0) settleReason = 'natural';
            break;
        }
        case 'DAI_HUNG': {
            if (won) {
                q.win_streak += 1;
                const lieu = Q().LIEU[q.tier - 1];
                const lieuHit = lieu != null && bet >= lieu;
                if (q.win_streak >= Q().KIEP_BREAK_STREAK || lieuHit) {
                    settleReason = 'kiep_break';
                    const via = (q.win_streak >= Q().KIEP_BREAK_STREAK) ? `thắng ${q.win_streak} ván liền` : `liều thắng ván cược ≥ ${fmt(lieu)}`;
                    line = `🔴 Quẻ Kiếp [${t}]: ⚡ NGHỊCH THIÊN CẢI MỆNH! ${via} — phá quẻ, lật ${Math.min(q.stacks, cap)} stack thành điểm phúc!`;
                } else {
                    const lieu2 = Q().LIEU[q.tier - 1];
                    const lieuHint = lieu2 != null ? `, hoặc thắng 1 ván cược ≥ ${fmt(lieu2)}` : '';
                    line = `🔴 Quẻ Kiếp [${t}]: chuỗi ${q.win_streak}/${Q().KIEP_BREAK_STREAK} | ${q.stacks} stack chờ lật | còn ${q.rounds_left} ván | Phá: thắng ${Q().KIEP_BREAK_STREAK} ván liền${lieuHint}`;
                }
            } else {
                q.win_streak = 0;
                q.stacks += 1;
                const penalty = Q().KIEP_PENALTY_PER_STACK * q.stacks * mult;
                const worst = worstStackPenalty(q);
                const flip = ngocValue(Math.min(q.stacks, cap), q.tier);
                const lieu = Q().LIEU[q.tier - 1];
                const lieuHint = lieu != null ? `, hoặc thắng 1 ván cược ≥ ${fmt(lieu)}` : '';
                line = `🔴 Quẻ Kiếp [${t}]: ${q.stacks} stack — phạt ${fmt(penalty)} ${ngocEmote()}${worst > penalty ? ` 📈 thua hết còn lại → **tối đa ${fmt(worst)}**!` : ''} (phá quẻ → lật thành ${fmt(flip)} ngọc) | còn ${q.rounds_left} ván | Phá: thắng ${Q().KIEP_BREAK_STREAK} ván liền${lieuHint}`;
            }
            if (!settleReason && q.rounds_left <= 0) settleReason = 'natural';
            break;
        }
    }
    return { line, settleReason };
}

// ── Settlement ───────────────────────────────────────────────────────────────

// Settle & clear the active quẻ. reason: natural | bank | nghich_break |
// nghich_goque | kiep_break | auto_settle. `opts.feeSink` folds an already-spent
// sink (the !goque fee) into the recorded burn so metrics count it once, under
// this quẻ's type. Returns { lines, paid, penalty }.
function settle(st, reason, opts = {}) {
    const feeSink = opts.feeSink || 0;
    const q = st.que;
    // Callers thread the owning guild/user through st.__ref (the quẻ object
    // itself doesn't store them — state is keyed by guildId→userId).
    const ref = st.__ref || {};
    const gId = ref.guildId;
    const uId = ref.userId;

    const meta = QUE_META[q.type];
    const t = tierName(q.tier);
    const cap = Q().POINT_CAP;
    let paid = 0, penalty = 0;
    let outcomeLine = '';

    switch (q.type) {
        case 'TIEU_CAT':
        case 'TRUNG_CAT':
        case 'DAI_CAT': {
            const v = ngocValue(q.points, q.tier);
            if (v >= 0) {
                paid = v;
                outcomeLine = paid > 0
                    ? `Nhận **${fmt(paid)}** ${ngocEmote()} (${Math.min(q.points, cap)}/${cap} điểm phúc · bậc ${t} — quy đổi luỹ tiến).`
                    : `Không có điểm phúc để nhận.`;
            } else {
                penalty = -v; // wording comes from the deduction block below
            }
            break;
        }
        case 'TIEU_HUNG': {
            if (q.stacks <= Q().TIEU_HUNG_MAX_LOSSES) {
                paid = ngocValue(q.points, q.tier);
                outcomeLine = paid > 0 ? `Giữ được pool: nhận **${fmt(paid)}** ${ngocEmote()}.` : `Không có điểm để nhận.`;
            } else {
                paid = 0;
                outcomeLine = `Thua ${q.stacks} ván (> ${Q().TIEU_HUNG_MAX_LOSSES}) — pool tạm giữ bị mất trắng. Không phạt tiền.`;
            }
            break;
        }
        case 'TRUNG_HUNG': {
            if (reason === 'nghich_break' || reason === 'nghich_goque') {
                penalty = 0;
                outcomeLine = reason === 'nghich_goque'
                    ? `Đã gỡ quẻ (phí đã trừ), stack xoá sạch — không phạt.`
                    : `Phá quẻ bằng thực lực — stack xoá sạch, không phạt.`;
            } else {
                penalty = Q().NGHICH_PENALTY_PER_STACK * q.stacks * tierMult(q.tier);
            }
            break;
        }
        case 'DAI_HUNG': {
            if (reason === 'kiep_break') {
                paid = ngocValue(q.stacks, q.tier); // stacks → điểm 1:1 (clamped)
                outcomeLine = `Hoạ trung hữu phúc — lật ${Math.min(q.stacks, cap)} stack thành **${fmt(paid)}** ${ngocEmote()}!`;
            } else {
                penalty = Q().KIEP_PENALTY_PER_STACK * q.stacks * tierMult(q.tier);
            }
            break;
        }
    }

    // Apply wallet effects (edge case §10.1: never negative — forgive remainder).
    let deducted = 0;
    if (paid > 0) addNgoc(gId, uId, paid);
    if (penalty > 0) {
        const w = getWallet(gId, uId);
        const avail = w.ngoc + (w.lockedNgoc || 0);
        deducted = Math.min(penalty, avail);
        if (deducted > 0) spendNgocForGame(gId, uId, deducted);
        const why = q.stacks > 0 ? `${q.stacks} stack` : `${Math.max(-cap, q.points)}/${cap} điểm phúc — quy đổi luỹ tiến`;
        outcomeLine = deducted < penalty
            ? `Phạt ${fmt(penalty)} ${ngocEmote()} — chỉ còn ${fmt(deducted)}, trừ hết & tha phần còn lại.`
            : `Bị phạt **${fmt(deducted)}** ${ngocEmote()} (${why}).`;
    }

    metrics.recordQueSettlement({ guildId: gId, userId: uId, paid, penalty: deducted + feeSink, type: q.type });

    const rounds = Q().LIFETIME[q.type] - q.rounds_left;
    const header = `${meta.emoji} **Kết toán quẻ ${meta.name} [${t}]** — ${reasonLabel(reason)}`;
    const stat = `Đã chơi ${rounds} ván · thắng ${q.wins}/${q.wins + q.losses}${q.stacks ? ` · ${q.stacks} stack` : ''}${q.points ? ` · ${Math.min(q.points, cap)} điểm` : ''}`;
    const lines = [header, stat, outcomeLine, `*${meta.flavor}*`];

    st.que = null;
    delete st.__ref;
    saveData();
    return { lines, paid, penalty: deducted };
}

function reasonLabel(reason) {
    switch (reason) {
        case 'bank': return 'chốt sớm';
        case 'nghich_break': return 'phá quẻ';
        case 'nghich_goque': return 'gỡ quẻ';
        case 'kiep_break': return 'nghịch thiên';
        case 'auto_settle': return 'tự kết toán sau 7 ngày';
        default: return 'hết hạn';
    }
}

// 7-day safety valve. Settles an expired quẻ; returns { lines } or null.
function checkAutoSettle(guildId, userId) {
    const st = getState(guildId, userId);
    const q = st.que;
    if (!q) return null;
    const ageMs = Date.now() - (q.created_at || Date.now());
    if (ageMs < Q().AUTO_SETTLE_DAYS * 86400000) return null;
    st.__ref = { guildId, userId };
    const res = settle(st, 'auto_settle');
    return { lines: ['⏳ Quẻ cũ đã quá 7 ngày và được tự kết toán:', ...res.lines] };
}

// ── Player commands ──────────────────────────────────────────────────────────

// !bank — settle Trung Cát / Đại Cát now.
function bank(guildId, userId) {
    const auto = checkAutoSettle(guildId, userId);
    if (auto) return { autoSettled: true, lines: auto.lines };
    const st = getState(guildId, userId);
    const q = st.que;
    if (!q) return { error: 'no_que' };
    if (q.type !== 'TRUNG_CAT' && q.type !== 'DAI_CAT') return { error: 'wrong_que' };
    st.__ref = { guildId, userId };
    const res = settle(st, 'bank');
    return { ok: true, lines: res.lines };
}

// !xoadau — Tiểu Cát: erase the most recent LOSS from the quẻ (not the money).
function xoadau(guildId, userId) {
    const auto = checkAutoSettle(guildId, userId);
    if (auto) return { autoSettled: true, lines: auto.lines };
    const st = getState(guildId, userId);
    const q = st.que;
    if (!q) return { error: 'no_que' };
    if (q.type !== 'TIEU_CAT') return { error: 'wrong_que' };
    if ((q.tokens || 0) <= 0) return { error: 'no_tokens' };
    const lr = q.last_round;
    if (!lr) return { error: 'no_round' };
    if (lr.won) return { error: 'not_a_loss' };
    // Restore the full pre-round snapshot (undoes the −1 point AND the lifetime
    // tick), then spend a token. The game money stays lost — never refunded.
    Object.assign(q, lr.before);
    q.tokens = Math.max(0, q.tokens - 1);
    q.last_round = null;
    saveData();
    return { ok: true, tokens: q.tokens, points: q.points, rounds_left: q.rounds_left };
}

// !goque — Trung Hung: pay the removal fee, end the quẻ, void stacks.
// Pass confirmed=true to skip the >10%-balance guard.
function goque(guildId, userId, confirmed) {
    const auto = checkAutoSettle(guildId, userId);
    if (auto) return { autoSettled: true, lines: auto.lines };
    const st = getState(guildId, userId);
    const q = st.que;
    if (!q) return { error: 'no_que' };
    if (q.type !== 'TRUNG_HUNG') return { error: 'wrong_que' };
    const fee = Q().NGHICH_REMOVE_FEE * tierMult(q.tier);
    const w = getWallet(guildId, userId);
    const avail = w.ngoc + (w.lockedNgoc || 0);
    if (avail < fee) return { error: 'insufficient', fee, available: avail };
    if (!confirmed && fee > avail * Q().GOQUE_CONFIRM_PCT) {
        return { needConfirm: true, fee };
    }
    spendNgocForGame(guildId, userId, fee);
    st.__ref = { guildId, userId };
    // Fee already spent above; fold it into the settlement's recorded sink so
    // metrics count it exactly once, attributed to the Nghịch quẻ.
    const res = settle(st, 'nghich_goque', { feeSink: fee });
    return { ok: true, fee, lines: res.lines };
}

// ── Status / info display ────────────────────────────────────────────────────

function formatStatus(guildId, userId, displayName) {
    const auto = checkAutoSettle(guildId, userId);
    const pre = auto ? auto.lines : [];
    const av = drawAvailability(guildId, userId);
    const q = av.active;
    if (!q) {
        const lines = [
            `🎴 **${displayName}** — chưa có quẻ nào đang hoạt động.`,
            `Rút quẻ: \`!rutque <bậc>\` (${TIER_KEYS.join(' / ')}).`,
            `Còn ${av.totalLeft}/${Q().DAILY_LIMIT} lượt rút hôm nay (Thiên: ${av.thienLeft}/${Q().THIEN_DAILY_LIMIT}).`
        ];
        return [...pre, ...lines].join('\n');
    }
    return [...pre, ...queStatusLines(q, displayName)].join('\n');
}

function queStatusLines(q, displayName) {
    const meta = QUE_META[q.type];
    const t = tierName(q.tier);
    const cap = Q().POINT_CAP;
    const lines = [
        `🎴 Quẻ của **${displayName}**: ${meta.emoji} **${meta.name}** [${t}]`,
        `*${meta.flavor}*`,
        `Còn **${q.rounds_left}** ván · thắng ${q.wins}/${q.wins + q.losses}`
    ];
    if (meta.kind === 'cat') {
        const p = Math.max(-cap, Math.min(q.points, cap));
        const ppw = assumedPpw(q);
        lines.push(`Điểm phúc: **${p}** → ${fmt(ngocValue(q.points, q.tier))} ${ngocEmote()}${p < 0 ? ' ⚠️ (âm — kết toán sẽ TRỪ ngọc)' : gloryTag(q, ppw)}`);
        if (q.type === 'TIEU_CAT') lines.push(`Lá xoá dấu: ${q.tokens}`);
        if (q.type === 'TRUNG_CAT') lines.push(`Thua liên tiếp: ${q.consec_losses}/2 · \`!bank\` chốt non (gồng tiếp ăn dày hơn)`);
        if (q.type === 'DAI_CAT') lines.push(`Chuỗi thắng: ${q.win_streak} · \`!bank\` chốt non (gồng tiếp ăn dày hơn)`);
    } else {
        if (q.type === 'TIEU_HUNG') {
            lines.push(`Tạm giữ ${Math.min(q.points, cap)} điểm (~${fmt(ngocValue(q.points, q.tier))} ${ngocEmote()})${q.points > 0 ? gloryTag(q, assumedPpw(q)) : ''} · đã thua ${q.stacks}/${Q().TIEU_HUNG_MAX_LOSSES}`);
        } else if (q.type === 'TRUNG_HUNG') {
            const penalty = Q().NGHICH_PENALTY_PER_STACK * q.stacks * tierMult(q.tier);
            const worst = worstStackPenalty(q);
            const fee = Q().NGHICH_REMOVE_FEE * tierMult(q.tier);
            lines.push(`${q.stacks} stack · phạt giờ ~${fmt(penalty)} ${ngocEmote()} · 📈 thua hết → **tối đa ${fmt(worst)}** · chuỗi ${q.win_streak}/${Q().NGHICH_BREAK_STREAK}`);
            lines.push(`Thoát: thắng ${Q().NGHICH_BREAK_STREAK} ván liền hoặc \`!goque\` chỉ **${fmt(fee)}** ngọc (rẻ hơn nhiều)`);
        } else if (q.type === 'DAI_HUNG') {
            const penalty = Q().KIEP_PENALTY_PER_STACK * q.stacks * tierMult(q.tier);
            const worst = worstStackPenalty(q);
            const flip = ngocValue(Math.min(q.stacks, cap), q.tier);
            const lieu = Q().LIEU[q.tier - 1];
            lines.push(`${q.stacks} stack · phạt giờ ~${fmt(penalty)} · 📈 thua hết → **tối đa ${fmt(worst)}** · phá quẻ lật ${fmt(flip)} ngọc · chuỗi ${q.win_streak}/${Q().KIEP_BREAK_STREAK}`);
            lines.push(`Phá: thắng ${Q().KIEP_BREAK_STREAK} ván liền${lieu != null ? ` hoặc thắng 1 ván cược ≥ ${fmt(lieu)}` : ' (Thiên: chỉ bằng thực lực)'}`);
        }
    }
    return lines;
}

function formatDrawResult(que, displayName) {
    return queStatusLines(que, displayName).join('\n');
}

function formatInfo() {
    const cap = Q().POINT_CAP;
    const lines = [
        '📖 **Quẻ Bói** — lớp điểm phúc song song, KHÔNG đổi tỉ lệ/thưởng của game.',
        `Rút: \`!rutque <bậc>\` (miễn phí, ${Q().DAILY_LIMIT} lượt/ngày, Thiên ${Q().THIEN_DAILY_LIMIT}/ngày). Mỗi lúc chỉ giữ 1 quẻ.`,
        'Chỉ ván có **cược ≥ ngưỡng bậc** mới tính vào quẻ. **Thắng +điểm, thua −điểm** — điểm xuống **ÂM** thì kết toán bị **trừ ngọc**.',
        '',
        '**Bậc:** ' + TIER_NAMES.map((n, i) => `${n} ×${Q().TIER_MULT[i]}`).join(' · '),
        '',
        '**6 quẻ:**',
        `🟢 Chuyển (${Q().LIFETIME.TIEU_CAT} ván): thắng +điểm, thua −điểm; có ${Q().TIEU_CAT_TOKENS} lá \`!xoadau\` xoá ván thua.`,
        `🟢 Phúc (${Q().LIFETIME.TRUNG_CAT} ván): thắng +, thua −; thua 2 ván liền → sụt mạnh; \`!bank\` chốt lúc nào cũng được.`,
        `🟢 Liên (${Q().LIFETIME.DAI_CAT} ván): meter nhân đôi theo chuỗi — thắng nối thắng ×2 dương, thua nối thua ×2 **âm**; \`!bank\` chốt.`,
        `🔴 Kiệt (${Q().LIFETIME.TIEU_HUNG} ván): giữ điểm; thua > ${Q().TIEU_HUNG_MAX_LOSSES} → mất pool (không phạt tiền).`,
        `🔴 Nghịch (${Q().LIFETIME.TRUNG_HUNG} ván): mỗi thua +1 stack phạt; thắng ${Q().NGHICH_BREAK_STREAK} liền hoặc \`!goque\` để thoát.`,
        `🔴 Kiếp (${Q().LIFETIME.DAI_HUNG} ván): mỗi thua +1 stack phạt; thắng ${Q().KIEP_BREAK_STREAK} liền/liều → lật stack thành điểm.`,
        '',
        `Quy đổi **luỹ tiến hai chiều**: |điểm| càng cao, mỗi điểm càng giá trị — +${cap} điểm ăn trọn ${fmt(cap * Q().POINT_VALUE)} ngọc × bậc, −${cap} điểm bị trừ tương ứng (không đủ ngọc thì trừ hết & xoá nợ). Chốt non nhận ít hơn (gồng nửa meter ≈ 42% tiền).`,
        'Lệnh: `!que` (xem quẻ) · `!bank` · `!xoadau` · `!goque` · `!boiinfo`.'
    ];
    return lines.join('\n');
}

// ── Prune ────────────────────────────────────────────────────────────────────

// Reset yesterday's draw counters; drop empty user entries (no active quẻ).
function pruneDaily(today) {
    today = today || todayStr();
    let removed = 0;
    const f = data.queboi || {};
    for (const guildId of Object.keys(f)) {
        const g = f[guildId];
        for (const uid of Object.keys(g)) {
            const st = g[uid];
            if (!st) { delete g[uid]; removed++; continue; }
            if (st.draws && st.draws.date !== today) {
                st.draws = { date: today, total: 0, thien: 0 };
            }
            if (!st.que && (!st.draws || (!st.draws.total && !st.draws.thien))) {
                delete g[uid]; removed++;
            }
        }
        if (Object.keys(g).length === 0) delete f[guildId];
    }
    if (removed) saveData();
    return removed;
}

module.exports = {
    QUE_TYPES,
    QUE_META,
    TIER_KEYS,
    TIER_NAMES,
    GAMES,
    getActive,
    drawAvailability,
    draw,
    setQue,
    minPossibleBet,
    tierRisk,
    totalWealth,
    affordableTiers,
    onGameResult,
    bank,
    xoadau,
    goque,
    formatStatus,
    formatDrawResult,
    formatInfo,
    pruneDaily
};
