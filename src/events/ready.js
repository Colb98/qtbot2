const log = require('../../logger');
const { scheduleWeeklyJobs } = require('../services/scheduler');
const { data } = require('../state');
const { retroactiveGrantAll } = require('../services/bangChienReward');
const { scheduleWeeklyPayout } = require('../services/wordchainEng');
const { scheduleWeeklyPayout: scheduleVtvPayout } = require('../services/vuaTiengViet');

module.exports = {
    name: 'clientReady',
    once: true,
    execute(client) {
        log.info(`Logged in as ${client.user.tag}`);
        scheduleWeeklyJobs();
        scheduleWeeklyPayout();
        scheduleVtvPayout();
        const lastPosts = data.lastPostMessageId || {};
        for (const guildId of Object.keys(lastPosts)) {
            const granted = retroactiveGrantAll(guildId);
            if (granted > 0) log.info(`Retroactively granted bang chiến ngọc to ${granted} users in guild ${guildId}`);
        }
    }
};
