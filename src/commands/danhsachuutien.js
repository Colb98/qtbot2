const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { data } = require('../state');
const { getUserDisplayName } = require('../utils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('danhsachuutien')
        .setDescription('Xem danh sách ưu tiên'),
    async execute(interaction) {
        const guildId = interaction.guildId;
        if (!data.highPrio || !data.highPrio[guildId]) {
            data.highPrio = data.highPrio || {};
            data.highPrio[guildId] = {};
        }

        const highPrio = Object.keys(data.highPrio[guildId] || {});
        if (highPrio.length === 0) {
            await interaction.reply({
                content: 'Danh sách ưu tiên cao: (không có ai).',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        let text = `Danh sách ưu tiên cao:\n`;
        let idx = 1;
        for (const uid of highPrio) {
            text += `${idx++}. ${getUserDisplayName(uid, guildId)}\n`;
        }

        await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    }
};
