const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getTopScores } = require('../services/wordchain');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('noi_tu_highscore')
        .setDescription('Bảng xếp hạng nối từ (top 10)'),
    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({
                content: 'Lệnh này chỉ dùng trong máy chủ.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }
        const top = getTopScores(interaction.guildId, 10);
        if (top.length === 0) {
            await interaction.reply('Chưa có ai có điểm nối từ.');
            return;
        }
        const lines = top.map(([userId, score], i) =>
            `**${i + 1}.** <@${userId}> — **${score}** điểm`
        );
        await interaction.reply({
            content: `🏆 **Top ${top.length} nối từ**\n${lines.join('\n')}`,
            allowedMentions: { parse: [] }
        });
    }
};
