const { ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const log = require('../../logger');
const { data, saveData } = require('../state');
const { MANAGER_ID } = require('../constants');

// ── Stolen-emote storage ─────────────────────────────────────────────────────
//
// Discord caps custom emojis per *guild* (50 static + 50 animated at tier 0), so
// we don't store them in the community server. Instead the bot keeps a set of
// dedicated "storage guilds" — empty servers the bot is an admin of. A stolen
// emote is uploaded as a REAL emoji into whichever storage guild still has a free
// slot, which means it renders as a normal inline emoji everywhere (via the
// :name: feature), not as a big image. Add more storage guilds for more room.
//
// Persistence:
//   data.emoteStorageGuilds : string[]            registered storage guild ids
//   data.stolenEmoteMeta    : { [emojiId]: {by,at} }  light audit trail

const EMOJI_CODE_RE = /<(a?):(\w{2,32}):(\d+)>/g;
const PAGE_SIZE = 15;
const NAME_MAX = 32;

function store() {
    if (!Array.isArray(data.emoteStorageGuilds)) data.emoteStorageGuilds = [];
    if (!data.stolenEmoteMeta || typeof data.stolenEmoteMeta !== 'object') data.stolenEmoteMeta = {};
    return data;
}

// ── !steal permissions ───────────────────────────────────────────────────────
// The super-admin (MANAGER_ID) is always allowed. Others are granted either by
// the admin directly or by requesting (which DMs the admin an Accept/Deny card).
//
//   data.stealAllowed : string[]   user ids allowed to !steal / !emotes
//   data.stealPending : string[]   user ids with an open request (dedupe)

function permStore() {
    if (!Array.isArray(data.stealAllowed)) data.stealAllowed = [];
    if (!Array.isArray(data.stealPending)) data.stealPending = [];
    return data;
}

function canSteal(userId) {
    permStore();
    return userId === MANAGER_ID || data.stealAllowed.includes(userId);
}

function grantSteal(userId) {
    permStore();
    removePending(userId);
    if (data.stealAllowed.includes(userId)) return false;
    data.stealAllowed.push(userId);
    saveData();
    return true;
}

function revokeSteal(userId) {
    permStore();
    const i = data.stealAllowed.indexOf(userId);
    if (i === -1) return false;
    data.stealAllowed.splice(i, 1);
    saveData();
    return true;
}

function listAllowed() {
    permStore();
    return data.stealAllowed.slice();
}

function isPending(userId) {
    permStore();
    return data.stealPending.includes(userId);
}

function removePending(userId) {
    permStore();
    const i = data.stealPending.indexOf(userId);
    if (i >= 0) { data.stealPending.splice(i, 1); saveData(); }
}

// User asks for permission → DM the admin an Accept/Deny card.
// Returns one of: 'already' | 'pending' | 'sent' | 'error'.
async function requestSteal(client, requester) {
    permStore();
    if (canSteal(requester.id)) return 'already';
    if (isPending(requester.id)) return 'pending';

    const admin = await client.users.fetch(MANAGER_ID).catch(() => null);
    if (!admin) return 'error';

    const avatar = requester.displayAvatarURL ? requester.displayAvatarURL() : null;
    const embed = new EmbedBuilder()
        .setTitle('🥷 Yêu cầu quyền !steal')
        .setDescription(`**${requester.tag || requester.username}** (\`${requester.id}\`) xin quyền dùng \`!steal\` và \`!emotes\`.`);
    if (avatar && /^https?:\/\//.test(avatar)) embed.setThumbnail(avatar);
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`stealreq:accept:${requester.id}`).setLabel('Chấp nhận').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`stealreq:deny:${requester.id}`).setLabel('Từ chối').setStyle(ButtonStyle.Danger),
    );

    try {
        await admin.send({ embeds: [embed], components: [row] });
    } catch {
        return 'error'; // admin DMs closed
    }
    if (!data.stealPending.includes(requester.id)) { data.stealPending.push(requester.id); saveData(); }
    return 'sent';
}

