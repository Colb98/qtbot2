const { Events, MessageFlags, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const log = require('../../logger');
const wordchain = require('../services/wordchain');
const arrangeCmd = require('../commands/arrange');
const { getWallet, addNgoc, addItem, renderEmote, fmt, ITEM_KEYS } = require('../services/currency');
const { rollMany, formatRollResult, ROLL_COST } = require('../services/gacha');
const { data, saveData } = require('../state');

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        if (interaction.isButton()) {
            try {
                if (interaction.customId.startsWith('arrange_')) {
                    await arrangeCmd.handleButton(interaction);
                } else if (interaction.customId.startsWith('gacha_all_')) {
                    const parts = interaction.customId.split(':');
                    const action = interaction.customId.split('_')[2];
                    const userId = parts[1];
                    if (interaction.user.id !== userId) {
                        return interaction.reply({ content: 'Không phải lượt của bạn.', flags: MessageFlags.Ephemeral });
                    }
                    const disabledRow = new ActionRowBuilder();
                    if (interaction.message.components[0]) {
                        for (const btn of interaction.message.components[0].components) {
                            const newBtn = ButtonBuilder.from(btn.toJSON());
                            newBtn.setDisabled(true);
                            disabledRow.addComponents(newBtn);
                        }
                    }
                    if (action === 'cancel') {
                        return interaction.update({ content: '❌ Đã huỷ gacha all.', components: [disabledRow] });
                    }
                    if (action === 'confirm') {
                        const guildId = interaction.guildId;
                        const member = await interaction.guild.members.fetch(userId);
                        const w = getWallet(guildId, userId);
                        const n = Math.floor(w.ngoc / ROLL_COST);
                        if (n <= 0) {
                            return interaction.update({ content: '❌ Không đủ ngọc để quay.', components: [disabledRow] });
                        }
                        const cost = n * ROLL_COST;
                        addNgoc(guildId, userId, -cost);
                        const wallet = getWallet(guildId, userId);
                        const counts = rollMany(n, wallet.pity);
                        for (const k of ITEM_KEYS) {
                            if (counts[k] > 0) addItem(guildId, userId, k, counts[k]);
                        }
                        saveData();
                        const result = formatRollResult(counts);
                        return interaction.update({
                            content: `**${member.displayName}** quay ${fmt(n)} lần (-${fmt(cost)} ${renderEmote('ngoc')}):\n${result}`,
                            components: [disabledRow]
                        });
                    }
                } else {
                    await wordchain.handleButtonInteraction(interaction);
                }
            } catch (e) {
                log.error('Error in button interaction:', e);
            }
            return;
        }
        if (!interaction.isChatInputCommand()) return;
        const cmd = interaction.client.commands.get(interaction.commandName);
        if (!cmd) {
            log.warn(`Unknown slash command: ${interaction.commandName}`);
            return;
        }
        try {
            await cmd.execute(interaction);
        } catch (e) {
            log.error(`Error in command ${interaction.commandName}:`, e);
            const errorReply = { content: 'Lệnh gặp lỗi.', flags: MessageFlags.Ephemeral };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(errorReply).catch(() => { });
            } else {
                await interaction.reply(errorReply).catch(() => { });
            }
        }
    }
};
