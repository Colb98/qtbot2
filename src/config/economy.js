module.exports = {
    CHAT_REWARD: 2500,
    CHAT_DAILY_CAP: 200,

    NGAN_PHIEU_PER_NGOC: 100,
    TT_PER_CAO: 3,

    BANG_CHIEN_REWARD: 1000,

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
    }
};
