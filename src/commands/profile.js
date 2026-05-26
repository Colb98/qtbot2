const {
    SlashCommandBuilder, MessageFlags,
    AttachmentBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, StringSelectMenuOptionBuilder
} = require('discord.js');
const { data } = require('../state');
const { getWallet, ITEM_LABELS, ITEM_KEYS } = require('../services/currency');
const profile = require('../services/profile');
const profileCard = require('../services/profileCard');
const log = require('../../logger');

const NONE_VALUE = '__none__';

// ── Build player object from live data ─────────────────────────────────────
function buildPlayer(guildId, userId) {
    const reg = data.registrations && data.registrations[guildId] && data.registrations[guildId][userId];
    const ingame = (reg && reg.ingame) || (reg && reg.displayName) || (reg && reg.tag) || 'Vô Danh';
    const sect = reg && reg.class;
    const prof = profile.getProfile(guildId, userId);
    const wallet = getWallet(guildId, userId);
    const stats = profileCard.computeStats(guildId, userId, prof);
    return { userId, ingame, sect, gender: prof.gender, wallet, profile: prof, stats };
}

// ── Render the card image attachment ───────────────────────────────────────
async function renderCardAttachment(user, guildId) {
    const player = buildPlayer(guildId, user.id);
    const png = await profileCard.renderProfileCard(player);
    return new AttachmentBuilder(png, { name: `profile-${user.id}.png` });
}

