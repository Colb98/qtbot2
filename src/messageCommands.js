const fs = require('fs');
const path = require('path');
const { AttachmentBuilder } = require('discord.js');
const log = require('../logger');
const client = require('./client');
const { data, saveData } = require('./state');
const { CLASS_NAMES, MANAGER_ID, EMOTE_GUILD_ID, EMOTE_FILES } = require('./constants');
const { sanitizeIngame, isManager, isAbsent, isParticipant, isSuperAdmin } = require('./utils');
const { doWeeklyPost, sendReminders, sendListToManager, editMessage } = require('./services/guildWar');
const { updateGuildRoles, updateRoleIcons } = require('./services/roles');
const { testSendReminders } = require('./services/scheduler');
const { getWallet, addNganphieu, addNgoc, addItem, renderEmote, INGAME_EMOTE_NAMES, ITEM_KEYS, ITEM_LABELS } = require('./services/currency');
const { rollMany, formatRollResult, ROLL_COST, SUPPORTED_COUNTS } = require('./services/gacha');

async function handleMessageCommand(msg) {
    const parts = msg.content.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const guildId = msg.guildId;
    const member = await msg.guild.members.fetch(msg.author.id);

    if (cmd === '!register') {
        let name = parts.slice(1).join(' ');
        data.registrations = data.registrations || {};
        data.registrations[guildId] = data.registrations[guildId] || {};

        try {
            name = sanitizeIngame(name);
        } catch (e) {
            return msg.reply('Tên ingame không hợp lệ. Vui lòng chỉ sử dụng chữ cái, số, dấu cách, gạch dưới hoặc gạch ngang, và độ dài từ 2 đến 32 ký tự.');
        }

        if (!data.registrations[guildId][msg.author.id]) {
            data.registrations[guildId][msg.author.id] = { ingame: name, tag: msg.author.tag, displayName: member.displayName };
        } else {
            data.registrations[guildId][msg.author.id].ingame = name;
        }
        saveData();

        await msg.reply(`Đã đăng ký: **${name}** — **${data.registrations[guildId][msg.author.id].class}**. Bạn sẽ được thêm vào danh sách khi react ✅ vào tin bang chiến tuần.`);
        return;
    }

    if (cmd === '!kho_do') {
        const w = getWallet(guildId, msg.author.id);
        const lines = [
            `**Kho đồ của ${member.displayName}**`,
            `${renderEmote('nganphieu')} Ngân phiếu: **${w.nganphieu}**`,
            `${renderEmote('ngoc')} Ngọc: **${w.ngoc}**`
        ];
        for (const k of ITEM_KEYS) {
            lines.push(`${renderEmote(k)} ${ITEM_LABELS[k]}: **${w.items[k]}**`);
        }
        return msg.reply(lines.join('\n'));
    }

    if (cmd === '!doi_ngoc') {
        const n = parseInt(parts[1], 10);
        if (!Number.isInteger(n) || n <= 0) return msg.reply('Cú pháp: `!doi_ngoc <số lượng>` — đổi 100 ngân phiếu thành 1 ngọc.');
        const cost = n * 100;
        const w = getWallet(guildId, msg.author.id);
        if (w.nganphieu < cost) return msg.reply(`Bạn cần ${cost} ngân phiếu nhưng chỉ có ${w.nganphieu}.`);
        addNganphieu(guildId, msg.author.id, -cost);
        addNgoc(guildId, msg.author.id, n);
        const w2 = getWallet(guildId, msg.author.id);
        return msg.reply(`Đã đổi ${cost} ${renderEmote('nganphieu')} → ${n} ${renderEmote('ngoc')}. Số dư: ${w2.nganphieu} ngân phiếu, ${w2.ngoc} ngọc.`);
    }

    if (cmd === '!gacha') {
        const n = parts[1] ? parseInt(parts[1], 10) : 1;
        if (!SUPPORTED_COUNTS.includes(n)) return msg.reply(`Chỉ hỗ trợ \`!gacha\`, \`!gacha 10\`, \`!gacha 50\`.`);
        const cost = n * ROLL_COST;
        const w = getWallet(guildId, msg.author.id);
        if (w.ngoc < cost) return msg.reply(`Cần ${cost} ngọc để quay ${n} lần, bạn có ${w.ngoc}.`);
        addNgoc(guildId, msg.author.id, -cost);

        let shakeMsg;
        const shakeEmoteId = data.ingameEmoteIds && data.ingameEmoteIds.shake_tt;
        if (shakeEmoteId) {
            shakeMsg = await msg.reply({ content: renderEmote('shake_tt').repeat(Math.min(n, 5)) });
        } else {
            const gifPath = path.resolve('emotes/ingame/shake_tt.gif');
            shakeMsg = await msg.reply({ files: [new AttachmentBuilder(gifPath)] });
        }

        await new Promise(r => setTimeout(r, 5000));

        const counts = rollMany(n);
        for (const k of ITEM_KEYS) {
            if (counts[k] > 0) addItem(guildId, msg.author.id, k, counts[k]);
        }
        const result = formatRollResult(counts);
        await shakeMsg.edit({ content: `**${member.displayName}** quay ${n} lần (-${cost} ${renderEmote('ngoc')}):\n${result}`, attachments: [] }).catch(e => log.error('gacha edit error', e));
        return;
    }

    if (cmd === '!tang_ngoc') {
        const mention = parts[1];
        const amount = parseInt(parts[2], 10);
        if (!mention || !Number.isInteger(amount) || amount <= 0) {
            return msg.reply('Cú pháp: `!tang_ngoc @user <số lượng>`');
        }
        const targetId = mention.replace(/[^0-9]/g, '');
        if (!targetId) return msg.reply('Vui lòng mention user hợp lệ.');
        if (targetId === msg.author.id) return msg.reply('Không thể tự tặng chính mình.');
        const targetMember = await msg.guild.members.fetch(targetId).catch(() => null);
        if (!targetMember) return msg.reply('Không tìm thấy user trong server.');
        if (targetMember.user.bot) return msg.reply('Không tặng cho bot được.');
        const w = getWallet(guildId, msg.author.id);
        if (w.ngoc < amount) return msg.reply(`Bạn chỉ có ${w.ngoc} ngọc, không đủ tặng ${amount}.`);
        addNgoc(guildId, msg.author.id, -amount);
        addNgoc(guildId, targetId, amount);
        return msg.reply(`${member.displayName} đã tặng **${amount}** ${renderEmote('ngoc')} cho ${targetMember.displayName}.`);
    }

    if (cmd === '!ga_ngoc') {
        if (!isSuperAdmin(msg.author.id)) return;
        const amount = parseInt(parts[1], 10);
        if (!Number.isInteger(amount) || amount <= 0) return msg.reply('Cú pháp: `!ga_ngoc <số lượng>`');
        const ngocId = data.ingameEmoteIds && data.ingameEmoteIds.ngoc;
        if (!ngocId) return msg.reply('Chưa upload emote ngọc. Chạy `!upload_ingame_emotes` trước.');
        const emoji = client.emojis.cache.get(ngocId);
        const sent = await msg.channel.send({ content: `🎉 Super-admin tặng ${renderEmote('ngoc')} **${amount} ngọc**! React ${renderEmote('ngoc')} để nhận (1 lần/user).` });
        try {
            if (emoji) await sent.react(emoji);
            else await sent.react(ngocId);
        } catch (e) {
            log.warn('ga_ngoc react failed', e);
        }
        data.gaNgocGiveaway = data.gaNgocGiveaway || {};
        data.gaNgocGiveaway[sent.id] = { guildId, amount, claimed: {} };
        saveData();
        return;
    }

    if (cmd === '!upload_ingame_emotes') {
        if (!isSuperAdmin(msg.author.id)) return;
        if (msg.guildId !== EMOTE_GUILD_ID) {
            return msg.reply(`Lệnh này phải chạy trong emote guild. Current = ${msg.guildId}`);
        }
        const ids = data.ingameEmoteIds || {};
        const failures = [];
        for (const name of INGAME_EMOTE_NAMES) {
            const ext = name === 'shake_tt' ? 'gif' : 'png';
            const filePath = path.resolve(`emotes/ingame/${name}.${ext}`);
            if (!fs.existsSync(filePath)) {
                failures.push(`${name}: file missing`);
                continue;
            }
            try {
                const buffer = fs.readFileSync(filePath);
                const emoteName = `ig_${name}`;
                const existing = msg.guild.emojis.cache.find(e => e.name === emoteName);
                if (existing) await existing.delete('Recreate ingame emote').catch(() => {});
                const created = await msg.guild.emojis.create({ attachment: buffer, name: emoteName });
                ids[name] = created.id;
            } catch (e) {
                const detail = e.rawError ? JSON.stringify(e.rawError.errors) : (e.message || String(e));
                log.error(`upload_ingame_emotes error for ${name}`, e);
                failures.push(`${name} (${(fs.statSync(filePath).size/1024).toFixed(1)}KB): ${detail}`);
            }
        }
        data.ingameEmoteIds = ids;
        saveData();
        const okCount = Object.keys(ids).length;
        let reply = `Đã upload ${okCount}/${INGAME_EMOTE_NAMES.length} emote.`;
        if (failures.length) reply += `\nLỗi:\n\`\`\`${failures.join('\n')}\`\`\``;
        return msg.reply(reply);
    }

    if (!msg.member.permissions.has('ManageGuild') && !isManager(guildId, msg.author.id)) return;

    if (cmd === '!setup' && parts[1] === 'channel') {
        const channelMention = parts[2];
        if (!channelMention) return msg.reply('Cú pháp: `!setup channel #channel`');
        const id = channelMention.replace(/[^0-9]/g, '');
        data.channelId = data.channelId || {};
        data.channelId[msg.guildId] = id;
        data.guildId = data.guildId || [];
        data.guildId.push(msg.guildId);
        saveData();
        return msg.reply('Channel for weekly post set.');
    }

    if (cmd === '!setmanager') {
        const mention = parts[1];
        if (!mention) return msg.reply('Cú pháp: `!setmanager @user`');
        const id = mention.replace(/[^0-9]/g, '');
        data.managerId = data.managerId || {};
        data.managerId[guildId] = data.managerId[guildId] || [];
        data.managerId[guildId].push(id);
        saveData();
        return msg.reply('Manager set.');
    }

    if (cmd === '!sendlist') {
        await sendListToManager(guildId);
        return msg.reply('Sent participant list to manager.');
    }

    if (cmd === '!postnow' && msg.author.id === MANAGER_ID) {
        const id = data.channelId ? data.channelId[guildId] : null;
        if (id) {
            await doWeeklyPost([id]);
            return msg.reply('Posted signup message now.');
        }
        return msg.reply('Please use this command in a valid Discord server (register with `!setup channel #channel`).');
    }

    if (cmd === '!remindnow' && msg.author.id === MANAGER_ID) {
        await sendReminders();
        return msg.reply('Sent reminders now.');
    }

    if (cmd === '!updateroles' && msg.author.id === MANAGER_ID) {
        await updateGuildRoles(msg.guild);
        return msg.reply('Updated roles now.');
    }

    if (cmd === '!voteclass') {
        const instruction = await msg.channel.send({
            content: `React vào 1 trong các biểu tượng dưới đây để chọn môn phái đang chơi.\nNếu muốn huỷ, hãy remove reaction.\nChỉ tính reaction đầu tiên`
        });
        const emoteIds = data.emoteIds || [];

        if (emoteIds.length === CLASS_NAMES.length) {
            for (const id of emoteIds) {
                try {
                    const emoji = client.emojis.cache.get(id);
                    if (emoji) {
                        await instruction.react(emoji);
                    } else {
                        await instruction.react('🔢');
                    }
                } catch (e) {
                    log.warn('react fallback', e);
                    await instruction.react('🔢');
                }
            }
        } else {
            const numeric = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
            for (const r of numeric) await instruction.react(r).catch(() => { });
        }

        data.classVoteMessages = data.classVoteMessages || [];
        data.classVoteMessages.push(instruction.id);
        saveData();
        return;
    }

    if (cmd === '!testreminders' && msg.author.id === MANAGER_ID) {
        const day = parts[1];
        const hour = parts[2];
        const minute = parts[3];
        if (!day || !hour || !minute) return msg.reply('Cú pháp: `!testreminders <day> <hour> <minute>`');
        testSendReminders(day, hour, minute);
        return msg.reply(`Scheduled test reminders on ${day} at ${hour}:${minute}`);
    }

    if (cmd === '!refreshreactions' && msg.author.id === MANAGER_ID) {
        const lastPostMessageId = data.lastPostMessageId && data.lastPostMessageId[guildId];
        const channel = msg.guild.channels.cache.get(data.channelId[guildId]);
        const lastPostMessage = await channel.messages.fetch(lastPostMessageId);
        log.info(`Refreshing reactions for message ${lastPostMessageId}`);
        data.participants[guildId] = {};
        data.absents[guildId] = {};

        for (const reaction of lastPostMessage.reactions.cache.values()) {
            const users = await reaction.users.fetch();
            log.info(`Checking reaction ${reaction.emoji.name} for message ${lastPostMessageId} with users ${reaction.users.cache.map(u => u.id).join(', ')}`);

            for (const [uid, user] of users) {
                if (user.bot) continue;

                if (reaction.emoji.name === '✅') {
                    if (!isAbsent(guildId, uid)) {
                        data.participants = data.participants || {};
                        data.participants[guildId] = data.participants[guildId] || {};
                        data.participants[guildId][uid] = true;
                    }
                } else if (reaction.emoji.name === '❌') {
                    if (!isParticipant(guildId, uid)) {
                        data.absents = data.absents || {};
                        data.absents[guildId] = data.absents[guildId] || {};
                        data.absents[guildId][uid] = true;
                    }
                }
            }
            saveData();
            editMessage(guildId, lastPostMessage);
        }
        return;
    }

    if (cmd === '!updateroleicons' && msg.author.id === MANAGER_ID) {
        await updateRoleIcons(msg.guild);
        const classVoteMessages = data.classVoteMessages || [];
        for (const messageId of classVoteMessages) {
            const message = await msg.channel.messages.fetch(messageId).catch(() => null);
            if (!message) continue;
            const emoteIds = data.emoteIds || [];
            if (emoteIds.length !== CLASS_NAMES.length) {
                log.error('Emote IDs and class names length mismatch');
                continue;
            }
            for (const id of emoteIds) {
                try {
                    const emoji = client.emojis.cache.get(id);
                    if (emoji) {
                        await message.react(emoji);
                    } else {
                        log.warn('Emoji not found', { id });
                    }
                } catch (e) {
                    log.warn('react failed', e);
                }
            }
        }
        return msg.reply('Updated role icons.');
    }

    if (cmd === '!uploademotes' && msg.author.id === MANAGER_ID) {
        try {
            const guild = msg.guild;
            if (!guild || msg.guildId !== EMOTE_GUILD_ID) {
                return msg.reply(`This command must be run inside a valid guild. Current Guild ID = ${msg.guildId}`);
            }
            const createdIds = [];
            for (let i = 0; i < EMOTE_FILES.length; i++) {
                const filePath = EMOTE_FILES[i];
                const name = `class${filePath.replace('.png', '').replace('emotes/', '').toLowerCase()}`;
                const buffer = fs.readFileSync(path.resolve(filePath));
                const existing = guild.emojis.cache.find(e => e.name === name);
                if (existing) {
                    await existing.delete('Recreating emoji for bot setup').catch(() => { });
                }
                const created = await guild.emojis.create({ attachment: buffer, name });
                createdIds.push(created.id);
            }
            data.emoteIds = createdIds;
            saveData();
            await msg.reply('Uploaded emotes and saved IDs. Ready for DM-based registration.');
        } catch (e) {
            log.error('uploademotes error', e);
            await msg.reply('Failed to upload emotes: ' + (e.message || e));
        }
        return;
    }

    if (cmd === '!help') {
        const helpText = `
            **Tiền tệ & Gacha:**
            • \`!kho_do\` — Xem kho đồ (ngân phiếu, ngọc, vật phẩm).
            • \`!doi_ngoc <n>\` — Đổi 100 ngân phiếu → 1 ngọc (đổi n ngọc tốn 100n ngân phiếu).
            • \`!gacha\` / \`!gacha 10\` / \`!gacha 50\` — Quay gacha, 100 ngọc/lần.
            • \`!tang_ngoc @user <n>\` — Tặng ngọc cho người khác.
            • Chat trong server: +1000 ngân phiếu/tin (cap 1000 tin/ngày).
            • Báo danh bang chiến: +100 ngọc/lần, huỷ -100 ngọc.

            **Admin Commands:**
            • \`!setup channel #channel\` — Set the channel for weekly signup posts.
            • \`!setmanager @user\` — Set a user as manager to receive participant lists.
            • \`!postnow\` — DEV ONLY — Post the weekly signup message immediately.
            • \`!remindnow\` — DEV ONLY — Send reminders to participants immediately.
            • \`!testreminders <day> <hour> <minute>\` — DEV ONLY — Schedule a one-time test reminder.
            • \`!sendlist\` — Send the current participant list to the manager.
            • \`!voteclass\` — Post a message for users to vote their class via reactions.
            • \`!uploademotes\` — DEV ONLY — Upload class emotes to the guild (requires Manage Emojis permission).
            • \`!upload_ingame_emotes\` — DEV ONLY — Upload ingame item emotes.
            • \`!ga_ngoc <n>\` — DEV ONLY — Post a ngọc giveaway, users react to claim.
        `;
        await msg.reply(helpText);
        return;
    }
}

module.exports = { handleMessageCommand };
