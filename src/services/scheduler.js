const cron = require('node-cron');
const log = require('../../logger');
const { data } = require('../state');
const { dayMap } = require('../constants');
const { doWeeklyPost, sendReminders } = require('./guildWar');
const { clearLowPrioAll, clearHighPrioAll } = require('./priority');

let weeklyTask = null;
let clearPrioTask = null;
let reminderTask = null;

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

module.exports = { scheduleWeeklyJobs, testSendReminders };
