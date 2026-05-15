const { SlashCommandBuilder } = require('discord.js');

const SIDES = ['Sấp', 'Ngửa'];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('coinflip')
        .setDescription('Tung đồng xu, đoán Sấp (0) hoặc Ngửa (1)')
        .addIntegerOption(o =>
            o.setName('guess')
                .setDescription('Đoán: 0 = Sấp, 1 = Ngửa')
                .setRequired(true)
                .addChoices(
                    { name: '0 - Sấp', value: 0 },
                    { name: '1 - Ngửa', value: 1 }
                )
        ),
    async execute(interaction) {
        const guess = interaction.options.getInteger('guess');
        const result = Math.random() < 0.5 ? 0 : 1;
        const won = guess === result;
        await interaction.reply(
            `🪙 Kết quả: **${SIDES[result]}** (${result})\n` +
            `Bạn đoán: **${SIDES[guess]}** (${guess})\n` +
            (won ? '🎉 Bạn thắng!' : '😢 Bạn thua!')
        );
    }
};
