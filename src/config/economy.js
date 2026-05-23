module.exports = {
    CHAT_REWARD: 2500,
    CHAT_DAILY_CAP: 200,

    NGAN_PHIEU_PER_NGOC: 100,
    TT_PER_CAO: 3,
    ROLLS_PER_THIENTHUONG: 50,

    BANG_CHIEN_REWARD: 1000,

    COINFLIP_MAX_BET: 50000,
    SLOT_MAX_BET: 5000,
    SLOT_PITY_CAP_MULT: 2,
    TONG_MAX_BET: 10000,
    MAT_MAX_BET: 50000,

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

    WORDCHAIN_ENG: {
        NGOC_PER_WORD: 8,
        WORD_THRESHOLD: 25,
        NGOC_PER_WORD_AFTER: 4,
        REWARD_CAP_PER_POSITION: 10,
        TIMER_LADDER: [
            { upTo: 10, seconds: 60 },
            { upTo: 20, seconds: 45 },
            { upTo: 30, seconds: 30 },
            { upTo: 40, seconds: 15 },
            { upTo: 50, seconds: 10 },
            { upTo: Infinity, seconds: 5 }
        ],
        RARE_END_LETTERS: ['j', 'q', 'x', 'z'],
        RARE_END_RATE: 0.05
    }
};