// ── Config component builders ──────────────────────────────────────────────
function buildItemOptions(wallet) {
    // Only items the player actually owns (combined locked+non-locked > 0).
    const opts = [];
    for (const k of ITEM_KEYS) {
        const total = (wallet.items[k] || 0) + (wallet.lockedItems[k] || 0);
        if (total > 0) {
            opts.push(
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${ITEM_LABELS[k]} × ${total}`)
                    .setValue(k)
            );
        }
    }
    if (opts.length === 0) {
        opts.push(new StringSelectMenuOptionBuilder().setLabel('(Bạn chưa có vật phẩm nào)').setValue('__empty__'));
    }
    opts.unshift(new StringSelectMenuOptionBuilder().setLabel('— None (ẩn ô)').setValue(NONE_VALUE));
    return opts;
}

function buildConfigComponents(userId, wallet, prof) {
    const itemOpts = buildItemOptions(wallet);

    const slot1 = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`profile:slot:${userId}:1`)
            .setPlaceholder(prof.itemSlot1 ? `Ô 1: ${ITEM_LABELS[prof.itemSlot1] || prof.itemSlot1}` : 'Ô 1: None')
            .addOptions(...itemOpts.slice(0, 25))
    );
    const slot2 = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`profile:slot:${userId}:2`)
            .setPlaceholder(prof.itemSlot2 ? `Ô 2: ${ITEM_LABELS[prof.itemSlot2] || prof.itemSlot2}` : 'Ô 2: None')
            .addOptions(...itemOpts.slice(0, 25))
    );
    const slot3 = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`profile:slot:${userId}:3`)
            .setPlaceholder(prof.itemSlot3 ? `Ô 3: ${ITEM_LABELS[prof.itemSlot3] || prof.itemSlot3}` : 'Ô 3: None')
            .addOptions(...itemOpts.slice(0, 25))
    );

    const toggleRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`profile:ngoc:${userId}`)
            .setLabel(prof.showNgoc ? 'Ẩn ngọc' : 'Hiện ngọc')
            .setStyle(prof.showNgoc ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`profile:gender:${userId}`)
            .setLabel(prof.gender === 'f' ? 'Giới tính: Nữ' : 'Giới tính: Nam')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`profile:done:${userId}`)
            .setLabel('Xong')
            .setStyle(ButtonStyle.Secondary)
    );

    return [slot1, slot2, slot3, toggleRow];
}

// ── Public entry points ────────────────────────────────────────────────────

// Used by both /profile and !profile. Replies with the rendered card publicly.
async function sendProfileCard(ctx, user) {
    const guildId = ctx.guildId;
    if (!guildId) {
        const content = 'Lệnh này chỉ dùng trong máy chủ.';
        if (ctx.isChatInputCommand) return ctx.reply({ content, flags: MessageFlags.Ephemeral });
        return ctx.reply(content);
    }

    // Discord-style "thinking" while we render
    if (ctx.isChatInputCommand && ctx.isChatInputCommand()) {
        await ctx.deferReply();
    }

    const attachment = await renderCardAttachment(user, guildId);
    const customizeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`profile:open:${user.id}`)
            .setLabel('⚙️ Tuỳ chỉnh')
            .setStyle(ButtonStyle.Secondary)
    );

    if (ctx.isChatInputCommand && ctx.isChatInputCommand()) {
        await ctx.editReply({ files: [attachment], components: [customizeRow] });
    } else {
        await ctx.reply({ files: [attachment], components: [customizeRow] });
    }
}

// Update an already-posted card after a setting change.
async function updatePostedCard(interaction) {
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const attachment = await renderCardAttachment(interaction.user, guildId);
    const customizeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`profile:open:${userId}`)
            .setLabel('⚙️ Tuỳ chỉnh')
            .setStyle(ButtonStyle.Secondary)
    );
    await interaction.message.edit({ files: [attachment], attachments: [], components: [customizeRow] }).catch(e => log.warn(`profile: edit failed: ${e.message}`));
}

// Handle all component interactions whose customId starts with `profile:`.
async function handleComponent(interaction) {
    const [, action, ownerUserId, ...rest] = interaction.customId.split(':');
    if (interaction.user.id !== ownerUserId) {
        return interaction.reply({ content: 'Đây không phải profile của bạn.', flags: MessageFlags.Ephemeral });
    }
    const guildId = interaction.guildId;
    if (!guildId) {
        return interaction.reply({ content: 'Chỉ dùng được trong máy chủ.', flags: MessageFlags.Ephemeral });
    }

    if (action === 'open') {
        // Show the config UI as an ephemeral message
        const wallet = getWallet(guildId, ownerUserId);
        const prof = profile.getProfile(guildId, ownerUserId);
        const components = buildConfigComponents(ownerUserId, wallet, prof);
        return interaction.reply({
            content: '⚙️ **Tuỳ chỉnh profile** — chọn vật phẩm cho 3 ô, bật/tắt ngọc, đổi giới tính. Card sẽ tự cập nhật.',
            components,
            flags: MessageFlags.Ephemeral
        });
    }

    if (action === 'slot') {
        const slotNum = parseInt(rest[0], 10);
        const value = interaction.values && interaction.values[0];
        if (!value || value === '__empty__') {
            return interaction.deferUpdate().catch(() => {});
        }
        const key = value === NONE_VALUE ? null : value;
        try {
            profile.setItemSlot(guildId, ownerUserId, slotNum, key);
        } catch (e) {
            return interaction.reply({ content: `Lỗi: ${e.message}`, flags: MessageFlags.Ephemeral });
        }
        await interaction.deferUpdate().catch(() => {});
        // Re-render the originating card if this is from a message component on the card.
        // The config UI is ephemeral; find the original card by walking up the channel
        // history is unreliable, so we just send a small "updated" toast and let the
        // user re-call /profile to see. But better UX: update the same ephemeral
        // message's placeholder and trigger a fresh card render as a follow-up.
        const wallet = getWallet(guildId, ownerUserId);
        const prof = profile.getProfile(guildId, ownerUserId);
        const components = buildConfigComponents(ownerUserId, wallet, prof);
        await interaction.editReply({ components });
        // Also send updated card as ephemeral follow-up preview
        try {
            const attachment = await renderCardAttachment(interaction.user, guildId);
            await interaction.followUp({ content: '✅ Đã cập nhật. Preview:', files: [attachment], flags: MessageFlags.Ephemeral });
        } catch (e) { log.warn(`profile: preview render failed: ${e.message}`); }
        return;
    }

    if (action === 'ngoc') {
        const prof = profile.getProfile(guildId, ownerUserId);
        profile.setShowNgoc(guildId, ownerUserId, !prof.showNgoc);
        await interaction.deferUpdate().catch(() => {});
        const wallet = getWallet(guildId, ownerUserId);
        const next = profile.getProfile(guildId, ownerUserId);
        await interaction.editReply({ components: buildConfigComponents(ownerUserId, wallet, next) });
        try {
            const attachment = await renderCardAttachment(interaction.user, guildId);
            await interaction.followUp({ content: '✅ Đã cập nhật. Preview:', files: [attachment], flags: MessageFlags.Ephemeral });
        } catch (e) { log.warn(`profile: preview render failed: ${e.message}`); }
        return;
    }

    if (action === 'gender') {
        const prof = profile.getProfile(guildId, ownerUserId);
        profile.setGender(guildId, ownerUserId, prof.gender === 'm' ? 'f' : 'm');
        await interaction.deferUpdate().catch(() => {});
        const wallet = getWallet(guildId, ownerUserId);
        const next = profile.getProfile(guildId, ownerUserId);
        await interaction.editReply({ components: buildConfigComponents(ownerUserId, wallet, next) });
        try {
            const attachment = await renderCardAttachment(interaction.user, guildId);
            await interaction.followUp({ content: '✅ Đã đổi giới tính. Preview:', files: [attachment], flags: MessageFlags.Ephemeral });
        } catch (e) { log.warn(`profile: preview render failed: ${e.message}`); }
        return;
    }

    if (action === 'done') {
        await interaction.update({ content: '✅ Đã lưu. Dùng `/profile` để xem card công khai.', components: [] }).catch(() => {});
        return;
    }

    return interaction.reply({ content: 'Hành động không hợp lệ.', flags: MessageFlags.Ephemeral });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('profile')
        .setDescription('Hiển thị profile card của bạn'),
    async execute(interaction) {
        try {
            await sendProfileCard(interaction, interaction.user);
        } catch (e) {
            log.error('profile slash error:', e);
            const content = 'Render profile lỗi.';
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content }).catch(() => {});
            } else {
                await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
            }
        }
    },
    // Exposed for !profile and component routing
    sendProfileCard,
    handleComponent
};
