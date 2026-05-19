const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isSuperAdmin, isOwner, getUserDisplayName } = require('../utils');
const kimlan = require('../services/kimlan');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('kimlanmod')
        .setDescription('Quản lý kim lan moderator')
        .addStringOption(o =>
            o.setName('action').setDescription('Hành động').setRequired(true).addChoices(
                { name: 'add', value: 'add' },
                { name: 'remove', value: 'remove' },
                { name: 'list', value: 'list' }
            ))
        .addUserOption(o => o.setName('user').setDescription('Thành viên (cho add/remove)').setRequired(false)),
    async execute(interaction) {
        const fail = reason => ({ content: `Lệnh không thành công vì ${reason}`, flags: MessageFlags.Ephemeral });
        if (!isOwner(interaction) && !isSuperAdmin(interaction.member.id)) {
            await interaction.reply(fail('chỉ chủ máy chủ hoặc super admin có thể dùng lệnh này'));
            return;
        }
        const action = interaction.options.getString('action');
        const user = interaction.options.getUser('user');
        const guildId = interaction.guildId;

        if (action === 'list') {
            const mods = kimlan.listMods(guildId);
            if (mods.length === 0) {
                await interaction.reply({ content: 'Chưa có kim lan moderator nào.', flags: MessageFlags.Ephemeral });
                return;
            }
            let content = `Có ${mods.length} kim lan moderator:\n\`\`\`\n`;
            for (let i = 0; i < mods.length; i++) {
                content += `${i + 1}. ${getUserDisplayName(mods[i], guildId)}\n`;
            }
            content += '```';
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
            return;
        }

        if (!user) { await interaction.reply(fail('cần chọn thành viên cho hành động này')); return; }

        if (action === 'add') {
            const added = kimlan.addMod(guildId, user.id);
            await interaction.reply({
                content: added
                    ? `Đã cấp quyền kim lan moderator cho ${getUserDisplayName(user.id, guildId)}.`
                    : `${getUserDisplayName(user.id, guildId)} đã là kim lan moderator.`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (action === 'remove') {
            const removed = kimlan.removeMod(guildId, user.id);
            await interaction.reply({
                content: removed
                    ? `Đã xoá quyền kim lan moderator của ${getUserDisplayName(user.id, guildId)}.`
                    : `${getUserDisplayName(user.id, guildId)} không phải kim lan moderator.`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }
    }
};
