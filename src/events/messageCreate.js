const { Events, ChannelType } = require('discord.js');
const { handleMessageCommand } = require('../messageCommands');
const wordchain = require('../services/wordchain');
const { tryEarnFromChat } = require('../services/currency');
const { isMaintenance } = require('../services/maintenance');

module.exports = {
    name: Events.MessageCreate,
    async execute(msg) {
        if (msg.author.bot) return;
        if (msg.channel.type === ChannelType.DM) return;
        const maint = isMaintenance();
        if (!maint && msg.guildId) tryEarnFromChat(msg.guildId, msg.author.id);
        if (!maint && msg.channel.isThread && msg.channel.isThread() && wordchain.hasThread(msg.channel.id)) {
            await wordchain.handleThreadMessage(msg);
            return;
        }
        await handleMessageCommand(msg);
    }
};
