const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { data } = require('../state');
const { CLASS_NAMES } = require('../constants');
const { getClassEmoji, getUserDisplayName } = require('../utils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('danhsach')
        .setDescription('Xem danh sách người chơi')
        .addStringOption(option =>
            option
                .setName('class')
                .setDescription('Lọc theo phái')
                .setRequired(false)
                .addChoices(
                    { name: 'Cửu Linh', value: 'Cửu Linh' },
                    { name: 'Huyết Hà', value: 'Huyết Hà' },
                    { name: 'Toái Mộng', value: 'Toái Mộng' },
                    { name: 'Thần Tương', value: 'Thần Tương' },
                    { name: 'Tố Vấn', value: 'Tố Vấn' },
                    { name: 'Thiết Y', value: 'Thiết Y' }
                )
        )
        .addBooleanOption(option =>
            option
                .setName('only_name')
                .setDescription('Chỉ hiển thị tên')
                .setRequired(false)
        ),
    async execute(interaction) {
        const classFilter = interaction.options.getString('class');
        const guildId = interaction.guildId;
        if (!data.participants || !data.participants[guildId]) {
            await interaction.reply({
                content: 'Danh sách bang chiến: (không có ai đăng ký).',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const participants = Object.keys(data.participants[guildId] || {});
        if (participants.length === 0) {
            await interaction.reply({
                content: 'Danh sách bang chiến: (không có ai đăng ký).',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const onlyName = interaction.options.getBoolean('only_name');
        let text;
        if (classFilter) {
            text = `Danh sách ${getClassEmoji(CLASS_NAMES.indexOf(classFilter))} **${classFilter}** tham gia ` + 'bang chiến:\n```';
            let idx = 1;
            for (const uid of participants) {
                const reg = data.registrations[guildId][uid];
                if (classFilter && reg.class !== classFilter) continue;
                const display = `${getUserDisplayName(uid, guildId)}`;
                text += onlyName ? `${display}\n` : `${idx++}. ${display}\n`;
            }
            text += '```';
        } else {
            text = `Danh sách tham gia bang chiến:\n`;
            for (let i = 0; i < CLASS_NAMES.length; i++) {
                text += `${getClassEmoji(i)} **${CLASS_NAMES[i]}**:\`\`\``;
                let idx = 1;
                for (const uid of participants) {
                    const reg = data.registrations[guildId][uid];
                    if (reg.class === CLASS_NAMES[i]) {
                        const display = `${getUserDisplayName(uid, guildId)}`;
                        text += onlyName ? `${display}\n` : `${idx++}. ${display}\n`;
                    }
                }
                text += '```';
            }
        }

        await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    }
};
