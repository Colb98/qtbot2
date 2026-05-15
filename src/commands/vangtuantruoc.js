const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { data } = require('../state');
const { getUserDisplayName } = require('../utils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('vangtuantruoc')
        .setDescription('Xem danh sách vắng (giảm ưu tiên) tuần trước'),
    async execute(interaction) {
        const guildId = interaction.guildId;
        if (!data.lowPrio || !data.lowPrio[guildId]) {
            data.lowPrio = data.lowPrio || {};
            data.lowPrio[guildId] = {};
        }

        const lowPrio = Object.keys(data.lowPrio[guildId] || {});
        if (lowPrio.length === 0) {
            await interaction.reply({
                content: 'Danh sách ưu tiên thấp: (không có ai).',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        let text = `Danh sách ưu tiên thấp:\n`;
        let idx = 1;
        for (const uid of lowPrio) {
            text += `${idx++}. ${getUserDisplayName(uid, guildId)}\n`;
        }

        await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    }
};
