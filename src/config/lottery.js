module.exports = {
    TICKET_PRICE: 500,
    MAX_TICKETS_PER_DRAW: 5,
    NUMBER_POOL_MAX: 11,
    NUMBERS_PER_TICKET: 4,
    SEED_POOL: 100000,
    POOL_SHARE: 375,           // per ticket → jackpot pool (must sum with CONSOLATION_SHARE = TICKET_PRICE)
    CONSOLATION_SHARE: 125,    // per ticket → consolation reserve
    PRIZE_3_OF_4: 1000,        // EV ~123/ticket at pool 11 (3/4 8.48% · 2/4 38.18%) ≈ CONSOLATION_SHARE
    PRIZE_2_OF_4: 100,
    DRAW_HOURS: [10, 22],      // 10:00 and 22:00 Vietnam time
    TIMEZONE: 'Asia/Ho_Chi_Minh',
};
