const { PermissionFlagsBits } = require('discord.js');
const log = require('../../logger');

// "Not Quite Nitro" for animated emotes.
//
// Non-Nitro members can't send animated emotes: when they type `:catjam:` the
// client leaves it as literal text instead of turning it into `<a:catjam:id>`.
// A bot, however, CAN post animated emotes for free. So we detect those bare
// `:name:` shortcodes that match an animated emote of THIS guild, delete the
// original message, and repost an identical one via a webhook wearing the
// member's name + avatar — with the emote now animated.
//
// We can't "edit" the user's message (a bot may only edit its own), and the
// emoji picker is blocked client-side before it ever reaches us, so
// delete + webhook-repost of the typed `:name:` form is the only workable path.

// Reuse one bot-owned webhook per parent channel instead of creating one each
// time (webhook count per channel is capped, creation is rate-limited).
const webhookCache = new Map(); // parentChannelId -> Webhook

// Matches a full emote code OR a bare :shortcode:. The full-code branch is
// listed first so its internal colons are consumed and never seen as a
// shortcode; `name` (group 1) is only set for the bare-shortcode branch.
const TOKEN_RE = /<a?:\w{2,32}:\d+>|:(\w{2,32}):/g;

async function getWebhook(parent, botId) {
    const cached = webhookCache.get(parent.id);
    if (cached) return cached;

    let hook = null;
    try {
        const hooks = await parent.fetchWebhooks();
        hook = hooks.find(w => w.owner && w.owner.id === botId && w.token) || null;
    } catch {
        return null;
    }

    if (!hook) {
        try {
            hook = await parent.createWebhook({ name: 'QtBot Emote' });
        } catch {
            return null;
        }
    }

    webhookCache.set(parent.id, hook);
    return hook;
}

// Returns true if the message was reposted (caller should then stop), false to
// let normal handling continue.
async function handleAnimatedEmote(msg) {
    if (!msg.guild) return false;

    const content = msg.content;
    if (!content || content.indexOf(':') === -1) return false;
    if (content.trimStart().startsWith('!')) return false; // leave commands alone

    // Convert bare :name: shortcodes that map to an animated guild emote.
    const emojis = msg.guild.emojis.cache;
    let converted = false;
    const rebuilt = content.replace(TOKEN_RE, (full, name) => {
        if (name === undefined) return full; // already a full <a:..:id> / <:..:id>
        const emoji = emojis.find(e => e.animated && e.name === name);
        if (!emoji) return full; // not an animated emote of this guild — leave text
        converted = true;
        return emoji.toString(); // <a:name:id>
    });

    if (!converted) return false;
    if (rebuilt.length > 2000) return false; // would exceed the webhook content limit

    const me = msg.guild.members.me;
    if (!me) return false;

    // Need Manage Messages (to delete the original) and Manage Webhooks (to
    // create/use the webhook). In a thread the webhook lives on the parent.
    const parent = msg.channel.isThread() ? msg.channel.parent : msg.channel;
    if (!parent) return false;

    const chanPerms = msg.channel.permissionsFor(me);
    const parentPerms = parent.permissionsFor(me);
    if (!chanPerms || !chanPerms.has(PermissionFlagsBits.ManageMessages)) return false;
    if (!parentPerms || !parentPerms.has(PermissionFlagsBits.ManageWebhooks)) return false;

    let hook = await getWebhook(parent, me.id);
    if (!hook) return false;

    const member = msg.member;
    const username = (member && member.displayName) || msg.author.username;
    const avatarURL = member ? member.displayAvatarURL() : msg.author.displayAvatarURL();

    // Preserve a jump link to the replied-to message, since webhooks can't reply.
    let body = rebuilt;
    if (msg.reference && msg.reference.messageId) {
        const link = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.reference.messageId}`;
        const prefix = `-# ↪ [reply](${link})\n`;
        if (prefix.length + rebuilt.length <= 2000) body = prefix + rebuilt;
    }

    // Re-upload any attachments by URL. Must happen BEFORE we delete the
    // original, or the CDN links go dead.
    const files = msg.attachments.size ? [...msg.attachments.values()].map(a => a.url) : undefined;

    const payload = {
        content: body,
        username,
        avatarURL,
        files,
        threadId: msg.channel.isThread() ? msg.channel.id : undefined,
        // Never let the repost ping @everyone/@here on the user's behalf;
        // user and role mentions still resolve as they normally would.
        allowedMentions: { parse: ['users', 'roles'] }
    };

    try {
        await hook.send(payload);
    } catch (err) {
        // The cached webhook may have been deleted out from under us; drop it and
        // rebuild once before giving up.
        if (err.code === 10015) {
            forgetWebhook(parent.id);
            hook = await getWebhook(parent, me.id);
            if (hook) {
                try {
                    await hook.send(payload);
                } catch (err2) {
                    log.error(`animatedEmote: webhook resend failed: ${err2.message}`);
                    return false;
                }
            } else {
                return false;
            }
        } else {
            log.error(`animatedEmote: webhook send failed: ${err.message}`);
            return false; // leave the original untouched
        }
    }

    try {
        await msg.delete();
    } catch (err) {
        // Repost already went out; a failed delete just leaves a duplicate.
        log.error(`animatedEmote: delete failed: ${err.message}`);
    }

    return true;
}

// Drop a channel's cached webhook if it was deleted out from under us.
function forgetWebhook(channelId) {
    webhookCache.delete(channelId);
}

module.exports = { handleAnimatedEmote, forgetWebhook };
