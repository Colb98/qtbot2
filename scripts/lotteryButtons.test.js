const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const discord = require('discord.js');

function load(file, mocks) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
        module, exports: module.exports, console, Date, Math,
        require: name => { if (name in mocks) return mocks[name]; throw Error(`Unexpected dependency: ${name}`); }
    }, { filename: file });
    return module.exports;
}

function fixture(balance = 10000, locked = 0) {
    const data = {};
    const wallet = { ngoc: balance, lockedNgoc: locked };
    const config = { SEED_POOL: 100000, MAX_TICKETS_PER_DRAW: 7, TICKET_PRICE: 500,
        POOL_SHARE: 375, CONSOLATION_SHARE: 125, NUMBER_POOL_MAX: 11, NUMBERS_PER_TICKET: 4, DRAW_HOURS: [10, 22] };
    const currency = { getWallet: () => wallet, renderEmote: () => 'ngọc', fmt: String,
        spendNgocForGame: (_g, _u, cost) => {
            const lockedSpend = Math.min(wallet.lockedNgoc, cost);
            wallet.lockedNgoc -= lockedSpend;
            wallet.ngoc -= cost - lockedSpend;
        } };
    const sent = [];
    const lottery = load('src/services/lottery.js', {
        'discord.js': discord, '../../logger': { warn() {} }, '../client': { channels: { fetch: async () => ({ send: async payload => sent.push(payload) }) } },
        '../state': { data, saveData() {} }, './currency': currency, '../config/lottery': config,
        './profile': {}, '../utils': { chunkMessage: text => [text.slice(0, 10), text.slice(10)] }
    });
    const handler = load('src/services/lotteryInteractions.js', { 'discord.js': discord, './lottery': lottery, './currency': currency });
    function interaction(customId, value = '') {
        return { customId, guildId: 'g', user: { id: 'u' },
            isButton: () => customId !== 'lottery:buy', isModalSubmit: () => customId === 'lottery:buy',
            fields: { getTextInputValue: () => value },
            reply: async function(payload) { this.response = payload; },
            showModal: async function(modal) { this.modal = modal.toJSON(); }
        };
    }
    return { lottery, handler, interaction, config, data, wallet, sent };
}

test('Bao hết respects locked currency, affordability, remaining cap and repeated clicks', async () => {
    const f = fixture(600, 600);
    const i = f.interaction('lottery:all');
    await f.handler.handleComponent(i);
    assert.equal(f.lottery.userTicketsThisDraw('g', 'u').length, 2);
    assert.equal(f.wallet.ngoc + f.wallet.lockedNgoc, 200);
    assert.equal(i.response.flags, discord.MessageFlags.Ephemeral);
    await f.handler.handleComponent(f.interaction('lottery:all'));
    assert.equal(f.lottery.userTicketsThisDraw('g', 'u').length, 2);
    f.wallet.ngoc = 10000;
    await f.handler.handleComponent(f.interaction('lottery:all'));
    await f.handler.handleComponent(f.interaction('lottery:all'));
    assert.equal(f.lottery.userTicketsThisDraw('g', 'u').length, 7);
});

test('custom modal shows live limit; blank input buys exactly one privately', async () => {
    const f = fixture(1600);
    const i = f.interaction('lottery:custom');
    await f.handler.handleComponent(i);
    const input = i.modal.components[0].components[0];
    assert.match(input.label, /1–3/);
    assert.equal(input.required, false);
    const submit = f.interaction('lottery:buy', '  ');
    await f.handler.handleComponent(submit);
    assert.equal(f.lottery.userTicketsThisDraw('g', 'u').length, 1);
    assert.equal(submit.response.flags, discord.MessageFlags.Ephemeral);
});

test('invalid and stale modal submissions do not charge or create tickets', async () => {
    const f = fixture();
    for (const value of ['0', '-1', '1.5', '2abc', '1e2', '8']) {
        const i = f.interaction('lottery:buy', value);
        await f.handler.handleComponent(i);
        assert.equal(i.response.flags, discord.MessageFlags.Ephemeral);
    }
    await f.handler.handleComponent(f.interaction('lottery:custom'));
    f.wallet.ngoc = 500;
    await f.handler.handleComponent(f.interaction('lottery:buy', '7'));
    assert.equal(f.lottery.userTicketsThisDraw('g', 'u').length, 0);
    assert.equal(f.wallet.ngoc, 500);
    for (const count of [NaN, -1, 0, 1.5, Infinity]) assert.equal(f.lottery.buyRandomTickets('g', 'u', count).ok, false);
});

test('live price/cap changes drive purchase bounds', async () => {
    const f = fixture(2500);
    f.config.TICKET_PRICE = 1000;
    f.config.MAX_TICKETS_PER_DRAW = 4;
    assert.equal(f.lottery.getPurchaseLimit('g', 'u').max, 2);
    await f.handler.handleComponent(f.interaction('lottery:all'));
    assert.equal(f.lottery.userTicketsThisDraw('g', 'u').length, 2);
    assert.equal(f.wallet.ngoc, 500);
});

test('draw announcement attaches shared buttons only to the final chunk', async () => {
    const f = fixture();
    f.lottery.setNotificationChannel('g', 'channel');
    await f.lottery.announceDraw({ guildId: 'g', winningNumbers: [1, 2, 3, 4], ticketCount: 0,
        jackpotWinners: [], winners3: [], winners2: [], newPool: 100000 });
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[0].components.length, 0);
    assert.deepEqual(f.sent[1].components[0].toJSON().components.map(b => b.custom_id), ['lottery:all', 'lottery:custom']);
});
