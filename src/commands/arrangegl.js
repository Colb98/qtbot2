const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isOwner, isSuperAdmin, getUserDisplayName } = require('../utils');
const arrangePerm = require('../services/arrangePerm');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('arrangegl')
        .setDescription('Quản lý graylist /arrange (DM super-admin khi user dùng lệnh)')
        .addStringOption(o =>
            o.setName('action').setDescription('Hành động').setRequired(true).addChoices(
                { name: 'add', value: 'add' },
                { name: 'remove', value: 'remove' },
                { name: 'list', value: 'list' }
            ))
        .addUserOption(o => o.setName('user').setDescription('User (cho add/remove)').setRequired(false))
        .addRoleOption(o => o.setName('role').setDescription('Role (cho add/remove)').setRequired(false)),
    async execute(interaction) {
        const fail = reason => ({ content: `Lệnh không thành công vì ${reason}`, flags: MessageFlags.Ephemeral });
        if (!isOwner(interaction) && !isSuperAdmin(interaction.member.id)) {
            await interaction.reply(fail('chỉ chủ máy chủ hoặc super admin có thể dùng lệnh này'));
            return;
        }
        const action = interaction.options.getString('action');
        const user = interaction.options.getUser('user');
        const role = interaction.options.getRole('role');
        const guildId = interaction.guildId;

        if (action === 'list') {
            const l = arrangePerm.getList(guildId, 'graylist');
            const lines = [`**Graylist /arrange:**`];
            lines.push(`Users (${l.users.length}):`);
            if (l.users.length === 0) lines.push('  (trống)');
            else for (const uid of l.users) lines.push(`  - ${getUserDisplayName(uid, guildId)} (\`${uid}\`)`);
            lines.push(`Roles (${l.roles.length}):`);
            if (l.roles.length === 0) lines.push('  (trống)');
            else for (const rid of l.roles) lines.push(`  - <@&${rid}>`);
            await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            return;
        }

        if (!user && !role) {
            await interaction.reply(fail('cần chọn user hoặc role cho hành động này'));
            return;
        }
        const op = action === 'add' ? arrangePerm.addEntry : arrangePerm.removeEntry;
        const opVerb = action === 'add' ? 'Thêm' : 'Xoá';
        const opVerbNeg = action === 'add' ? 'đã có' : 'không có';
        const msgs = [];
        if (user) {
            const ok = op(guildId, 'graylist', 'users', user.id);
            msgs.push(ok
                ? `${opVerb} user ${getUserDisplayName(user.id, guildId)} vào graylist.`
                : `User ${getUserDisplayName(user.id, guildId)} ${opVerbNeg} trong graylist.`);
        }
        if (role) {
            const ok = op(guildId, 'graylist', 'roles', role.id);
            msgs.push(ok
                ? `${opVerb} role <@&${role.id}> vào graylist.`
                : `Role <@&${role.id}> ${opVerbNeg} trong graylist.`);
        }
        await interaction.reply({ content: msgs.join('\n'), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
};
