const log = require('../../logger');
const { scheduleWeeklyJobs } = require('../services/scheduler');

module.exports = {
    name: 'clientReady',
    once: true,
    execute(client) {
        log.info(`Logged in as ${client.user.tag}`);
        scheduleWeeklyJobs();
    }
};
