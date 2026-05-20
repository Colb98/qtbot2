const log = require('../../logger');
const client = require('../client');
const { data, saveData } = require('../state');
const { getUserDisplayName, getNextSaturday } = require('../utils');

function getMessageText(saturday) {
    return `**[Đăng ký Bang Chiến]**\nTương tác ✅ để đăng ký tham gia bang chiến. Tương tác ❌ để báo bận.\nNgày bang chiến kì này là vào **${saturday.toLocaleDateString() || 'Undefined'} — Lúc 20:00**`;
}

async function doWeeklyPost(ids) {
    let chs = [];
    if (!ids) {
        if (!data.channelId) {
            log.warn('No channel configured for weekly post.');
            return;
        }
        const channelIds = Object.values(data.channelId);
        chs = await Promise.all(
            channelIds.map(id => client.channels.fetch(id).catch(() => null))
        );
    } else {
        chs = await Promise.all(
            ids.map(id => client.channels.fetch(id).catch(() => null))
        );
    }

    const saturday = getNextSaturday();
    await sendMessageToChannels(chs, saturday);
}

async function sendMessageToChannels(channels, saturday) {
    saturday.setHours(20, 0, 0, 0);
    for (const ch of channels) {
        if (!ch) { log.warn('Channel not found'); continue; }
        const guildId = ch.guildId;
        const msg = await ch.send({ content: getMessageText(saturday) });
        await msg.react('✅');
        await msg.react('❌');

        data.lastPostMessageId[guildId] = msg.id;
        data.participants[guildId] = {};
        data.absents[guildId] = {};
        data.bangChienGrant = data.bangChienGrant || {};
        data.bangChienGrant[guildId] = data.bangChienGrant[guildId] || {};
        data.bangChienGrant[guildId][msg.id] = {};

        if (!data.postValidUntil) data.postValidUntil = {};
        data.postValidUntil[guildId] = saturday.getTime();
        saveData();
        log.info('Posted weekly signup message:', msg.id);
    }
}

async function sendReminders() {
    if (!data.participants) {
        log.warn('No participants data.');
        return;
    }
    for (const guildId of Object.keys(data.participants)) {
        const participants = Object.keys(data.participants[guildId] || {});
        if (participants.length === 0) {
            log.info(`Group ${guildId} No participants to remind.`);
            continue;
        }
        for (const uid of participants) {
            const reg = data.registrations[guildId][uid];
            try {
                const user = await client.users.fetch(uid);
                if (!user) continue;
                await user.send(`**Nhắc nhở**: Bang chiến sẽ bắt đầu trong 30p. **${(reg && reg.ingame) ? `${reg.ingame} (${reg.class})` : `${user.displayName}`}** nhớ Online để tham gia cùng chiến hữu nhé!`);
            } catch (e) {
                log.warn('Failed to DM reminder to', uid, e.message);
            }
        }
        log.info('Reminders sent to', participants.length, `users of group ${guildId}}.`);
    }
}

async function sendListToManager(guildId) {
    if (!data.managerId) {
        log.warn('No manager configured.');
        return;
    }
    const managerIds = data.managerId[guildId] || [];
    const managers = await Promise.all(
        managerIds.map(id => client.users.fetch(id).catch(() => null))
    );
    if (!managers) { log.warn('Manager not found'); return; }

    const participants = Object.keys(data.participants[guildId] || {});
    if (participants.length === 0) {
        managers.forEach(m => m && m.send('Danh sách bang chiến: (không có ai đăng ký).'));
        return;
    }
    let text = 'Danh sách bang chiến:\n```';
    for (const uid of participants) {
        const reg = data.registrations[guildId][uid];
        const display = reg ? `${getUserDisplayName(uid, guildId)},${reg.class ? reg.class : '(chưa đăng ký phái)'}` : `(chưa đăng ký info)`;
        text += `${display}\n`;
    }
    text += '```';
    managers.forEach(m => m && m.send(text));
    log.info('Sent participant list to managers.');
}

async function editMessage(guildId, message) {
    const saturday = getNextSaturday();
    let content = getMessageText(saturday);
    content += '```';
    let index = 0;
    for (const pid of Object.keys(data.participants[guildId])) {
        const reg = data.registrations[guildId][pid];
        const display = reg ? `${getUserDisplayName(pid, guildId)} — ${reg.class ? reg.class : '(chưa đăng ký phái)'}` : `(chưa đăng ký info)`;
        content += `${++index}. ${display}\n`;
    }
    content += '```';
    await message.edit(content);
}

async function validateGuildMember(guild) {
    const uids = Object.keys(data.registrations[guild.id] || {});
    let changed = false;
    for (const uid of uids) {
        try {
            const member = await guild.members.fetch(uid).catch(() => null);
            if (!member) {
                delete data.registrations[guild.id][uid];
                delete data.participants[guild.id][uid];
                changed = true;
                log.info(`Removed registration of user ${uid} who left guild ${guild.id}`);
            }
        } catch (e) {
            log.error('validateGuildMember error', e);
        }
    }
    if (changed) saveData();
}

module.exports = {
    getMessageText,
    doWeeklyPost,
    sendMessageToChannels,
    sendReminders,
    sendListToManager,
    editMessage,
    validateGuildMember
};
