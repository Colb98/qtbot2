const log = require('../../logger');
const { data } = require('../state');
const { CLASS_NAMES, CLASS_COLOR, EMOTE_FILES, ROLE_CHANGE_DELAY_MS } = require('../constants');

let lastChangeRoleTime = 0;

async function setUserRole(member, classIndex, guild) {
    log.info(`Add role for user ${member.id} in guild ${guild.id}, check timeout ${lastChangeRoleTime + ROLE_CHANGE_DELAY_MS - Date.now()} ms`);
    while (lastChangeRoleTime + ROLE_CHANGE_DELAY_MS > Date.now()) {
        await new Promise(resolve => setTimeout(resolve, ROLE_CHANGE_DELAY_MS));
    }

    const existingRole = guild.roles.cache.find(r => r.name === CLASS_NAMES[classIndex]);
    if (member.roles.cache.has(existingRole?.id)) {
        log.info(`User ${member.id} already has role ${existingRole.name}, skipping`);
        return;
    }

    if (existingRole) {
        await member.roles.add(existingRole);
    } else {
        try {
            log.info(`Creating role ${classIndex}, name ${CLASS_NAMES[classIndex]}`);
            const roleInfo = {
                name: CLASS_NAMES[classIndex],
                colors: { primaryColor: CLASS_COLOR[classIndex] },
                reason: 'Class role created for registration'
            };
            const guildBoostLv2 = guild.premiumTier >= 2;
            if (guildBoostLv2) {
                roleInfo.icon = './' + EMOTE_FILES[classIndex];
            }
            const createdRole = await guild.roles.create(roleInfo);
            await member.roles.add(createdRole);
        } catch (e) {
            log.error('setUserRole error', e);
            throw e;
        }
    }
    lastChangeRoleTime = Date.now();
}

async function removeUserRole(member, guild) {
    log.info(`Removing roles for user ${member.id} in guild ${guild.id}, check timeout ${lastChangeRoleTime + ROLE_CHANGE_DELAY_MS - Date.now()} ms`);
    if (lastChangeRoleTime + ROLE_CHANGE_DELAY_MS > Date.now()) {
        await new Promise(resolve => setTimeout(resolve, ROLE_CHANGE_DELAY_MS));
    }
    if (member.roles.cache.some(r => CLASS_NAMES.includes(r.name))) {
        await member.roles.remove(member.roles.cache.filter(r => CLASS_NAMES.includes(r.name)));
    } else {
        log.info(`User ${member.id} has no class role, skipping`);
        return;
    }
    lastChangeRoleTime = Date.now();
}

async function updateGuildRoles(guild) {
    log.info(`Updating roles for guild ${guild.id} ${guild.name}`);
    const guildId = guild.id;

    const members = await guild.members.fetch();
    for (const member of members.values()) {
        if (member.user.bot) continue;
        try {
            const userId = member.id;
            const classIndex = CLASS_NAMES.indexOf(data.registrations[guildId][userId]?.class);
            log.info(`Setting role for user ${userId} ${member.displayName}, className: ${CLASS_NAMES[classIndex]}`);
            if (classIndex !== -1) {
                await setUserRole(member, classIndex, guild);
            } else {
                await removeUserRole(member, guild);
            }
        } catch (e) {
            break;
        }
    }
}

async function updateRoleIcons(guild) {
    if (!guild) return;
    try {
        const updatedGuild = await guild.fetch();
        for (const [classIndex, className] of CLASS_NAMES.entries()) {
            const role = updatedGuild.roles.cache.find(r => r.name === className);
            const guildBoostLv2 = updatedGuild.premiumTier >= 2;
            if (role && guildBoostLv2) {
                await role.setIcon('./' + EMOTE_FILES[classIndex]);
            }
        }
    } catch (e) {
        log.error('updateRoleIcons error', e);
    }
}

module.exports = { setUserRole, removeUserRole, updateGuildRoles, updateRoleIcons };
