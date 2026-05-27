const {
    SlashCommandBuilder, MessageFlags,
    AttachmentBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const { data } = require('../state');
const { getWallet, ITEM_LABELS, ITEM_KEYS } = require('../services/currency');
const profile = require('../services/profile');
const profileCard = require('../services/profileCard');
const { isSuperAdmin } = require('../utils');
const log = require('../../logger');

const NONE_VALUE = '__none__';

// ── Daily render-cap gate ──────────────────────────────────────────────────
// Returns null if rendering is allowed (and consumes a slot for non-admins),
// or a Vietnamese user-facing error string when the cap is exhausted.
function tryConsumeRenderQuota(guildId, userId) {
    if (isSuperAdmin(userId)) return null;
    const res = profile.consumeCardRender(guildId, userId);
    if (res.ok) return null;
    return `⛔ Bạn đã đạt giới hạn **${res.used}/${res.limit}** lần tạo profile card hôm nay. Reset lúc **00:00 GMT+7**.`;
}

// ── Build player object from live data ─────────────────────────────────────
function buildPlayer(guildId, userId) {
    const reg = data.registrations && data.registrations[guildId] && data.registrations[guildId][userId];
    const prof = profile.getProfile(guildId, userId);
    const ingame = prof.displayName
        || (reg && reg.ingame) || (reg && reg.displayName) || (reg && reg.tag) || 'Vô Danh';
    const sect = reg && reg.class;
    const wallet = getWallet(guildId, userId);
    const stats = profileCard.computeStats(guildId, userId, prof);
    return { userId, ingame, sect, gender: prof.gender, wallet, profile: prof, stats };
}

// Resolve a Discord-side display name for a userId. Prefers the registration
// ingame name (synchronous, common case) before falling back to a guild
// members fetch, so we typically avoid any network call.
async function resolveDisplayName(guild, guildId, userId) {
    const reg = data.registrations && data.registrations[guildId] && data.registrations[guildId][userId];
    if (reg && (reg.ingame || reg.displayName)) return reg.ingame || reg.displayName;
    if (guild) {
        const m = await guild.members.fetch(userId).catch(() => null);
        if (m) return m.displayName;
    }
    return 'Vô Danh';
}

// ── Render the card image attachment ───────────────────────────────────────
async function renderCardAttachment(user, guildId, guild) {
    const player = buildPlayer(guildId, user.id);
    // Patch in display names for bond partners — the renderer has no
    // Discord context to do this itself.
    if (player.stats && Array.isArray(player.stats.topBonds)) {
        for (const b of player.stats.topBonds) {
            b.name = await resolveDisplayName(guild, guildId, b.otherId);
        }
    }
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
            .setCustomId(`profile:name:${userId}`)
            .setLabel('✏️ Đổi tên')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`profile:done:${userId}`)
            .setLabel('Xong')
            .setStyle(ButtonStyle.Success)
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

    // Daily render quota — must check BEFORE deferReply so we can use a
    // standard ephemeral reply on rejection.
    const quotaError = tryConsumeRenderQuota(guildId, user.id);
    if (quotaError) {
        if (ctx.isChatInputCommand && ctx.isChatInputCommand()) {
            return ctx.reply({ content: quotaError, flags: MessageFlags.Ephemeral });
        }
        return ctx.reply(quotaError);
    }

    // Discord-style "thinking" while we render
    if (ctx.isChatInputCommand && ctx.isChatInputCommand()) {
        await ctx.deferReply();
    }

    const attachment = await renderCardAttachment(user, guildId, ctx.guild);
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

// Refresh just the components on the ephemeral config UI — no image render.
async function refreshConfigComponents(interaction, guildId, ownerUserId) {
    const wallet = getWallet(guildId, ownerUserId);
    const prof = profile.getProfile(guildId, ownerUserId);
    const components = buildConfigComponents(ownerUserId, wallet, prof);
    await interaction.editReply({ components }).catch(() => {});
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
            content: '⚙️ **Tuỳ chỉnh profile** — chọn vật phẩm, bật/tắt ngọc, đổi giới tính, đổi tên. Bấm **Xong** để render card.',
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
        await refreshConfigComponents(interaction, guildId, ownerUserId);
        return;
    }

    if (action === 'ngoc') {
        const prof = profile.getProfile(guildId, ownerUserId);
        profile.setShowNgoc(guildId, ownerUserId, !prof.showNgoc);
        await interaction.deferUpdate().catch(() => {});
        await refreshConfigComponents(interaction, guildId, ownerUserId);
        return;
    }

    if (action === 'gender') {
        const prof = profile.getProfile(guildId, ownerUserId);
        profile.setGender(guildId, ownerUserId, prof.gender === 'm' ? 'f' : 'm');
        await interaction.deferUpdate().catch(() => {});
        await refreshConfigComponents(interaction, guildId, ownerUserId);
        return;
    }

    if (action === 'name') {
        const prof = profile.getProfile(guildId, ownerUserId);
        const reg = data.registrations && data.registrations[guildId] && data.registrations[guildId][ownerUserId];
        const current = prof.displayName || (reg && reg.ingame) || '';
        const modal = new ModalBuilder()
            .setCustomId(`profile:name_submit:${ownerUserId}`)
            .setTitle('Đổi tên hiển thị trên card');
        const input = new TextInputBuilder()
            .setCustomId('name')
            .setLabel('Tên hiển thị (để trống = dùng tên ingame)')
            .setStyle(TextInputStyle.Short)
            .setMinLength(0)
            .setMaxLength(32)
            .setRequired(false)
            .setValue(current);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal).catch((e) => log.warn(`profile: showModal failed: ${e.message}`));
        return;
    }

    if (action === 'name_submit') {
        const raw = interaction.fields.getTextInputValue('name') || '';
        try {
            profile.setDisplayName(guildId, ownerUserId, raw.trim() === '' ? null : raw);
        } catch (e) {
            return interaction.reply({ content: `Lỗi: ${e.message}`, flags: MessageFlags.Ephemeral });
        }
        await interaction.deferUpdate().catch(() => {});
        await refreshConfigComponents(interaction, guildId, ownerUserId);
        return;
    }

    if (action === 'done') {
        const quotaError = tryConsumeRenderQuota(guildId, ownerUserId);
        if (quotaError) {
            await interaction.update({
                content: `✅ Đã lưu thiết lập.\n${quotaError}\nDùng \`/profile\` ngày mai để tạo card.`,
                components: []
            }).catch(() => {});
            return;
        }
        await interaction.deferUpdate().catch(() => {});
        try {
            const attachment = await renderCardAttachment(interaction.user, guildId, interaction.guild);
            await interaction.editReply({
                content: '✅ Đã lưu. Dùng `/profile` để khoe card công khai.',
                files: [attachment],
                attachments: [],
                components: []
            });
        } catch (e) {
            log.warn(`profile: done render failed: ${e.message}`);
            await interaction.editReply({ content: '✅ Đã lưu (render lỗi).', components: [] }).catch(() => {});
        }
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
