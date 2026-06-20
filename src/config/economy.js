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

    BANG_CHIEN_REWARD: 1000,

    COINFLIP_MAX_BET: 50000,
    // Player win probability per flip (payout stays 2x). 0.5 = zero house
    // edge; lower slightly (e.g. 0.4995) to give the house an edge.
    COINFLIP_WIN_RATE: 0.499,
    SLOT_MAX_BET: 5000,
    SLOT_PITY_CAP_MULT: 2,
    TONG_MAX_BET: 10000,
    MAT_MAX_BET: 50000,

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

    WORDCHAIN_ENG: {
        NGOC_PER_WORD: 16,
        WORD_THRESHOLD: 25,
        NGOC_PER_WORD_AFTER: 8,
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