// Admin clicked Accept/Deny on the request card (fires in the admin's DM).
async function handleRequestButton(interaction) {
    if (interaction.user.id !== MANAGER_ID) return; // only the admin decides
    const [, action, userId] = interaction.customId.split(':');

    let text;
    if (action === 'accept') {
        grantSteal(userId);
        text = `✅ Đã cấp quyền \`!steal\` cho <@${userId}> (\`${userId}\`).`;
        interaction.client.users.fetch(userId)
            .then(u => u.send('✅ Bạn đã được cấp quyền dùng `!steal` (chôm emote) và `!emotes`.'))
            .catch(() => { });
    } else {
        removePending(userId);
        text = `❌ Đã từ chối yêu cầu của <@${userId}> (\`${userId}\`).`;
    }
    try {
        await interaction.update({ content: text, embeds: [], components: [] });
    } catch (err) {
        log.error(`stolenEmotes: request button update failed: ${err.message}`);
    }
}

// Per-kind emoji slot limit for a guild (static and animated are counted apart).
function slotLimit(guild) {
    return [50, 100, 150, 250][guild.premiumTier] || 50;
}

function capacity(guild) {
    const limit = slotLimit(guild);
    const staticUsed = guild.emojis.cache.filter(e => !e.animated).size;
    const animUsed = guild.emojis.cache.filter(e => e.animated).size;
    return { limit, staticUsed, animUsed, staticFree: limit - staticUsed, animFree: limit - animUsed };
}

// Resolve registered storage guild ids to live Guild objects the bot can see.
function getStorageGuilds(client) {
    store();
    return data.emoteStorageGuilds
        .map(id => client.guilds.cache.get(id))
        .filter(Boolean);
}

function isStorageGuild(guildId) {
    store();
    return data.emoteStorageGuilds.includes(guildId);
}

function addStorageGuild(guildId) {
    store();
    if (data.emoteStorageGuilds.includes(guildId)) return false;
    data.emoteStorageGuilds.push(guildId);
    saveData();
    return true;
}

function removeStorageGuild(guildId) {
    store();
    const i = data.emoteStorageGuilds.indexOf(guildId);
    if (i === -1) return false;
    data.emoteStorageGuilds.splice(i, 1);
    saveData();
    return true;
}

// First storage guild with a free slot of the requested kind, or null if full.
function pickStorageGuild(client, animated) {
    for (const g of getStorageGuilds(client)) {
        const cap = capacity(g);
        if ((animated ? cap.animFree : cap.staticFree) > 0) return g;
    }
    return null;
}

// Discord emoji names: 2-32 chars of [A-Za-z0-9_]. Coerce arbitrary input.
function sanitizeName(raw) {
    let n = String(raw || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (n.length > NAME_MAX) n = n.slice(0, NAME_MAX);
    if (n.length < 2) n = ('emote_' + n).slice(0, NAME_MAX);
    return n;
}

// Ensure the name is unique across every storage guild (Discord allows dup names
// but :name: lookups would collide), suffixing _2, _3, … as needed.
function uniqueName(client, base) {
    const taken = new Set();
    for (const g of getStorageGuilds(client)) {
        for (const e of g.emojis.cache.values()) taken.add(e.name.toLowerCase());
    }
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; i < 1000; i++) {
        let cand = `${base}_${i}`;
        if (cand.length > NAME_MAX) cand = base.slice(0, NAME_MAX - String(i).length - 1) + '_' + i;
        if (!taken.has(cand.toLowerCase())) return cand;
    }
    return `${base}_${Date.now()}`.slice(0, NAME_MAX);
}

// Pull the first custom-emoji code out of arbitrary text (message content /
// forwarded snapshot / a raw arg). Returns { animated, name, id } or null.
function parseEmoteRef(text) {
    if (!text) return null;
    EMOJI_CODE_RE.lastIndex = 0;
    const m = EMOJI_CODE_RE.exec(text);
    if (m) return { animated: m[1] === 'a', name: m[2], id: m[3] };
    // Bare numeric id.
    const idOnly = String(text).trim().match(/^(\d{15,25})$/);
    if (idOnly) return { animated: null, name: null, id: idOnly[1] };
    return null;
}

