const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const log = require('../../logger');
const wordchain = require('../services/wordchain');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('noi_tu')
        .setDescription('Bắt đầu trò chơi nối từ trong một thread mới')
        .addStringOption(o =>
            o.setName('mode')
                .setDescription('Chế độ chơi')
                .setRequired(true)
                .addChoices(
                    { name: 'BOT - chơi với bot', value: 'BOT' },
                    { name: 'PVP - chơi với người khác', value: 'PVP' }
                )
        )
        .addIntegerOption(o =>
            o.setName('time')
                .setDescription('Thời gian chờ mỗi lượt (phút). Mặc định 5.')
                .setMinValue(1)
                .setMaxValue(60)
                .setRequired(false)
        ),
    async execute(interaction) {
        const mode = interaction.options.getString('mode');
        const timeoutMinutes = interaction.options.getInteger('time') ?? 5;

        if (interaction.channel.type !== ChannelType.GuildText) {
            await interaction.reply({
                content: 'Lệnh này chỉ dùng được trong kênh text của máy chủ (không dùng trong thread hoặc DM).',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const thread = await wordchain.startSession({
                channel: interaction.channel,
                invokerId: interaction.user.id,
                mode,
                timeoutMinutes
            });
            await interaction.editReply(`Đã tạo thread nối từ: <#${thread.id}>`);
        } catch (e) {
            log.error('noi_tu: startSession failed', e);
            await interaction.editReply('Không thể bắt đầu trò chơi. Vui lòng thử lại.');
        }
    }
};
