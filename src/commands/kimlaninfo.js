const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { canManageKimlan, sanitizeKimlanName, getUserDisplayName } = require('../utils');
const kimlan = require('../services/kimlan');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('kimlaninfo')
        .setDescription('Xem thành viên kim lan')
        .addStringOption(o => o.setName('name').setDescription('Tên kim lan').setRequired(true)),
    async execute(interaction) {
        const fail = reason => ({ content: `Lệnh không thành công vì ${reason}`, flags: MessageFlags.Ephemeral });
        if (!canManageKimlan(interaction)) {
            await interaction.reply(fail('bạn không có quyền quản lý kim lan'));
            return;
        }
        let name;
        try { name = sanitizeKimlanName(interaction.options.getString('name')); }
        catch (e) { await interaction.reply(fail(e.message)); return; }

        const group = kimlan.getGroup(interaction.guildId, name);
        if (!group) { await interaction.reply(fail(`kim lan **${name}** không tồn tại`)); return; }

        let content = `Kim lan **${group.name}** (${group.members.length} thành viên):\n\`\`\`\n`;
        if (group.members.length === 0) content += '(trống)\n';
        else {
            for (let i = 0; i < group.members.length; i++) {
                content += `${i + 1}. ${getUserDisplayName(group.members[i], interaction.guildId)}\n`;
            }
        }
        content += '```';
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
};