function cdnUrl(id, animated) {
    return `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=128`;
}

// Upload one emote into a storage guild. `ref` = { id, animated, name }.
// Throws Error(userFacingMessage) on any failure.
async function steal(client, ref, requestedName, byUserId) {
    store();

    // If we only have an id, probe the CDN to learn whether it's animated.
    let animated = ref.animated;
    if (animated === null || animated === undefined) {
        animated = await probeAnimated(ref.id);
    }

    const target = pickStorageGuild(client, animated);
    if (!target) {
        const kind = animated ? 'animated' : 'static';
        throw new Error(`No storage guild has a free ${kind} slot. Add one with \`!emotestorage create\` or \`!emotestorage add\`.`);
    }

    const base = sanitizeName(requestedName || ref.name || `emote_${Date.now().toString(36)}`);
    const name = uniqueName(client, base);
    const url = cdnUrl(ref.id, animated);

    let created;
    try {
        created = await target.emojis.create({ attachment: url, name, reason: `Stolen by ${byUserId}` });
    } catch (err) {
        // 30008 = max emojis; 50035 = invalid form (usually >256KB or bad image).
        if (err.code === 30008) throw new Error(`Storage guild **${target.name}** is full. Add another with \`!emotestorage create\`.`);
        if (err.code === 50035) throw new Error('Discord rejected the image (over 256 KB or unsupported). Non-Discord GIFs may need resizing first.');
        log.error(`stolenEmotes: create failed: ${err.message}`);
        throw new Error(`Upload failed: ${err.message}`);
    }

    data.stolenEmoteMeta[created.id] = { by: byUserId, at: Date.now() };
    saveData();
    return { emoji: created, guild: target };
}

// HEAD the CDN to decide static vs animated when only an id is known.
async function probeAnimated(id) {
    try {
        const res = await fetch(`https://cdn.discordapp.com/emojis/${id}.gif?size=32`, { method: 'GET' });
        return res.ok && (res.headers.get('content-type') || '').includes('gif');
    } catch {
        return false;
    }
}

// Flat list of every stolen emote across storage guilds, newest-ish first.
function listEmotes(client) {
    store();
    const out = [];
    const guilds = getStorageGuilds(client);
    guilds.forEach((g, gi) => {
        for (const e of g.emojis.cache.values()) {
            out.push({ emoji: e, guildIndex: gi + 1, guildName: g.name });
        }
    });
    return out;
}

function deleteEmote(client, name) {
    store();
    const wanted = String(name).replace(/^:|:$/g, '').toLowerCase();
    for (const g of getStorageGuilds(client)) {
        const e = g.emojis.cache.find(x => x.name.toLowerCase() === wanted);
        if (e) {
            delete data.stolenEmoteMeta[e.id];
            saveData();
            return e.delete(`Removed via !delemote`).then(() => ({ name: e.name, guild: g.name }));
        }
    }
    return Promise.resolve(null);
}

async function deleteAll(client) {
    store();
    let n = 0;
    for (const g of getStorageGuilds(client)) {
        for (const e of [...g.emojis.cache.values()]) {
            try {
                await e.delete('!delemote all');
                delete data.stolenEmoteMeta[e.id];
                n++;
            } catch (err) {
                log.error(`stolenEmotes: bulk delete failed for ${e.name}: ${err.message}`);
            }
        }
    }
    saveData();
    return n;
}

