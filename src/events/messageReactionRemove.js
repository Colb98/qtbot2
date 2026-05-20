const { Events } = require('discord.js');
const log = require('../../logger');
const { data, saveData } = require('../state');
const { CLASS_NAMES } = require('../constants');
const { isValidTimeToRegister } = require('../utils');
const { removeUserRole } = require('../services/roles');
const { editMessage, validateGuildMember } = require('../services/guildWar');
const { revoke } = require('../services/bangChienReward');

module.exports = {
    name: Events.MessageReactionRemove,
    async execute(reaction, user) {
        try {
            if (user.bot) return;
            if (reaction.partial) await reaction.fetch();
            if (reaction.message.partial) await reaction.message.fetch();

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

                const guildId = reaction.message.guildId;
                const clsName = CLASS_NAMES[classIndex];
                data.registrations = data.registrations || {};
                if (!data.registrations[guildId][user.id] || !data.registrations[guildId][user.id].class) {
                    return;
                }

                if (data.registrations[guildId][user.id].class === clsName) {
                    delete data.registrations[guildId][user.id].class;
                    saveData();
                    const guild = reaction.message.guild;
                    const memberToRemove = await guild.members.fetch(user.id).catch(() => null);
                    if (memberToRemove) await removeUserRole(memberToRemove, reaction.message.guild);
                }
                return;
            }

            if (!isValidTimeToRegister(reaction.message.guildId)) return;
            const guildId = reaction.message.guildId;
            if (reaction.message.id === data.lastPostMessageId[guildId]) {
                const uid = user.id;
                if (reaction.emoji.name === '✅') {
                    validateGuildMember(reaction.message.guild);
                    if (data.participants && data.participants[guildId] && data.participants[guildId][uid]) {
                        delete data.participants[guildId][uid];
                        revoke(guildId, uid, data.lastPostMessageId[guildId]);
                        saveData();
                        await editMessage(guildId, reaction.message);
                    }
                } else if (reaction.emoji.name === '❌') {
                    validateGuildMember(reaction.message.guild);
                    if (data.absents && data.absents[guildId] && data.absents[guildId][uid]) {
                        delete data.absents[guildId][uid];
                        saveData();
                    }
                }
            }
        } catch (e) {
            log.error('reactionRemove error', e);
        }
    }
};
