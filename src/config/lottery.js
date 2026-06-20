// Lottery (!xoso) config.
//
// Balance knobs (ticket price, tickets/draw, seed, prizes, reserve share) live in
// config/economy.js under the LOTTERY section so they're editable at runtime from
// the admin economy page — read here via getters so consumers always see the live
// value. Structural fields below (number pool size, numbers per ticket, draw
// hours, timezone) change odds/scheduling and need a code edit + restart.
const economy = require('./economy');
const L = economy.LOTTERY;

module.exports = {
    // ── Structural — change in code + restart ────────────────────────────────
    NUMBER_POOL_MAX: 11,
    NUMBERS_PER_TICKET: 4,
    DRAW_HOURS: [10, 22],      // 10:00 and 22:00 Vietnam time
    TIMEZONE: 'Asia/Ho_Chi_Minh',

    // ── Balance — live-editable via admin economy page (economy.LOTTERY) ──────
    get TICKET_PRICE()         { return L.TICKET_PRICE; },
    get MAX_TICKETS_PER_DRAW() { return L.MAX_TICKETS_PER_DRAW; },
    get SEED_POOL()            { return L.SEED_POOL; },
    get CONSOLATION_SHARE()    { return L.CONSOLATION_SHARE; },     // per ticket → consolation reserve
    // Derived so the invariant POOL_SHARE + CONSOLATION_SHARE = TICKET_PRICE
    // always holds — every ticket splits entirely into jackpot pool + reserve.
    get POOL_SHARE()           { return L.TICKET_PRICE - L.CONSOLATION_SHARE; },
    get PRIZE_3_OF_4()         { return L.PRIZE_3_OF_4; },          // EV ~123/ticket at pool 11 ≈ CONSOLATION_SHARE
    get PRIZE_2_OF_4()         { return L.PRIZE_2_OF_4; },
};
