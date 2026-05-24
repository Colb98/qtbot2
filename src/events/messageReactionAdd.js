const { Events, ChannelType } = require('discord.js');
const log = require('../../logger');
const { data, saveData } = require('../state');
const { CLASS_NAMES } = require('../constants');
const { isAbsent, isParticipant, isValidTimeToRegister } = require('../utils');
const { setUserRole } = require('../services/roles');
const { editMessage, validateGuildMember } = require('../services/guildWar');
const { grantIfNeeded } = require('../services/bangChienReward');
const { addNgoc } = require('../services/currency');
const { isMaintenance } = require('../services/maintenance');
const metrics = require('../services/metrics');

module.exports = {
    name: Events.MessageReactionAdd,
    async execute(reaction, user) {
        try {
            if (user.bot) return;
            if (isMaintenance()) return;
            if (reaction.partial) await reaction.fetch();
            if (reaction.message.partial) await reaction.message.fetch();

            const ch = reaction.message.channel;
            if (ch && ch.partial) {
                log.info('channel is partial -> fetching channel...');
                try {
                    await ch.fetch();
                    log.info('channel fetched, type=', ch.type);
                } catch (err) {
                    log.error('Failed to fetch channel partial', err);
                }
            }

            if (ch.type === ChannelType.DM) {
                user.send('Vui lòng sử dụng lệnh đăng ký trong kênh bang hội hoặc react vào tin nhắn bang chiến tuần để đăng ký tham gia. Bot chưa hỗ trợ tin nhắn DM.');
                return;
            }

            const guildId = reaction.message.guildId;
            const member = await reaction.message.guild.members.fetch(user.id);

            log.info(`Reaction added by ${user.id} on message ${reaction.message.id}: ${reaction.emoji.name}`);

            const giveaway = data.gaNgocGiveaway && data.gaNgocGiveaway[reaction.message.id];
            if (giveaway) {
                const ngocId = data.ingameEmoteIds && data.ingameEmoteIds.ngoc;
                if (ngocId && reaction.emoji.id === ngocId) {
                    giveaway.claimed = giveaway.claimed || {};
                    if (!giveaway.claimed[user.id]) {
                        giveaway.claimed[user.id] = true;
                        addNgoc(giveaway.guildId, user.id, giveaway.amount);
                        metrics.recordGangocClaim({ guildId: giveaway.guildId, amount: giveaway.amount, userId: user.id });
                        log.info(`User ${user.id} claimed ${giveaway.amount} ngọc from giveaway ${reaction.message.id}`);
                    }
                }
                return;
            }

            if (data.registrations && data.classVoteMessages && data.classVoteMessages.indexOf(reaction.message.id) !== -1) {
                let classIndex = -1;
                const emoteIds = data.emoteIds || [];
                if (emoteIds.length === CLASS_NAMES.length) {
                    if (reaction.emoji.id) classIndex = emoteIds.indexOf(reaction.emoji.id);
                } else {
                    const numeric = { '1️⃣': 0, '2️⃣': 1, '3️⃣': 2, '4️⃣': 3, '5️⃣': 4, '6️⃣': 5 };
                    classIndex = numeric[reaction.emoji.name] ?? -1;
                }

                if (classIndex === -1) return;

                const clsName = CLASS_NAMES[classIndex];
                data.registrations = data.registrations || {};
                data.registrations[guildId] = data.registrations[guildId] || {};
                if (!data.registrations[guildId][user.id]) {
                    data.registrations[guildId][user.id] = { tag: user.tag, displayName: member.displayName };
                }
                data.registrations[guildId][user.id].class = clsName;
                setUserRole(member, classIndex, reaction.message.guild);
                saveData();
                return;
            }

            if (!data.lastPostMessageId || !data.lastPostMessageId[guildId]) return;
            if (reaction.message.id !== data.lastPostMessageId[guildId]) return;

            if (!isValidTimeToRegister(guildId)) {
                log.info(`Registration closed for guild ${guildId}, ignoring reaction from user ${user.id}`);
                return;
            }

            const uid = user.id;
            if (reaction.emoji.name === '✅') {
                if (isAbsent(guildId, uid)) return;
                if (!data.registrations[guildId] || !data.registrations[guildId][uid]) {
                    data.registrations[guildId] = data.registrations[guildId] || {};
                    data.registrations[guildId][uid] = { tag: user.tag, displayName: member.displayName };
                }
                data.participants = data.participants || {};
                data.participants[guildId] = data.participants[guildId] || {};
                data.participants[guildId][uid] = true;
                grantIfNeeded(guildId, uid, data.lastPostMessageId[guildId]);
            } else if (reaction.emoji.name === '❌') {
                if (isParticipant(guildId, uid)) return;
                if (!data.registrations[guildId] || !data.registrations[guildId][uid]) {
                    data.registrations[guildId] = data.registrations[guildId] || {};
                    data.registrations[guildId][uid] = { tag: user.tag, displayName: member.displayName };
                }
                data.absents = data.absents || {};
                data.absents[guildId] = data.absents[guildId] || {};
                data.absents[guildId][uid] = true;
            }

            validateGuildMember(reaction.message.guild);
            saveData();

            await editMessage(guildId, reaction.message);
        } catch (e) {
            log.error('reactionAdd error', e);
        }
    }
};
