const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { isSuperAdmin } = require('../utils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('botdelete')
        .setDescription('Xoá tin nhắn cũ của bot bằng ID (super-admin only)')
        .addStringOption(o => o.setName('message_id').setDescription('ID tin nhắn cần xoá').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('Kênh chứa tin nhắn (default: kênh hiện tại)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.GuildAnnouncement)
            .setRequired(false)),
    async execute(interaction) {
        const fail = reason => ({ content: `Lệnh không thành công vì ${reason}`, flags: MessageFlags.Ephemeral });
        if (!isSuperAdmin(interaction.member.id)) {
            await interaction.reply(fail('chỉ super admin có thể dùng lệnh này'));
            return;
        }
        const messageId = interaction.options.getString('message_id').trim();
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        if (!/^\d{17,20}$/.test(messageId)) {
            await interaction.reply(fail('ID tin nhắn không hợp lệ'));
            return;
        }
        let msg;
        try {
            msg = await channel.messages.fetch(messageId);
        } catch (e) {
            await interaction.reply(fail(`không tìm thấy tin nhắn trong <#${channel.id}>`));
            return;
        }
        if (msg.author.id !== interaction.client.user.id) {
            await interaction.reply(fail('tin nhắn này không phải của bot'));
            return;
        }
        try {
            await msg.delete();
        } catch (e) {
            await interaction.reply(fail(`không xoá được: ${e.message}`));
            return;
        }
        await interaction.reply({ content: `Đã xoá tin nhắn \`${messageId}\` trong <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
    }
};
