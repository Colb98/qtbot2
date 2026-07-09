const log = require('../../logger');
const { scheduleWeeklyJobs, scheduleDailyPrune, scheduleDailyBankInterest } = require('../services/scheduler');
const { data } = require('../state');
const { retroactiveGrantAll } = require('../services/bangChienReward');
const { scheduleWeeklyPayout } = require('../services/wordchainEng');
const { scheduleWeeklyPayout: scheduleVtvPayout } = require('../services/vuaTiengViet');
const { scheduleWeeklyPayout: scheduleFlashMathPayout } = require('../services/flashMath');
const { scheduleWeeklyPayout: scheduleNoituPayout } = require('../services/wordchainViet');
const { scheduleDraws: scheduleLotteryDraws } = require('../services/lottery');

module.exports = {
    name: 'clientReady',
    once: true,
    execute(client) {
        log.info(`Logged in as ${client.user.tag}`);
        scheduleWeeklyJobs();
        scheduleDailyPrune();
        // Auto season rollover is intentionally OFF — seasons advance manually
        // via !server_reset (see season.js maybeRollover). The countdown still
        // displays; it just never triggers a rollover on its own.
        // scheduleSeasonRollover(client);
        scheduleDailyBankInterest();
        scheduleWeeklyPayout();
        scheduleVtvPayout();
        scheduleFlashMathPayout();
        scheduleNoituPayout();
        scheduleLotteryDraws();
        const lastPosts = data.lastPostMessageId || {};
        for (const guildId of Object.keys(lastPosts)) {
            const granted = retroactiveGrantAll(guildId);
            if (granted > 0) log.info(`Retroactively granted bang chiến ngọc to ${granted} users in guild ${guildId}`);
        }
    }
};
