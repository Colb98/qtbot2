const fs = require('fs');
const path = require('path');

// Default economy values. These are the baseline shipped with the bot.
// Runtime overrides (edited via the admin web panel) are deep-merged on top of
// a clone of these defaults, in place, so other modules that hold a reference to
// the exported config object (or to a nested object like GACHA / BOND) see live
// changes without a restart.
const DEFAULTS = {
    CHAT_REWARD: 2500,
    CHAT_DAILY_CAP: 200,

    NGAN_PHIEU_PER_NGOC: 100,
    TT_PER_CAO: 3,
    CAO_PER_CAO5: 3,
    CAO5_PER_CAO9: 3,
    ROLLS_PER_THIENTHUONG: 50,

    // Trang phục: forward-only exchange from Thiên Thưởng.
    // Phượng Hoả = 1 Phượng Băng + PHUONGHOA_TT thiên thưởng.
    PHUONGBANG_TT: 200,
    PHUONGHOA_TT: 200,
    THANTRANG_TT: 100,

    SELL_PRICE_NGOC: {
        kythuong: 100,
        dieu: 20,
        nhuom: 20
    },

    BOND: {
        PER_DIEU: 20,
        PER_NGOC: 0.1,
        PER_THIENTHUONG: 1000,
        PER_CAO: 3000,
        PER_CAO5: 9000,
        PER_CAO9: 27000,
        // Cosmetics: scale at 1000 bond per TT-equivalent of cost.
        PER_PHUONGHOANG1: 200000,
        PER_PHUONGHOANG2: 400000,
        PER_THANTRANG: 100000,
        THRESHOLDS: [0, 1000, 10000, 50000, 200000, 500000, 1000000, 5000000, 10000000, 50000000],
        EMOJIS: ['😊', '🫰', '🫶', '🥰', '❤️', '💖', '💝', '💕', '💞', '❤️‍🔥']
    },

    // Ngọc "két an toàn" (safe). Banked ngọc can't be spent on games but still
    // counts toward !topngoc. Interest accrues once per GMT+7 day on the LOWER
    // of (balance at the start of the day, balance now) — so parking ngọc only
    // briefly earns nothing. Flat rate, no cap; keep it low to avoid making the
    // bank a wealth engine for whales.
    BANK: {
        INTEREST_RATE: 0.005   // 0.5% / day
    },

    BANG_CHIEN_REWARD: 1000,

    COINFLIP_MAX_BET: 50000,
    // Player win probability per flip (payout stays 2x). 0.5 = zero house
    // edge; lower slightly (e.g. 0.4995) to give the house an edge.
    COINFLIP_WIN_RATE: 0.499,
    SLOT_MAX_BET: 5000,
    SLOT_PITY_CAP_MULT: 2,
    // Global weight multiplier applied to every losing slot outcome (mult ≤ 1x:
    // Hoàn Vốn / Nhỏ / Thua). 1 = normal config, 1.5 = losing weights ×1.5
    // (rarer wins), 0 = losing outcomes removed entirely (every spin wins).
    SLOT_LOSE_RATE_MULT: 1,
    TONG_MAX_BET: 10000,
    MAT_MAX_BET: 50000,
    // Force-lose bias for the dice games (tổng / mặt). 0 = pure random (fair
    // roll). Positive = on a winning roll, this is the probability it is flipped
    // to a loss (1 = always lose). Negative = on a losing roll, |value| is the
    // probability it is flipped to a win (-1 = always win).
    TONG_FORCE_LOSE: 0,
    MAT_FORCE_LOSE: 0,

    // Auto-replay for the casino games (slot / coinflip / tong / mat): the
    // Auto button repeats the last bet once per INTERVAL_MS (next round fires
    // when the previous one is settled AND the interval has elapsed), capped
    // at MAX_ROUNDS per session. One session per user.
    AUTO_PLAY: {
        INTERVAL_MS: 4000,
        MAX_ROUNDS: 200,
        // Wins at/above these mults are also posted as their own message
        // during auto (with a ping), so the in-place round edits don't swallow
        // a rare hit and the player can share it. Coinflip is always 2x, so it
        // has no entry. slot 18 = jackpot tier (x18/x40/x150) · tong 21 = the
        // edge sums 3-6/17-18 (x21..x200) · mat 6 = triple match.
        KEEP_MIN_MULT: { slot: 18, tong: 21, mat: 6 }
    },

    DAILY_REWARD: {
        nganphieuMin: 50000,
        nganphieuMax: 100000
    },

    // ── Câu cá (!cauca / !fishing) — daily GIF faucet ────────────────────────
    // Free cast, weighted ending, reward lands only after the pre-rendered GIF
    // reveals the ending (REVEAL_DELAY_MS after the message is sent). ngoc can
    // be negative (catfish/puffle) and the wallet is allowed to go below 0.
    // EV per cast, valuing 1 thiên thưởng at TT_VALUE_NGOC = 5000:
    //   .28×500 + .20×2000 − .12×1000 − .12×1000 + .14×5000 = 1000 ngọc.
    FISHING: {
        DAILY_LIMIT: 10,
        REVEAL_DELAY_MS: 5000,
        TT_VALUE_NGOC: 5000,
        OUTCOMES: {
            small:    { weight: 28, ngoc: 500 },
            tuna:     { weight: 20, ngoc: 2000 },
            catfish:  { weight: 12, ngoc: -1000 },
            puffle:   { weight: 12, ngoc: -1000 },
            treasure: { weight: 5, ngoc: 0, thienthuong: 1 },
            kelp:     { weight: 7,  ngoc: 0 },
            nothing:  { weight: 7,  ngoc: 0 }
        }
    },

    // ── Rút quẻ (!rutque / !fortune) — daily fortune, modifies casino odds ──
    // One draw per user per GMT+7 day; no draw = neutral day. RATE_MULT
    // multiplies the win probability of coinflip/slot/tổng/mặt; JACKPOT_MULT
    // multiplies jackpot-tier payouts (slot mult ≥ SLOT_MIN_MULT, mặt 3-match;
    // tổng is DISABLED via 999 — its multiplier is player-chosen and near-fair,
    // so a x1.5 jackpot on chosen x36+/x70+ sums would be a +24–28% EV farm).
    // Đại Hung "reverse": a win with payout ≥ REVERSE_MIN_PAYOUT_RATIO × stake
    // procs ×REVERSE_MULT at REVERSE_PROC. EV ratio = RATE_MULT × (1 +
    // (REVERSE_MULT−1) × REVERSE_PROC) must stay < 1 → hard ceiling
    // REVERSE_PROC < 0.107 at mult 5, or Đại Hung goes +EV and gets farmed
    // (0.095 → EV ratio 0.966). The ratio gate is defense in depth against
    // refund-grind shapes (e.g. mặt 2-face wins that pay ≈ the stake back).
    // Đại Cát "man decay" (Mãn Chiêu Tổn): wins score points by net profit;
    // past MAN_THRESHOLD each scoring win rolls hazard (pts − threshold) ×
    // MAN_STEP_PER_POINT; on proc the win rate silently becomes
    // DECAY_RATE_MULT for the rest of the day. There is deliberately NO
    // binary tell: instead of cutting the jackpot boost off, the chance a
    // jackpot still gets the full JACKPOT_MULT fades linearly from 100% at
    // MAN_THRESHOLD pts to MAN_JACKPOT_LUCKY_MIN at MAN_JACKPOT_FADE_END pts
    // (pinned at the minimum once decay has fired) — the player keeps seeing
    // occasional x1.35 jackpots and can never pinpoint when the luck died.
    // Points and decay are PER-DAY, not per-draw: a redraw never refreshes a
    // spent Đại Cát.
    // DICE_COVERAGE_MAX_RATIO: a tổng/mặt bet covering ≥ this share of all
    // cửa (tổng ≥ 8/16 sums, mặt ≥ 3/6 faces) gets NO fortune effects at all —
    // high-coverage bets are near-guaranteed "wins" (mặt all-6 always refunds
    // its stake) and would turn any payout multiplier into a riskless grinder.
    // Redraw price = max(REDRAW_BASE_COST, total ngọc × REDRAW_WEALTH_PCT)
    // × REDRAW_COST_MULT^(redraws today) — scales with wealth so whales can't
    // fish for Đại Cát with pocket change. Total counts ví + locked + bank
    // két (same as !topngoc), so banking ngọc doesn't dodge the scaling.
    // ── Quẻ Bói (fortune-draw scoring layer) ────────────────────────────────
    // A parallel "điểm phúc" scoring layer settled in ngọc. It NEVER touches
    // any game's odds/payouts — games run 100% unchanged; the quẻ reads each
    // qualifying round's result and scores/penalises it. All rewards/penalties
    // are FLAT (per tier), never a % of bet — the anti-whale invariant. Every
    // number here is live-tunable via the admin panel. See services/rutque.js.
    QUE_BOI: {
        DAILY_LIMIT: 10,         // draws/user/day (resets 00:00 ICT)
        THIEN_DAILY_LIMIT: 5,    // extra cap: Thiên tier draws/user/day
        AUTO_SETTLE_DAYS: 7,     // safety valve: settle a parked quẻ after 7 days
        GOQUE_CONFIRM_PCT: 0.10, // !goque asks to confirm if fee > this × balance

        // Base flat values (tier Phàm ×1); scaled by the tier multiplier.
        POINT_VALUE: 100,                // 1 điểm phúc → ngọc
        POINT_CAP: 20,                   // max điểm payable per quẻ (meter clamp too)
        NGHICH_PENALTY_PER_STACK: 150,
        NGHICH_REMOVE_FEE: 400,          // !goque fee (a sink)
        KIEP_PENALTY_PER_STACK: 200,

        TIER_MULT: [1, 8, 30, 100, 250], // Phàm, Linh, Huyền, Địa, Thiên

        // Per-game min bet for a round to COUNT toward the quẻ, indexed by tier−1.
        MIN_BET: {
            coinflip: [100, 1000, 5000, 20000, 50000],
            mat:      [100, 1000, 5000, 20000, 50000],
            tong:     [100, 500, 1500, 4000, 10000],
            slot:     [50, 250, 750, 2000, 5000]
        },
        // Đại Hung "liều" break threshold per tier (null = unavailable at Thiên).
        LIEU: [2000, 10000, 30000, 50000, null],
        // Điểm phúc awarded per winning round, per game (≈ round(0.5 / win_rate)).
        POINTS_PER_WIN: { coinflip: 1, mat: 2, tong: 2, slot: 5 },

        // Quẻ lifetimes (qualifying rounds) and per-quẻ knobs.
        LIFETIME: {
            TIEU_CAT: 10, TRUNG_CAT: 10, DAI_CAT: 8,
            TIEU_HUNG: 5, TRUNG_HUNG: 8, DAI_HUNG: 10
        },
        TIEU_CAT_TOKENS: 2,       // xoá dấu tokens
        TIEU_HUNG_MAX_LOSSES: 2,  // > this ⇒ held pool forfeited
        NGHICH_BREAK_STREAK: 3,   // wins-in-a-row to break Nghịch
        KIEP_BREAK_STREAK: 4,     // wins-in-a-row to break Kiếp

        // Draw table — the single economy knob. Keep cát vs hung EV ≈ neutral
        // or slightly sink-negative. Weights need not sum to 100.
        DRAW_WEIGHTS: {
            TIEU_CAT: 20, TRUNG_CAT: 18, DAI_CAT: 12,
            TIEU_HUNG: 20, TRUNG_HUNG: 18, DAI_HUNG: 12
        }
    },

    GACHA: {
        ROLL_COST: 100,
        SUPPORTED_COUNTS: [1, 10, 50],

        BASE_RATES: {
            cao: 0.0004,
            thienthuong: 0.0036,
            kythuong: 0.04
        },

        PITY_KT_THRESHOLD: 20,
        PITY_KT_RATES: {
            cao: 0.001,
            thienthuong: 0.009,
            kythuong: 0.99
        },

        PITY_TT_START: 180,
        PITY_TT_END: 200,
        PITY_TT_END_RATES: {
            cao: 0.05,
            thienthuong: 0.95,
            kythuong: 0
        }
    },

    VUATIENGVIET: {
        EASY:   { TIME_LIMIT_S: 60, NGOC_PER_WORD: 80,  DAILY_CAP: 1600  },
        MEDIUM: { TIME_LIMIT_S: 30, NGOC_PER_WORD: 200, DAILY_CAP: 4000 },
        HARD:   { TIME_LIMIT_S: 15, NGOC_PER_WORD: 440, DAILY_CAP: 8800 },
        MAX_MISSES: 3,
        WEEKLY_REWARDS: [
            { from: 1, to: 1,  ngoc: 15000 },
            { from: 2, to: 3,  ngoc: 8000  },
            { from: 4, to: 10, ngoc: 4000  }
        ]
    },

    // ── Nối Từ co-op (faucet) ────────────────────────────────────────────────
    // Co-op Vietnamese wordchain vs the bot (the chill 1v1 /noi_tu stays
    // economy-free). Per-word reward escalates with chain position; the bot
    // plays friendly for the first BOT_FRIENDLY_WORDS player words, then ramps
    // up the chance of picking the continuation that squeezes players hardest.
    WORDCHAIN_VIET: {
        NGOC_PER_WORD_BASE: 40,
        NGOC_PER_POSITION_STEP: 15,
        POSITIONS_PER_STEP: 5,
        NGOC_PER_WORD_MAX: 100,
        REWARD_CAP_PER_POSITION: 20,   // payouts per position per user/day
        DAILY_CAP_WORDS: 10000,        // ngọc/user/day from per-word rewards
        WIN_BONUS: 2000,               // dead-ending the bot (VN has many dead tails)
        WIN_BONUS_DAILY_CAP: 10000,    // ngọc/user/day from win bonuses
        WIN_BONUS_MIN_WORDS: 5,        // run must have ≥ this many player words to pay the bonus (blocks word-1 insta-kills)
        BOT_FRIENDLY_WORDS: 20,
        BOT_FRIENDLY_MIN_CONT: 3,      // friendly pick must leave players ≥ this many continuations
        BOT_HOSTILE_RAMP: 0.05,        // +5% hostile chance per player word past friendly
        BOT_HOSTILE_MAX: 0.9,
        BOT_HOSTILE_MAX_CONT: 2,       // hostile pick = random word leaving players ≤ this many continuations
        TIMER_LADDER: [
            { upTo: 10, seconds: 60 },
            { upTo: 20, seconds: 45 },
            { upTo: 30, seconds: 30 },
            { upTo: 40, seconds: 20 },
            { upTo: Infinity, seconds: 15 }
        ],
        WEEKLY_REWARDS: [
            { from: 1, to: 1,  ngoc: 15000 },
            { from: 2, to: 3,  ngoc: 8000  },
            { from: 4, to: 10, ngoc: 4000  }
        ]
    },

    // Player-driven moderation of the !noitu candidate queue. Players vote ✅/❌
    // via !duyettu; payouts resolve against the "truth": the admin verdict on the
    // accept branch, crowd consensus on clean auto-rejects. Reward/penalty depend
    // on whether you matched the truth and whether you were with or against the
    // crowd (see services/wordReview.js resolveWord).
    WORD_REVIEW: {
        APPROVE_THRESHOLD: 3,    // distinct ✅ → word graduates to the admin queue
        REJECT_THRESHOLD: 3,     // distinct ❌ → auto-reject (but contested ones, ≥1 ✅, go to admin)
        REWARD: 70,              // correct, and you were with the majority
        REWARD_MINORITY: 200,    // correct against the crowd (caught a crowd mistake)
        PENALTY: 50,             // wrong, but you followed the majority
        PENALTY_MINORITY: 150,   // wrong AND contrarian (deliberately against the crowd)
        // Admin resolves a word that never reached a vote threshold (still pending,
        // <3 ✅ and <3 ❌): no real crowd → flat payout, no majority/minority bonus.
        REWARD_FLAT: 100,        // correct vs the admin verdict
        PENALTY_FLAT: 20,        // wrong vs the admin verdict
        DAILY_VOTE_CAP: 40       // distinct new votes/user/day (anti-farm; rewards land at resolution)
    },

    WORDCHAIN_ENG: {
        NGOC_PER_WORD: 16,
        WORD_THRESHOLD: 25,
        NGOC_PER_WORD_AFTER: 8,
        // Wordchain EN has no daily ngọc cap; this is the reference "full day"
        // used only for the tt_legacy unlock (see currency.accrueFaucetUnlock):
        // UNLOCK_DAILY_CAP / RESET.FAUCET_TT_PER_DAY ngọc → 1 tt_legacy, and the
        // unlock is bounded at UNLOCK_DAILY_CAP/day so it also tops out at ~10 TT.
        UNLOCK_DAILY_CAP: 8000,
        REWARD_CAP_PER_POSITION: 20,
        TIMER_LADDER: [
            { upTo: 10, seconds: 60 },
            { upTo: 20, seconds: 45 },
            { upTo: 30, seconds: 30 },
            { upTo: 40, seconds: 15 },
            { upTo: 50, seconds: 10 },
            { upTo: Infinity, seconds: 5 }
        ],
        RARE_END_LETTERS: ['j', 'q', 'x', 'z'],
        RARE_END_RATE: 0.02,
        S_END_RATE: 0.04,
        SURRENDER_BLOCK_LETTERS: ['e', 's'],
        SURRENDER_MIN_REMAINING_MS: 20 * 1000,
        WIN_BONUS: 10000,
        WEEKLY_REWARDS: [
            { from: 1, to: 1, ngoc: 15000 },
            { from: 2, to: 3, ngoc: 8000 },
            { from: 4, to: 10, ngoc: 4000 }
        ]
    },

    // ── Flash Math (#1) ──────────────────────────────────────────────────────
    // Open-thread reaction race. Difficulty auto-escalates every
    // QUESTIONS_PER_LEVEL correct answers along LADDER (index = level-1, clamped
    // to the last row). Phase 1 ramps hardness at a constant timer; phase 2
    // freezes hardness and shrinks the timer to a 5s floor.
    FLASHMATH: {
        QUESTIONS_PER_LEVEL: 5,
        MULT_MAX_FACTOR: 12,
        MAX_MISSES: 3,
        NGOC_PER_CORRECT_BASE: 40,
        NGOC_PER_LEVEL_STEP: 10,
        NGOC_PER_CORRECT_MAX: 200,
        DAILY_CAP: 6000,
        // Weekly leaderboard payout (ranked by highest level reached), same tiers
        // as Vua Tiếng Việt / Wordchain.
        WEEKLY_REWARDS: [
            { from: 1, to: 1,  ngoc: 15000 },
            { from: 2, to: 3,  ngoc: 8000  },
            { from: 4, to: 10, ngoc: 4000  }
        ],
        LADDER: [
            { nums: 2, min: 1, max: 20, ops: ['+', '-'],      timeS: 20 }, // L1
            { nums: 2, min: 1, max: 50, ops: ['+', '-'],      timeS: 20 }, // L2
            { nums: 2, min: 1, max: 99, ops: ['+', '-', '*'], timeS: 20 }, // L3
            { nums: 3, min: 1, max: 20, ops: ['+', '-'],      timeS: 20 }, // L4
            { nums: 3, min: 1, max: 50, ops: ['+', '-', '*'], timeS: 20 }, // L5
            { nums: 3, min: 1, max: 99, ops: ['+', '-', '*'], timeS: 20 }, // L6 max hardness
            { nums: 3, min: 1, max: 99, ops: ['+', '-', '*'], timeS: 18 }, // L7
            { nums: 3, min: 1, max: 99, ops: ['+', '-', '*'], timeS: 15 }, // L8
            { nums: 3, min: 1, max: 99, ops: ['+', '-', '*'], timeS: 12 }, // L9
            { nums: 3, min: 1, max: 99, ops: ['+', '-', '*'], timeS: 9  }, // L10
            { nums: 3, min: 1, max: 99, ops: ['+', '-', '*'], timeS: 6  }, // L11
            { nums: 3, min: 1, max: 99, ops: ['+', '-', '*'], timeS: 5  }  // L12+ floor
        ]
    },

    // ── Math Boss Raid (#3) ──────────────────────────────────────────────────
    // Co-op (or solo) boss fight. Each turn the boss posts EQ equations; each
    // solved equation deals DMG_PER_EQ to the boss and is credited to its solver
    // (reward split by damage on kill). The boss retaliates per MOVESET.
    MATHBOSS: {
        MULT_MAX_FACTOR: 12,
        NGOC_DAILY_CAP: 15000, // per user/day across all boss tiers
        SMALL: {
            EQ: 1, TIME_S: 15, BOSS_HP: 8,  PLAYER_HP: 3, DMG_PER_EQ: 1, BOSS_ATK: 1,
            NGOC_POOL: 1500, SUMMON_CAP: 5, MIN: 1, MAX: 20, OPS: ['+', '-'],
            MOVESET: 'single'
        },
        MEDIUM: {
            EQ: 2, TIME_S: 12, BOSS_HP: 20, PLAYER_HP: 4, DMG_PER_EQ: 1, BOSS_ATK: 1,
            NGOC_POOL: 4000, SUMMON_CAP: 3, MIN: 1, MAX: 50, OPS: ['+', '-', '*'],
            AOE_CHANCE: 0.25, MOVESET: 'aoe'
        },
        BIG: {
            EQ: 4, TIME_S: 10, BOSS_HP: 40, PLAYER_HP: 5, DMG_PER_EQ: 1, BOSS_ATK: 1,
            NGOC_POOL: 12000, SUMMON_CAP: 1, MIN: 1, MAX: 99, OPS: ['+', '-', '*'],
            WIPE_AFTER_FAILS: 3, MOVESET: 'wipe'
        }
    },

    // ── Xổ số (!xoso) — live-tunable balance knobs ───────────────────────────
    // The admin economy page edits these in place (no restart). Structural fields
    // that change odds/scheduling (NUMBER_POOL_MAX, NUMBERS_PER_TICKET, DRAW_HOURS,
    // TIMEZONE) stay in config/lottery.js — they need a restart to take effect.
    // POOL_SHARE is NOT stored here: it's derived as TICKET_PRICE − CONSOLATION_SHARE
    // in config/lottery.js, so every ticket always splits entirely into pool +
    // reserve no matter how TICKET_PRICE is retuned.
    LOTTERY: {
        TICKET_PRICE: 500,
        MAX_TICKETS_PER_DRAW: 5,
        SEED_POOL: 100000,        // jackpot floor / reset value
        CONSOLATION_SHARE: 125,   // per ticket → consolation reserve (pool gets the rest)
        PRIZE_3_OF_4: 1000,
        PRIZE_2_OF_4: 100
    },

    // ── Server reset (!server_reset) — one-time wealth compression at a season
    // boundary. See season2_reset_spec.md. LADDER is a bracketed marginal
    // carry-over curve applied to each wallet's TOTAL ngọc (ví + khoá + két):
    // each bracket carries `rate` of the portion of ngọc that falls in it. The
    // top bracket uses a large finite cap (not Infinity) so the override walker
    // keeps every leaf admin-editable. WAGER_PER_TT = ngọc a player must wager
    // (win or lose) to convert 1 old Thiên Thưởng into a new one (!doitt).
    // FAUCET_TT_PER_DAY = how many tt_legacy a full day of any single skill/faucet
    // game (Vua Tiếng Việt · Nối Từ · Flash Math · Boss) unlocks. The unlock
    // accrues into resetWager proportional to the game's daily ngọc cap, so
    // maxing out one game's cap ≈ FAUCET_TT_PER_DAY conversions via !doitt.
    RESET: {
        LADDER: [
            { upTo: 500000,        rate: 1.0 },
            { upTo: 1000000,       rate: 0.7 },
            { upTo: 2000000,       rate: 0.5 },
            { upTo: 1000000000000, rate: 0.2 }
        ],
        WAGER_PER_TT: 100000,
        FAUCET_TT_PER_DAY: 10
    }
};

