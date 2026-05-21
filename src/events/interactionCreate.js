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
                    log.info(`gacha_all button: action=${action}, userId=${userId}, clickerId=${interaction.user.id}`);

                    if (interaction.user.id !== userId) {
                        return interaction.reply({ content: 'Không phải lượt của bạn.', flags: MessageFlags.Ephemeral });
                    }

                    // Defer immediately to prevent timeout
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
                        log.info('gacha_all: cancel clicked');
                        return interaction.editReply({ content: '❌ Đã huỷ gacha all.', components: [disabledRow] });
                    }

                    if (action === 'confirm') {
                        try {
                            log.info('gacha_all: confirm clicked, starting roll');
                            const guildId = interaction.guildId;
                            log.info(`gacha_all: guildId=${guildId}`);

                            log.info('gacha_all: fetching member');
                            const member = await interaction.guild.members.fetch(userId);
                            log.info(`gacha_all: member=${member.displayName}`);

                            log.info('gacha_all: getting wallet');
                            const w = getWallet(guildId, userId);
                            log.info(`gacha_all: wallet ngoc=${w.ngoc}, pity=${JSON.stringify(w.pity)}`);

                            const n = Math.floor(w.ngoc / ROLL_COST);
                            log.info(`gacha_all: user has ${w.ngoc} ngoc, can roll ${n} times (ROLL_COST=${ROLL_COST})`);
                            if (n <= 0) {
                                log.info('gacha_all: not enough ngoc, returning');
                                return interaction.editReply({ content: '❌ Không đủ ngọc để quay.', components: [disabledRow] });
                            }

                            const cost = n * ROLL_COST;
                            log.info(`gacha_all: deducting ${cost} ngoc`);
                            addNgoc(guildId, userId, -cost);

                            log.info('gacha_all: getting fresh wallet');
                            const wallet = getWallet(guildId, userId);
                            log.info(`gacha_all: starting rollMany with n=${n}`);

                            const counts = rollMany(n, wallet.pity);
                            log.info(`gacha_all: rollMany done, counts=${JSON.stringify(counts)}`);

                            log.info('gacha_all: adding items');
                            for (const k of ITEM_KEYS) {
                                if (counts[k] > 0) {
                                    log.info(`gacha_all: adding ${counts[k]} ${k}`);
                                    addItem(guildId, userId, k, counts[k]);
                                }
                            }

                            log.info('gacha_all: saving data');
                            saveData();

                            log.info('gacha_all: formatting result');
                            const result = formatRollResult(counts);
                            log.info(`gacha_all: roll complete, result=${result}`);

                            log.info('gacha_all: editReply');
                            const reply = await interaction.editReply({
                                content: `**${member.displayName}** quay ${fmt(n)} lần (-${fmt(cost)} ${renderEmote('ngoc')}):\n${result}`,
                                components: [disabledRow]
                            });
                            log.info('gacha_all: editReply done');
                            return reply;
                        } catch (e) {
                            log.error('gacha_all confirm error:', e);
                            log.error('error stack:', e.stack);
                            try {
                                return interaction.editReply({ content: '❌ Lỗi khi quay gacha: ' + e.message, components: [disabledRow] });
                            } catch (e2) {
                                log.error('error editing reply:', e2);
                            }
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
