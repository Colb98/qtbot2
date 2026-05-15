const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { data } = require('../state');
const { getUserDisplayName } = require('../utils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('danhsachvang')
        .setDescription('Xem danh sách đăng ký vắng mặt'),
    async execute(interaction) {
        const guildId = interaction.guildId;
        if (!data.absents || !data.absents[guildId]) {
            await interaction.reply({
                content: 'Danh sách vắng mặt: (không có ai vắng mặt).',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const absents = Object.keys(data.absents[guildId] || {});
        if (absents.length === 0) {
            await interaction.reply({
                content: 'Danh sách vắng mặt: (không có ai vắng mặt).',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        let text = `Danh sách vắng mặt:\n`;
        let idx = 1;
        for (const uid of absents) {
            text += `${idx++}. ${getUserDisplayName(uid, guildId)}\n`;
        }

        await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    }
};
