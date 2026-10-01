const { MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const lottery = require('./lottery');
const { fmt, renderEmote } = require('./currency');

async function handleComponent(interaction) {
    const reply = content => interaction.reply({ content, flags: MessageFlags.Ephemeral });
    if (!interaction.guildId) return reply('Vui lòng mua vé trong máy chủ.');
    const { min, max, remaining } = lottery.getPurchaseLimit(interaction.guildId, interaction.user.id);
    if (!remaining) return reply(`Bạn đã mua đủ ${lottery.LOTTERY.MAX_TICKETS_PER_DRAW} vé trong đợt này.`);
    if (!max) return reply(`Bạn không đủ ${fmt(lottery.LOTTERY.TICKET_PRICE)} ${renderEmote('ngoc')} để mua 1 vé.`);

    if (interaction.isButton() && interaction.customId === 'lottery:custom') {
        const input = new TextInputBuilder().setCustomId('count')
            .setLabel(`Số vé (${min}–${max})`).setStyle(TextInputStyle.Short)
            .setPlaceholder(`Để trống = 1 · tối đa ${max} vé`).setRequired(false)
            .setMaxLength(String(max).length);
        return interaction.showModal(new ModalBuilder().setCustomId('lottery:buy')
            .setTitle('Bao xổ số tùy chọn')
            .addComponents(new ActionRowBuilder().addComponents(input)));
    }

    let count;
    if (interaction.isButton() && interaction.customId === 'lottery:all') count = max;
    else if (interaction.isModalSubmit() && interaction.customId === 'lottery:buy') {
        const value = interaction.fields.getTextInputValue('count').trim();
        count = value === '' ? 1 : /^\d+$/.test(value) ? Number(value) : NaN;
    } else return reply('Thao tác mua vé không hợp lệ.');

    if (!Number.isSafeInteger(count) || count < min || count > max) {
        return reply(`Vui lòng nhập số nguyên từ ${min} đến ${max}. Giới hạn được tính lại theo số dư và số vé hiện tại.`);
    }
    // No await between the fresh limit check and purchase: another click cannot interleave.
    const result = lottery.buyRandomTickets(interaction.guildId, interaction.user.id, count);
    if (!result.ok) return reply('Không mua được vé. Vui lòng thử lại với số dư và hạn mức hiện tại.');
    const tickets = result.bought.map((t, i) => `${i + 1}. ${lottery.fmtNumbers(t.numbers)}`).join('\n');
    return reply(`✅ Đã mua **${result.bought.length} vé** với **${fmt(result.bought.length * lottery.LOTTERY.TICKET_PRICE)}** ${renderEmote('ngoc')}.\n${tickets}\nBạn có **${result.newCount}/${lottery.LOTTERY.MAX_TICKETS_PER_DRAW} vé** trong đợt này.`);
}

module.exports = { handleComponent };
