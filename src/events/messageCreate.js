const { Events, ChannelType } = require('discord.js');
const { handleMessageCommand } = require('../messageCommands');
const wordchain = require('../services/wordchain');
const wordchainEng = require('../services/wordchainEng');
const wordchainViet = require('../services/wordchainViet');
const vuaTiengViet = require('../services/vuaTiengViet');
const flashMath = require('../services/flashMath');
const mathBoss = require('../services/mathBoss');
const { tryEarnFromChat } = require('../services/currency');
const { isBlockedByMaintenance } = require('../services/maintenance');

module.exports = {
    name: Events.MessageCreate,
    async execute(msg) {
        if (msg.author.bot) return;
        if (msg.channel.type === ChannelType.DM) return;
        const blocked = isBlockedByMaintenance(msg.author.id, msg.guild);
        if (!blocked && msg.guildId) tryEarnFromChat(msg.guildId, msg.author.id);
        if (!blocked && msg.channel.isThread && msg.channel.isThread()) {
            if (wordchain.hasThread(msg.channel.id)) {
                await wordchain.handleThreadMessage(msg);
                return;
            }
            if (wordchainEng.hasThread(msg.channel.id)) {
                await wordchainEng.handleThreadMessage(msg);
                return;
            }
            if (wordchainViet.hasThread(msg.channel.id)) {
                await wordchainViet.handleThreadMessage(msg);
                return;
            }
            if (vuaTiengViet.hasThread(msg.channel.id)) {
                await vuaTiengViet.handleThreadMessage(msg);
                return;
            }
            if (flashMath.hasThread(msg.channel.id)) {
                await flashMath.handleThreadMessage(msg);
                return;
            }
            if (mathBoss.hasThread(msg.channel.id)) {
                await mathBoss.handleThreadMessage(msg);
                return;
            }
        }
        await handleMessageCommand(msg);
    }
};
