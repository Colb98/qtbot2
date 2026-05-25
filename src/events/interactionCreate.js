const { Events, MessageFlags, ActionRowBuilder, ButtonBuilder, AttachmentBuilder } = require('discord.js');
const path = require('path');
const log = require('../../logger');
const wordchain = require('../services/wordchain');
const wordchainEng = require('../services/wordchainEng');
const vuaTiengViet = require('../services/vuaTiengViet');
const arrangeCmd = require('../commands/arrange');
const { getWallet, addNgoc, addItem, renderEmote, fmt, ITEM_KEYS, ITEM_LABELS } = require('../services/currency');
const { rollMany, formatRollResult, ROLL_COST } = require('../services/gacha');
const { buildContinueButtons: buildCoinflipButtons, formatResult: formatCoinflipResult, tokenToSide } = require('../services/coinflip');
const { SYMBOLS: SLOT_SYMBOLS, playSlot, formatResultLine: formatSlotResultLine, buildContinueButtons: buildSlotContinueButtons } = require('../services/slot');
const dice = require('../services/dice');
const metrics = require('../services/metrics');
const economy = require('../config/economy');
const { data, saveData } = require('../state');
const { isMaintenance } = require('../services/maintenance');

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        if (isMaintenance()) {
            if (interaction.isRepliable && interaction.isRepliable()) {
                await interaction.reply({ content: '🔧 Bot đang bảo trì, vui lòng thử lại sau ít phút.', flags: MessageFlags.Ephemeral }).catch(() => {});
            }
            return;
        }
        if (interaction.isButton()) {
            try {
                if (interaction.customId.startsWith('arrange_')) {
                    await arrangeCmd.handleButton(interaction);
                } else if (interaction.customId.startsWith('cf:')) {
                    await handleCoinflipButton(interaction);
                } else if (interaction.customId.startsWith('tong:')) {
                    await handleDiceButton(interaction, 'tong');
                } else if (interaction.customId.startsWith('mat:')) {
                    await handleDiceButton(interaction, 'mat');
                } else if (interaction.customId.startsWith('slot:')) {
                    await handleSlotButton(interaction);
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
                            const gachaMeta = {};
                            const counts = rollMany(n, wallet.pity, gachaMeta);
                            for (const k of ITEM_KEYS) {
                                if (counts[k] > 0) addItem(guildId, userId, k, counts[k]);
                            }
                            saveData();
                            metrics.recordGacha({ guildId, rolls: n, cost, counts, userId, ...gachaMeta });
                            const result = formatRollResult(counts);
                            await shakeMsg.edit({ content: `**${member.displayName}** quay ${fmt(n)} lần (-${fmt(cost)} ${renderEmote('ngoc')}):\n${result}`, attachments: [] }).catch(e => log.error('gacha edit error', e));
                        } catch (e) {
                            log.error('gacha_all confirm error:', e);
                        }
                    }
                } else if (interaction.customId.startsWith('wce_')) {
                    await wordchainEng.handleButtonInteraction(interaction);
                } else if (interaction.customId.startsWith('vtv_')) {
                    await vuaTiengViet.handleButtonInteraction(interaction);
                } else if (interaction.customId.startsWith('khodo:')) {
                    await handleKhodoButton(interaction);
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

async function handleCoinflipButton(interaction) {
    const [, action, ownerUserId, amountStr, sideToken] = interaction.customId.split(':');
    if (interaction.user.id !== ownerUserId) {
        return interaction.reply({ content: 'Đây không phải lượt của bạn.', flags: MessageFlags.Ephemeral });
    }
    const side = tokenToSide(sideToken);
    const guildId = interaction.guildId;
    const wallet = getWallet(guildId, ownerUserId);

    let amount;
    if (action === 'allin') {
        amount = Math.min(wallet.ngoc, economy.COINFLIP_MAX_BET);
    } else {
        amount = Math.min(parseInt(amountStr, 10), economy.COINFLIP_MAX_BET);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
        return interaction.reply({ content: 'Bạn không có ngọc để chơi.', flags: MessageFlags.Ephemeral });
    }
    if (wallet.ngoc < amount) {
        return interaction.reply({ content: `Bạn chỉ có ${fmt(wallet.ngoc)} ngọc, không đủ cược ${fmt(amount)}.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate().catch(e => log.error('cf defer error:', e));

    const disabledRow = new ActionRowBuilder();
    if (interaction.message.components[0]) {
        for (const btn of interaction.message.components[0].components) {
            const newBtn = ButtonBuilder.from(btn.toJSON());
            newBtn.setDisabled(true);
            disabledRow.addComponents(newBtn);
        }
        await interaction.editReply({ components: [disabledRow] }).catch(e => log.error('cf disable error:', e));
    }

    const result = Math.random() < 0.5 ? 'sap' : 'ngua';
    const won = side ? (side === result) : (Math.random() < 0.5);
    addNgoc(guildId, ownerUserId, won ? amount : -amount);

    const wasAllIn = action === 'allin';
    const bigWin = won && (wasAllIn || amount >= 5000);
    metrics.recordCoinflip({ guildId, amount, won, side, viaButton: true, wasAllIn, bigWin, userId: ownerUserId });

    const member = await interaction.guild.members.fetch(ownerUserId).catch(() => null);
    const displayName = member ? member.displayName : interaction.user.username;
    const newWallet = getWallet(guildId, ownerUserId);
    const content = formatCoinflipResult({ displayName, side, result, won, amount, wasAllIn });
    const components = newWallet.ngoc > 0 ? [buildCoinflipButtons(ownerUserId, amount, side, newWallet.ngoc)] : [];
    await interaction.followUp({ content, components }).catch(e => log.error('cf followUp error:', e));
}

async function handleDiceButton(interaction, game) {
    const [, action, ownerUserId, amountStr, guessStr] = interaction.customId.split(':');
    if (interaction.user.id !== ownerUserId) {
        return interaction.reply({ content: 'Đây không phải lượt của bạn.', flags: MessageFlags.Ephemeral });
    }
    const guess = parseInt(guessStr, 10);
    const guildId = interaction.guildId;
    const wallet = getWallet(guildId, ownerUserId);
    const maxBet = game === 'tong' ? economy.TONG_MAX_BET : economy.MAT_MAX_BET;

    let amount;
    if (action === 'allin') {
        amount = Math.min(wallet.ngoc, maxBet);
    } else {
        amount = Math.min(parseInt(amountStr, 10), maxBet);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
        return interaction.reply({ content: 'Bạn không có ngọc để chơi.', flags: MessageFlags.Ephemeral });
    }
    if (wallet.ngoc < amount) {
        return interaction.reply({ content: `Bạn chỉ có ${fmt(wallet.ngoc)} ngọc, không đủ cược ${fmt(amount)}.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate().catch(e => log.error('dice defer error:', e));

    const disabledRows = (interaction.message.components || []).map(rowComp => {
        const ar = new ActionRowBuilder();
        for (const btn of rowComp.components) {
            ar.addComponents(ButtonBuilder.from(btn.toJSON()).setDisabled(true));
        }
        return ar;
    });
    if (disabledRows.length) {
        await interaction.editReply({ components: disabledRows }).catch(e => log.error('dice disable error:', e));
    }

    const roll = dice.rollDice();
    const member = await interaction.guild.members.fetch(ownerUserId).catch(() => null);
    const displayName = member ? member.displayName : interaction.user.username;

    let content;
    let components;
    const wasAllIn = action === 'allin';
    if (game === 'tong') {
        const { sum, won, mult } = dice.playTong(roll, guess);
        addNgoc(guildId, ownerUserId, won ? amount * (mult - 1) : -amount);
        metrics.recordTong({ guildId, amount, won, mult, guess, viaButton: true, wasAllIn, userId: ownerUserId });
        const newWallet = getWallet(guildId, ownerUserId);
        content = dice.formatTongResult({ displayName, guess, roll, sum, won, amount, mult });
        components = newWallet.ngoc > 0 ? dice.buildTongButtons(ownerUserId, amount, guess, newWallet.ngoc) : [];
    } else {
        const { matches, won, mult } = dice.playMat(roll, guess);
        addNgoc(guildId, ownerUserId, won ? amount * (mult - 1) : -amount);
        metrics.recordMat({ guildId, amount, won, mult, face: guess, matches, viaButton: true, wasAllIn, userId: ownerUserId });
        const newWallet = getWallet(guildId, ownerUserId);
        content = dice.formatMatResult({ displayName, face: guess, roll, matches, won, amount, mult });
        components = newWallet.ngoc > 0 ? dice.buildMatButtons(ownerUserId, amount, guess, newWallet.ngoc) : [];
    }

    await interaction.followUp({ content, components }).catch(e => log.error('dice followUp error:', e));
}

async function handleSlotButton(interaction) {
    const [, action, ownerUserId, amountStr] = interaction.customId.split(':');
    if (interaction.user.id !== ownerUserId) {
        return interaction.reply({ content: 'Đây không phải lượt của bạn.', flags: MessageFlags.Ephemeral });
    }

    const guildId = interaction.guildId;
    const isAllIn = action === 'allin';
    const requestedAmount = isAllIn ? null : parseInt(amountStr, 10);
    if (!isAllIn && (!Number.isInteger(requestedAmount) || requestedAmount <= 0)) {
        return interaction.reply({ content: 'Số ngọc không hợp lệ.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate().catch(e => log.error('slot defer error:', e));

    const disabledRows = (interaction.message.components || []).map(rowComp => {
        const ar = new ActionRowBuilder();
        for (const btn of rowComp.components) {
            ar.addComponents(ButtonBuilder.from(btn.toJSON()).setDisabled(true));
        }
        return ar;
    });
    if (disabledRows.length) {
        await interaction.editReply({ components: disabledRows }).catch(e => log.error('slot disable error:', e));
    }

    const play = playSlot({ guildId, userId: ownerUserId, requestedAmount, isAllIn });
    if (play.error === 'no_ngoc') {
        return interaction.followUp({ content: 'Bạn không có ngọc để chơi slot.', flags: MessageFlags.Ephemeral });
    }
    if (play.error === 'insufficient') {
        return interaction.followUp({
            content: `Bạn cần ${fmt(requestedAmount)} ngọc nhưng chỉ có ${fmt(play.available)}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const member = await interaction.guild.members.fetch(ownerUserId).catch(() => null);
    const displayName = member ? member.displayName : interaction.user.username;

    const anim = renderEmote('slotanim');
    const sym = [
        renderEmote(SLOT_SYMBOLS[play.spinResult[0]].emote),
        renderEmote(SLOT_SYMBOLS[play.spinResult[1]].emote),
        renderEmote(SLOT_SYMBOLS[play.spinResult[2]].emote)
    ];
    const header = `🎰 **${displayName}** quay slot (-${fmt(play.amount)} ${renderEmote('ngoc')})`;
    const render = (a, b, c) => `${header}\n[ ${a} | ${b} | ${c} ]`;

    const slotMsg = await interaction.followUp({ content: render(anim, anim, anim) });
    await new Promise(r => setTimeout(r, 500));
    await slotMsg.edit(render(sym[0], anim, anim)).catch(e => log.error('slot edit r1', e));
    await new Promise(r => setTimeout(r, 500));
    await slotMsg.edit(render(sym[0], anim, sym[2])).catch(e => log.error('slot edit r3', e));
    await new Promise(r => setTimeout(r, 750));

    const resultLine = formatSlotResultLine({ mult: play.mult, payout: play.payout, outcomeName: play.outcomeName });
    metrics.recordSlot({
        guildId,
        amount: play.amount, payout: play.payout, outcomeName: play.outcomeName,
        pityTriggered: play.pityTriggered, pityCapApplied: play.pityCapApplied,
        userId: ownerUserId
    });

    const components = play.walletAfter.ngoc > 0
        ? [buildSlotContinueButtons(ownerUserId, play.amount, play.walletAfter.ngoc)]
        : [];
    await slotMsg.edit({
        content: `${render(sym[0], sym[1], sym[2])}\n${resultLine}`,
        components
    }).catch(e => log.error('slot edit final', e));
}

async function handleKhodoButton(interaction) {
    const [, action, ownerUserId] = interaction.customId.split(':');
    if (action !== 'all') return;
    if (interaction.user.id !== ownerUserId) {
        return interaction.reply({ content: 'Đây không phải kho đồ của bạn.', flags: MessageFlags.Ephemeral });
    }
    const guildId = interaction.guildId;
    const member = await interaction.guild.members.fetch(ownerUserId).catch(() => null);
    const displayName = member ? member.displayName : interaction.user.username;
    const w = getWallet(guildId, ownerUserId);
    const lines = [
        `**Kho đồ của ${displayName}**`,
        `${renderEmote('nganphieu')} Ngân phiếu: **${fmt(w.nganphieu)}**`,
        `${renderEmote('ngoc')} Ngọc: **${fmt(w.ngoc)}**`
    ];
    for (const k of ITEM_KEYS) {
        lines.push(`${renderEmote(k)} ${ITEM_LABELS[k]}: **${fmt(w.items[k] || 0)}**`);
    }
    await interaction.update({ content: lines.join('\n'), components: [] }).catch(e => log.error('khodo update error', e));
}
