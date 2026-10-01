const { SlashCommandBuilder, MessageFlags, ChannelType, PermissionFlagsBits } = require('discord.js');
const { data, saveData } = require('../state');
const { isSuperAdmin } = require('../utils');
const { ensureClassEmotes, selectionContent, seedClassReactions } = require('../services/classSelection');

module.exports = {
    data: new SlashCommandBuilder().setName('updateclass')
        .setDescription('Cập nhật tin chọn phái cũ và bổ sung reaction các phái mới')
        .setDMPermission(false)
        .addStringOption(o => o.setName('message_id').setDescription('ID tin chọn phái cũ').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('Kênh chứa tin (mặc định: kênh hiện tại)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread)),
    async execute(interaction) {
        if (!interaction.guild || !(isSuperAdmin(interaction.user.id) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))) {
            return interaction.reply({ content: 'Bạn cần quyền Quản lý máy chủ để cập nhật tin chọn phái.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const messageId = interaction.options.getString('message_id').trim();
        if (!/^\d{17,20}$/.test(messageId)) return interaction.editReply('ID tin nhắn không hợp lệ.');
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        if (channel.guildId !== interaction.guildId || !channel.messages) return interaction.editReply('Vui lòng chọn kênh trong máy chủ này.');
        try {
            const message = await channel.messages.fetch(messageId);
            if (message.author.id !== interaction.client.user.id || !data.classVoteMessages?.includes(messageId)) {
                return interaction.editReply('Tin nhắn này không phải tin chọn phái đã đăng ký của bot.');
            }
            await ensureClassEmotes(interaction.client);
            await message.edit({ content: selectionContent(), allowedMentions: { parse: [] } });
            await seedClassReactions(message);
            saveData();
            return interaction.editReply(`✅ Đã cập nhật [tin chọn phái](${message.url}) và thêm reaction mẫu. Thành viên có thể bấm chọn lại ngay trên tin cũ.`);
        } catch (error) {
            return interaction.editReply(`Không cập nhật được: ${error.message}. Kiểm tra quyền quản lý biểu cảm tại máy chủ emote, quyền đọc lịch sử/thêm reaction/dùng biểu cảm ngoài tại kênh này. Có thể chạy lại lệnh để tiếp tục.`);
        }
    }
};
