const { Events, MessageFlags } = require('discord.js');
const log = require('../../logger');
const wordchain = require('../services/wordchain');

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        if (interaction.isButton()) {
            try {
                await wordchain.handleButtonInteraction(interaction);
            } catch (e) {
                log.error('Error in button interaction:', e);
            }
            return;
        }
        if (!interaction.isChatInputCommand()) return;
        const cmd = interaction.client.commands.get(interaction.commandName);
        if (!cmd) {
            log.warn(`Unknown slash command: ${interaction.commandName}`);
            return;
        }
        try {
            await cmd.execute(interaction);
        } catch (e) {
            log.error(`Error in command ${interaction.commandName}:`, e);
            const errorReply = { content: 'Lệnh gặp lỗi.', flags: MessageFlags.Ephemeral };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(errorReply).catch(() => { });
            } else {
                await interaction.reply(errorReply).catch(() => { });
            }
        }
    }
};
