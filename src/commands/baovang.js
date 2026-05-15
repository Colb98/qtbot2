const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { data, saveData } = require('../state');
const { isSuperAdmin } = require('../utils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('baovang')
        .setDescription('Báo thành viên đã đăng ký nhưng vắng mặt')
        .addUserOption(o =>
            o.setName('user1').setDescription('Thành viên vắng').setRequired(true)
        )
        .addUserOption(o =>
            o.setName('user2').setDescription('Thành viên vắng').setRequired(false)
        )
        .addUserOption(o =>
            o.setName('user3').setDescription('Thành viên vắng').setRequired(false)
        ),
    async execute(interaction) {
        const fail = reason => ({
            content: `Lệnh không thành công vì ${reason}`,
            flags: MessageFlags.Ephemeral
        });
        if (interaction.member.id !== interaction.guild.ownerId && !isSuperAdmin(interaction.member.id)) {
            await interaction.reply(fail('chỉ người sở hữu máy chủ mới có thể báo vắng'));
            return;
        }
        const users = [
            interaction.options.getUser('user1'),
            interaction.options.getUser('user2'),
            interaction.options.getUser('user3')
        ].filter(Boolean);

        const list = [];
        for (const user of users) {
            if (data.participants[interaction.guildId][user.id]) {
                list.push(user.id);
            }
        }
        if (list.length === 0) {
            await interaction.reply(fail('không tìm thấy thành viên hợp lệ'));
            return;
        }
        if (!data.lowPrio || !data.lowPrio[interaction.guildId]) {
            data.lowPrio = data.lowPrio || {};
            data.lowPrio[interaction.guildId] = {};
        }
        for (const userId of list) {
            data.lowPrio[interaction.guildId][userId] = true;
        }
        await interaction.reply({
            content: 'Đã báo thành công.',
            flags: MessageFlags.Ephemeral
        });
        saveData();
    }
};
