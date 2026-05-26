const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { data, saveData } = require('../state');
const { CLASS_NAMES } = require('../constants');
const { isSuperAdmin } = require('../utils');
const { removeUserRole } = require('../services/roles');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('doithongtin')
        .setDescription('Đổi thông tin đăng ký')
        .addUserOption(o =>
            o.setName('user').setDescription('Thành viên').setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('class')
                .setDescription('Phái')
                .setRequired(false)
                .addChoices(
                    { name: 'Cửu Linh', value: 'Cửu Linh' },
                    { name: 'Huyết Hà', value: 'Huyết Hà' },
                    { name: 'Toái Mộng', value: 'Toái Mộng' },
                    { name: 'Thần Tương', value: 'Thần Tương' },
                    { name: 'Tố Vấn', value: 'Tố Vấn' },
                    { name: 'Thiết Y', value: 'Thiết Y' },
                    { name: 'Long Ngâm', value: 'Long Ngâm' }
                )
        )
        .addStringOption(option =>
            option.setName('ingame').setDescription('Tên Ingame').setRequired(false)
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
        const newClass = interaction.options.getString('class');
        const ingameName = interaction.options.getString('ingame');

        if (!user) {
            await interaction.reply({
                content: 'Không tìm thấy thành viên.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (!data.registrations[interaction.guildId] || !data.registrations[interaction.guildId][user.id]) {
            await interaction.reply({
                content: 'Không tìm thấy thông tin đăng ký của thành viên.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (newClass) data.registrations[interaction.guildId][user.id].class = newClass;
        if (ingameName) data.registrations[interaction.guildId][user.id].ingame = ingameName;

        if (newClass && CLASS_NAMES.includes(newClass)) {
            const member = interaction.guild.members.cache.get(user.id);
            if (member) {
                const role = interaction.guild.roles.cache.find(r => r.name === newClass);
                if (role) {
                    await removeUserRole(member, interaction.guild);
                    await member.roles.add(role);
                }
            }
        }
        saveData();

        await interaction.editReply({
            content: 'Đã cập nhật thông tin thành viên.'
        });
    }
};
