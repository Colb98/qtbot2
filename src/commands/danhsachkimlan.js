const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { canManageKimlan } = require('../utils');
const kimlan = require('../services/kimlan');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('danhsachkimlan')
        .setDescription('Liệt kê tất cả kim lan trong server'),
    async execute(interaction) {
        if (!canManageKimlan(interaction)) {
            await interaction.reply({ content: 'Lệnh không thành công vì bạn không có quyền quản lý kim lan', flags: MessageFlags.Ephemeral });
            return;
        }
        const groups = kimlan.listGroups(interaction.guildId);
        if (groups.length === 0) {
            await interaction.reply({ content: 'Chưa có kim lan nào.', flags: MessageFlags.Ephemeral });
            return;
        }
        groups.sort((a, b) => b.members.length - a.members.length);
        let content = `Có ${groups.length} kim lan:\n\`\`\`\n`;
        for (const g of groups) content += `${g.name} (${g.members.length})\n`;
        content += '```';
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
};
