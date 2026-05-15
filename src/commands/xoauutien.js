const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { data, saveData } = require('../state');
const { isSuperAdmin } = require('../utils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('xoauutien')
        .setDescription('Xoá khỏi danh sách ưu tiên')
        .addUserOption(o =>
            o.setName('user').setDescription('Thành viên').setRequired(true)
        ),
    async execute(interaction) {
        const fail = reason => ({
            content: `Xoá không thành công vì ${reason}`,
            flags: MessageFlags.Ephemeral
        });
        if (interaction.member.id !== interaction.guild.ownerId && !isSuperAdmin(interaction.member.id)) {
            await interaction.reply(fail('chỉ người sở hữu máy chủ mới có thể thay đổi'));
            return;
        }

        const user = interaction.options.getUser('user');
        if (!user) {
            await interaction.reply(fail('không tìm thấy thành viên'));
            return;
        }

        const guildId = interaction.guildId;
        if (!data.highPrio || !data.highPrio[guildId]) {
            await interaction.reply(fail('không tìm thấy danh sách ưu tiên cao'));
            return;
        }

        delete data.highPrio[guildId][user.id];
        await interaction.reply({
            content: 'Đã xoá thành công.',
            flags: MessageFlags.Ephemeral
        });
        saveData();
    }
};
