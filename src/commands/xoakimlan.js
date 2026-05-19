const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { canManageKimlan, sanitizeKimlanName } = require('../utils');
const kimlan = require('../services/kimlan');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('xoakimlan')
        .setDescription('Xoá kim lan')
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

        const ok = kimlan.deleteGroup(interaction.guildId, name);
        if (!ok) { await interaction.reply(fail(`kim lan **${name}** không tồn tại`)); return; }
        await interaction.reply({ content: `Đã xoá kim lan **${name}**.`, flags: MessageFlags.Ephemeral });
    }
};
