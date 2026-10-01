const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const discord = require('discord.js');
const constants = require('../src/constants');

function load(file, mocks) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
        module, exports: module.exports, console, __dirname: path.dirname(path.join(__dirname, '..', file)),
        require: name => { if (name in mocks) return mocks[name]; throw Error(`Unexpected dependency: ${name}`); }
    }, { filename: file });
    return module.exports;
}

function fixture() {
    const data = { emoteIds: Array.from({ length: 7 }, (_, i) => `old-${i}`), classVoteMessages: ['12345678901234567'] };
    const state = { data, saveData() {} };
    const service = load('src/services/classSelection.js', { path, '../state': state, '../constants': constants });
    return { data, state, service };
}

test('old custom emotes and numeric reactions survive expanding to ten factions', () => {
    const { service } = fixture();
    assert.equal(service.getClassIndex({ id: 'old-6' }), 6);
    assert.equal(service.getClassIndex({ name: '7️⃣' }), 6);
    assert.equal(service.getClassIndex({ name: '🔟' }), 9);
    assert.equal(service.getClassIndex({ id: 'unrelated', name: '1️⃣' }), -1);
    assert.equal(service.getClassIndex({ name: '💰' }), -1);
});

test('emoji sync uploads only missing assets, preserves old IDs and is idempotent', async () => {
    const { data, service } = fixture();
    const emojis = new discord.Collection(data.emoteIds.map((id, i) => [id, { id, name: `class${constants.CLASS_SHORT[i].toLowerCase()}` }]));
    let creates = 0;
    const client = { guilds: { fetch: async () => ({ emojis: {
        fetch: async () => emojis,
        create: async ({ name, attachment }) => {
            assert.match(attachment, /emotes\/(HA|HC|TL)\.png$/);
            const emoji = { id: `new-${++creates}`, name };
            emojis.set(emoji.id, emoji);
            return emoji;
        }
    } }) } };
    await Promise.all([service.ensureClassEmotes(client), service.ensureClassEmotes(client)]);
    await service.ensureClassEmotes(client);
    assert.equal(creates, 3);
    assert.equal(data.emoteIds.length, 10);
    assert.equal(data.emoteIds[0], 'old-0');
    const reactions = [];
    await service.seedClassReactions({ react: async id => reactions.push(id) });
    assert.equal(reactions.length, 10);
    assert.match(service.selectionContent(), /Hồng Âm/);
    assert.match(service.selectionContent(), /Huyền Cơ/);
    assert.match(service.selectionContent(), /Thương Lan/);
});

test('updateclass edits and seeds an existing registered message with private confirmation', async () => {
    const { state, service } = fixture();
    let edits = 0, seeds = 0, uploads = 0;
    const command = load('src/commands/updateclass.js', {
        'discord.js': discord, '../state': state, '../utils': { isSuperAdmin: () => false },
        '../services/classSelection': { ...service, ensureClassEmotes: async () => uploads++, seedClassReactions: async () => seeds++ }
    });
    assert.equal(command.data.toJSON().name, 'updateclass');
    const message = { author: { id: 'bot' }, url: 'https://discord.com/channels/g/c/m', edit: async () => edits++ };
    const interaction = {
        guild: { id: 'g' }, guildId: 'g', user: { id: 'admin' }, client: { user: { id: 'bot' } },
        memberPermissions: new discord.PermissionsBitField(discord.PermissionFlagsBits.ManageGuild),
        options: { getString: () => '12345678901234567', getChannel: () => null },
        channel: { guildId: 'g', messages: { fetch: async () => message } },
        deferReply: async payload => assert.equal(payload.flags, discord.MessageFlags.Ephemeral),
        editReply: async content => { interaction.response = content; }
    };
    await command.execute(interaction);
    assert.equal(edits, 1);
    assert.equal(seeds, 1);
    assert.equal(uploads, 1);
    message.author.id = 'someone-else';
    await command.execute(interaction);
    assert.equal(edits, 1);
    assert.equal(uploads, 1);
    message.author.id = 'bot';
    state.data.classVoteMessages = [];
    await command.execute(interaction);
    assert.equal(edits, 1);
    interaction.memberPermissions = new discord.PermissionsBitField();
    interaction.reply = async payload => assert.equal(payload.flags, discord.MessageFlags.Ephemeral);
    await command.execute(interaction);
    assert.equal(edits, 1);
});

test('rapid faction changes leave only the latest faction and preserve unrelated roles', async () => {
    const roles = load('src/services/roles.js', {
        '../../logger': { info() {}, error() {} }, '../state': { data: {} },
        '../constants': { ...constants, ROLE_CHANGE_DELAY_MS: 0 }
    });
    const guildRoles = new discord.Collection(constants.CLASS_NAMES.map((name, i) => [`r${i}`, { id: `r${i}`, name }]));
    const memberRoles = new discord.Collection([['member', { id: 'member', name: 'Member' }], ['r0', guildRoles.get('r0')]]);
    const member = { id: 'u', roles: { cache: memberRoles,
        add: async role => { await Promise.resolve(); memberRoles.set(role.id, role); },
        remove: async roles => { for (const role of roles.values()) memberRoles.delete(role.id); }
    } };
    const guild = { id: 'g', roles: { cache: guildRoles } };
    await Promise.all([roles.setUserRole(member, 7, guild), roles.setUserRole(member, 8, guild), roles.setUserRole(member, 9, guild)]);
    assert.deepEqual([...memberRoles.keys()], ['member', 'r9']);
    await roles.removeUserRole(member, guild);
    assert.deepEqual([...memberRoles.keys()], ['member']);
});