// ── Auto-create storage guilds ───────────────────────────────────────────────
// A bot may only create guilds while it is in FEWER THAN 10 guilds (Discord API
// limit). Past that, storage guilds must be made by hand and the bot invited.
async function createStorageGuild(client, name) {
    if (client.guilds.cache.size >= 10) {
        throw new Error('Bot is already in 10 guilds — Discord blocks bot guild creation past that. Create the server manually and invite the bot, then `!emotestorage add`.');
    }
    let guild;
    try {
        guild = await client.guilds.create({ name });
    } catch (err) {
        throw new Error(`Guild creation failed: ${err.message}`);
    }

    // Fresh bot-made guilds may have no usable channel; ensure one for the invite.
    let channel = guild.channels.cache.find(c => c.type === ChannelType.GuildText);
    if (!channel) {
        try {
            channel = await guild.channels.create({ name: 'general', type: ChannelType.GuildText });
        } catch (err) {
            log.error(`stolenEmotes: channel create failed: ${err.message}`);
        }
    }

    let invite = null;
    if (channel) {
        try {
            // Single-use, 7-day link: only the owner needs to join once, and a
            // leaked link dies after one use (or a week unused).
            invite = await channel.createInvite({ maxAge: 604800, maxUses: 1, unique: true });
        } catch (err) {
            log.error(`stolenEmotes: invite create failed: ${err.message}`);
        }
    }

    addStorageGuild(guild.id);
    return { guild, invite: invite ? invite.url : null };
}

// ── Paged list embed ─────────────────────────────────────────────────────────

function buildListPayload(client, page) {
    const guilds = getStorageGuilds(client);
    const list = listEmotes(client);
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const p = Math.min(Math.max(0, page | 0), pages - 1);
    const slice = list.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);

    const lines = slice.length
        ? slice.map(x => `${x.emoji} \`:${x.emoji.name}:\` · kho #${x.guildIndex}`)
        : ['*(chưa có emote nào bị chôm)*'];

    // Capacity per storage guild + aggregate free animated slots.
    let animFreeTotal = 0, staticFreeTotal = 0;
    const capLines = guilds.length
        ? guilds.map((g, i) => {
            const c = capacity(g);
            animFreeTotal += c.animFree;
            staticFreeTotal += c.staticFree;
            const full = c.animFree === 0 && c.staticFree === 0 ? ' ⚠️' : '';
            return `#${i + 1} **${g.name}** — động ${c.animUsed}/${c.limit} · tĩnh ${c.staticUsed}/${c.limit}${full}`;
        })
        : ['*(chưa đăng ký kho nào — dùng `!emotestorage create`)*'];

    const embed = new EmbedBuilder()
        .setTitle('🗃️ Kho emote đã chôm')
        .setDescription(lines.join('\n'))
        .addFields({ name: `Sức chứa (còn động: ${animFreeTotal} · tĩnh: ${staticFreeTotal})`, value: capLines.join('\n') })
        .setFooter({ text: `Trang ${p + 1}/${pages} · ${list.length} emote` });

    if (guilds.length && animFreeTotal === 0 && staticFreeTotal === 0) {
        embed.addFields({ name: '⚠️ Hết chỗ', value: 'Mọi kho đã đầy. Tạo kho mới: `!emotestorage create`.' });
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`emotes:pg:${p - 1}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(p <= 0),
        new ButtonBuilder().setCustomId(`emotes:pg:${p + 1}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(p >= pages - 1),
    );

    return { embeds: [embed], components: pages > 1 ? [row] : [] };
}

async function handleListButton(interaction) {
    const page = parseInt(interaction.customId.split(':')[2], 10) || 0;
    try {
        await interaction.update(buildListPayload(interaction.client, page));
    } catch (err) {
        log.error(`stolenEmotes: paging failed: ${err.message}`);
    }
}

module.exports = {
    PAGE_SIZE,
    canSteal,
    grantSteal,
    revokeSteal,
    listAllowed,
    requestSteal,
    handleRequestButton,
    capacity,
    buildListPayload,
    handleListButton,
    getStorageGuilds,
    isStorageGuild,
    addStorageGuild,
    removeStorageGuild,
    pickStorageGuild,
    parseEmoteRef,
    sanitizeName,
    uniqueName,
    steal,
    listEmotes,
    deleteEmote,
    deleteAll,
    createStorageGuild,
};
