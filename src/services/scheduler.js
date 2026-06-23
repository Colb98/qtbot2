const cron = require('node-cron');
const log = require('../../logger');
const { data } = require('../state');
const { dayMap } = require('../constants');
const { doWeeklyPost, sendReminders } = require('./guildWar');
const { clearLowPrioAll, clearHighPrioAll } = require('./priority');
const currency = require('./currency');
const flashMath = require('./flashMath');
const mathBoss = require('./mathBoss');
const vuaTiengViet = require('./vuaTiengViet');
const wordchainViet = require('./wordchainViet');
const wordReview = require('./wordReview');
const season = require('./season');
const bank = require('./bank');

let weeklyTask = null;
let clearPrioTask = null;
let reminderTask = null;
let dailyPruneTask = null;
let seasonTask = null;
let bankInterestTask = null;

function scheduleWeeklyJobs() {
    if (weeklyTask) weeklyTask.destroy();
    if (clearPrioTask) clearPrioTask.destroy();
    if (reminderTask) reminderTask.destroy();

    const day = (data.event.day || 'monday').toLowerCase();
    const hr = Number(data.event.hour || 20);
    const min = Number(data.event.minute || 0);

    const dayNum = dayMap[day];
    if (dayNum === undefined) return;

    const postCron = `${0} ${20} * * ${dayMap['monday']}`;
    let rhr = hr, rmin = min - 30;
    if (rmin < 0) { rmin += 60; rhr = (hr + 23) % 24; }
    const reminderCron = `${rmin} ${rhr} * * ${dayNum}`;
    const clearLowPrioCron = `${min} ${hr} * * ${dayNum}`;

    weeklyTask = cron.schedule(postCron, async () => {
        try { await doWeeklyPost(); }
        catch (e) { log.error('Weekly post error:', e); }
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    clearPrioTask = cron.schedule(clearLowPrioCron, async () => {
        try { clearLowPrioAll(); clearHighPrioAll(); }
        catch (e) { log.error('Clear low prio error:', e); }
    });

    reminderTask = cron.schedule(reminderCron, async () => {
        try { await sendReminders(); }
        catch (e) { log.error('Reminder error:', e); }
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    log.info('Scheduled weekly post:', postCron, 'and reminder:', reminderCron);
}

// Sweep yesterday's per-user daily entries (chat earn, daily claim, game
// daily caps) so the persisted state doesn't grow without bound — each entry
// otherwise lingers forever and inflates every state serialize. Runs just
// after the GMT+7 daily reset and once shortly after boot.
function runDailyPrune() {
    let total = 0;
    const tasks = [
        ['currency', () => currency.pruneDaily()],
        ['flashMath', () => flashMath.pruneDaily()],
        ['mathBoss', () => mathBoss.pruneDaily()],
        ['vuaTiengViet', () => vuaTiengViet.pruneDaily()],
        ['wordchainViet', () => wordchainViet.pruneDaily()],
        ['wordReview', () => wordReview.pruneDaily()]
    ];
    for (const [name, fn] of tasks) {
        try { total += fn() || 0; }
        catch (e) { log.error(`dailyPrune: ${name} failed`, e); }
    }
    if (total > 0) log.info(`dailyPrune: removed ${total} stale daily entries`);
    return total;
}

function scheduleDailyPrune() {
    if (dailyPruneTask) return;
    // 00:05 Asia/Ho_Chi_Minh — just after the daily reset (offset +7h).
    dailyPruneTask = cron.schedule('5 0 * * *', () => {
        try { runDailyPrune(); }
        catch (e) { log.error('dailyPrune cron error:', e); }
    }, { timezone: 'Asia/Ho_Chi_Minh' });
    // Catch-up sweep a few seconds after boot (covers downtime over a reset).
    setTimeout(() => { try { runDailyPrune(); } catch (e) { log.error('dailyPrune boot error:', e); } }, 15_000).unref?.();
    log.info('Scheduled daily prune — 00:05 Asia/Ho_Chi_Minh');
}

// Season rollover. `node-cron` can't express "every N weeks", so the cadence
// lives in data.season.endsAt (a timestamp); this daily tick just checks it.
// A boot catch-up covers downtime across a season boundary.
function scheduleSeasonRollover(client) {
    if (seasonTask) return;
    season.ensureState();
    seasonTask = cron.schedule('5 0 * * *', () => {
        season.maybeRollover(client).catch(e => log.error('season rollover cron error', e));
    }, { timezone: 'Asia/Ho_Chi_Minh' });
    setTimeout(() => {
        season.maybeRollover(client).catch(e => log.error('season rollover boot error', e));
    }, 20_000).unref?.();
    log.info('Scheduled season rollover check — 00:05 Asia/Ho_Chi_Minh');
}

// Ngọc bank interest. Pays once per GMT+7 day on min(start-of-day, now) banked
// balance; bank.runDailyInterest() self-guards on the date so the 00:00 cron and
// the boot catch-up (covering downtime across midnight) never double-pay.
function scheduleDailyBankInterest() {
    if (bankInterestTask) return;
    bankInterestTask = cron.schedule('0 0 * * *', () => {
        try { bank.runDailyInterest(); }
        catch (e) { log.error('bank interest cron error:', e); }
    }, { timezone: 'Asia/Ho_Chi_Minh' });
    setTimeout(() => { try { bank.runDailyInterest(); } catch (e) { log.error('bank interest boot error:', e); } }, 20_000).unref?.();
    log.info('Scheduled daily bank interest — 00:00 Asia/Ho_Chi_Minh');
}

function testSendReminders(day, hour, minute) {
    const testCron = `${minute} ${hour} * * ${dayMap[day.toLowerCase()]}`;
    log.info('Testing sendReminders with cron:', testCron);
    const task = cron.schedule(testCron, async () => {
        try {
            task.destroy();
            await sendReminders();
        } catch (e) { log.error('Test Reminder error:', e); }
    }, { timezone: 'Asia/Ho_Chi_Minh' });
}

module.exports = { scheduleWeeklyJobs, scheduleDailyPrune, scheduleSeasonRollover, scheduleDailyBankInterest, runDailyPrune, testSendReminders };