// JSON.stringify drops Infinity (-> null). Preserve it through clone with a sentinel.
function cloneDefaults(obj) {
    if (Array.isArray(obj)) return obj.map(cloneDefaults);
    if (obj && typeof obj === 'object') {
        const out = {};
        for (const k of Object.keys(obj)) out[k] = cloneDefaults(obj[k]);
        return out;
    }
    return obj;
}

// The live config object every consumer reads from. Starts as a clone of DEFAULTS;
// overrides are applied in place so references stay valid.
const config = cloneDefaults(DEFAULTS);

const OVERRIDES_PATH = path.resolve(__dirname, '..', '..', 'economy_overrides.json');

// Navigate to the parent container of a dot-path; returns { parent, key } or null
// if any segment along the way is missing. We never create new keys — overrides
// may only target fields that already exist in the config shape.
function locate(root, dotPath) {
    const parts = String(dotPath).split('.');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
        if (cur == null || typeof cur !== 'object') return null;
        cur = cur[parts[i]];
    }
    const key = parts[parts.length - 1];
    if (cur == null || typeof cur !== 'object' || !(key in cur)) return null;
    return { parent: cur, key };
}

// Apply a flat { "GACHA.ROLL_COST": 120, ... } map onto the live config in place.
// Only overwrites existing leaf values; unknown paths are skipped. Returns the
// list of paths that were applied.
function applyFlat(flat) {
    const applied = [];
    if (!flat || typeof flat !== 'object') return applied;
    for (const [dotPath, value] of Object.entries(flat)) {
        const loc = locate(config, dotPath);
        if (!loc) continue;
        const existing = loc.parent[loc.key];
        // Only override scalar leaves (numbers/strings/booleans), never structures.
        if (existing !== null && typeof existing === 'object') continue;
        loc.parent[loc.key] = value;
        applied.push(dotPath);
    }
    return applied;
}

// Load persisted overrides synchronously at module init, BEFORE any consumer
// requires this module and caches a scalar at load time.
function loadPersisted() {
    try {
        const raw = fs.readFileSync(OVERRIDES_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        if (e.code !== 'ENOENT') {
            // Avoid pulling in the logger here (it may not be ready); use stderr.
            console.error('economy: failed to read overrides file:', e.message);
        }
        return {};
    }
}

applyFlat(loadPersisted());

// Expose internals to the override manager without polluting the enumerable
// config surface that consumers read.
Object.defineProperty(config, '__meta', {
    enumerable: false,
    value: {
        DEFAULTS,
        OVERRIDES_PATH,
        cloneDefaults,
        locate,
        applyFlat
    }
});

module.exports = config;
