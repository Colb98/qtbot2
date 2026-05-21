const { Events, MessageFlags, ActionRowBuilder, ButtonBuilder, AttachmentBuilder } = require('discord.js');
const path = require('path');
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
                    const actionPart = interaction.customId.split('_')[2];
                    const action = actionPart.split(':')[0];
                    const userId = parts[1];

                    if (interaction.user.id !== userId) {
                        return interaction.reply({ content: 'Không phải lượt của bạn.', flags: MessageFlags.Ephemeral });
                    }

                    await interaction.deferUpdate().catch(e => log.error('defer error:', e));

                    const disabledRow = new ActionRowBuilder();
                    if (interaction.message.components[0]) {
                        for (const btn of interaction.message.components[0].components) {
                            const newBtn = ButtonBuilder.from(btn.toJSON());
                            newBtn.setDisabled(true);
                            disabledRow.addComponents(newBtn);
                        }
                    }

                    if (action === 'cancel') {
                        return interaction.editReply({ content: '❌ Đã huỷ gacha all.', components: [disabledRow] });
                    }

                    if (action === 'confirm') {
                        try {
                            const guildId = interaction.guildId;
                            const member = await interaction.guild.members.fetch(userId);
                            const w = getWallet(guildId, userId);
                            const n = Math.floor(w.ngoc / ROLL_COST);
                            if (n <= 0) {
                                return interaction.editReply({ content: '❌ Không đủ ngọc để quay.', components: [disabledRow] });
                            }
                            const cost = n * ROLL_COST;
                            addNgoc(guildId, userId, -cost);

                            // Disable buttons on the confirm message
                            await interaction.editReply({ components: [disabledRow] });

                            // Send shake message as a new follow-up
                            let shakeMsg;
                            const shakeEmoteId = data.ingameEmoteIds && data.ingameEmoteIds.shake_tt;
                            if (shakeEmoteId) {
                                shakeMsg = await interaction.followUp({ content: renderEmote('shake_tt').repeat(Math.min(n, 5)) });
                            } else {
                                const gifPath = path.resolve('emotes/ingame/shake_tt.gif');
                                shakeMsg = await interaction.followUp({ files: [new AttachmentBuilder(gifPath)] });
                            }

                            await new Promise(r => setTimeout(r, 2000));

                            const wallet = getWallet(guildId, userId);
                            const counts = rollMany(n, wallet.pity);
                            for (const k of ITEM_KEYS) {
                                if (counts[k] > 0) addItem(guildId, userId, k, counts[k]);
                            }
                            saveData();
                            const result = formatRollResult(counts);
                            await shakeMsg.edit({ content: `**${member.displayName}** quay ${fmt(n)} lần (-${fmt(cost)} ${renderEmote('ngoc')}):\n${result}`, attachments: [] }).catch(e => log.error('gacha edit error', e));
                        } catch (e) {
                            log.error('gacha_all confirm error:', e);
                        }
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
