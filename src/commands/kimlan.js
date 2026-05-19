const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { canManageKimlan, sanitizeKimlanName, getUserDisplayName } = require('../utils');
const kimlan = require('../services/kimlan');

const builder = new SlashCommandBuilder()
    .setName('kimlan')
    .setDescription('Thêm thành viên vào kim lan')
    .addStringOption(o => o.setName('name').setDescription('Tên kim lan').setRequired(true))
    .addUserOption(o => o.setName('user1').setDescription('Thành viên 1').setRequired(true));
for (let i = 2; i <= 12; i++) {
    builder.addUserOption(o => o.setName(`user${i}`).setDescription(`Thành viên ${i}`).setRequired(false));
}

module.exports = {
    data: builder,
    async execute(interaction) {
        const fail = reason => ({ content: `Lệnh không thành công vì ${reason}`, flags: MessageFlags.Ephemeral });
        if (!canManageKimlan(interaction)) {
            await interaction.reply(fail('bạn không có quyền quản lý kim lan'));
            return;
        }
        let name;
        try { name = sanitizeKimlanName(interaction.options.getString('name')); }
        catch (e) { await interaction.reply(fail(e.message)); return; }

        const users = [];
        for (let i = 1; i <= 12; i++) {
            const u = interaction.options.getUser(`user${i}`);
            if (u) users.push(u.id);
        }
        if (users.length === 0) { await interaction.reply(fail('phải có ít nhất 1 thành viên')); return; }

        const result = kimlan.addMembers(interaction.guildId, name, users);
        const addedNames = result.added.map(uid => getUserDisplayName(uid, interaction.guildId));
        const lines = [`Kim lan **${result.groupName}** (${result.currentMembers.length} thành viên)`];
        if (result.added.length === 0) {
            lines.push('Tất cả đã có trong kim lan, không thêm ai.');
        } else {
            lines.push(`Đã thêm ${result.added.length} thành viên: ${addedNames.join(', ')}`);
        }
        await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    }
};
