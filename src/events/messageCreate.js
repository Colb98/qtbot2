const { Events, ChannelType } = require('discord.js');
const { handleMessageCommand } = require('../messageCommands');
const wordchain = require('../services/wordchain');

module.exports = {
    name: Events.MessageCreate,
    async execute(msg) {
        if (msg.author.bot) return;
        if (msg.channel.type === ChannelType.DM) return;
        if (msg.channel.isThread && msg.channel.isThread() && wordchain.hasThread(msg.channel.id)) {
            await wordchain.handleThreadMessage(msg);
            return;
        }
        await handleMessageCommand(msg);
    }
};
