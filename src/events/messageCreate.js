const { Events, ChannelType } = require('discord.js');
const { handleMessageCommand } = require('../messageCommands');

module.exports = {
    name: Events.MessageCreate,
    async execute(msg) {
        if (msg.author.bot) return;
        if (msg.channel.type === ChannelType.DM) return;
        await handleMessageCommand(msg);
    }
};
