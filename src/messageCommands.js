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
const { getWallet, addNganphieu, addNgoc, addItem, renderEmote, tryClaimDaily, fmt, INGAME_EMOTE_NAMES, ITEM_KEYS, ITEM_LABELS } = require('./services/currency');
const { rollMany, formatRollResult, ROLL_COST, SUPPORTED_COUNTS, getPityStatus } = require('./services/gacha');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const economy = require('./config/economy');

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

    if (cmd === '!help') {
        const userHelp = `
            **Tiền tệ & Gacha:**
            • \`!khodo\` — Xem kho đồ (ngân phiếu, ngọc, vật phẩm).
            • \`!daily\` — Nhận thưởng hàng ngày (1 lần/ngày).
            • \`!doingoc <n>\` / \`!doingoc all\` — Đổi ngân phiếu → 1 ngọc. Dùng \`all\` để đổi hết.
            • \`!doithienthuong <n>\` — Đổi ${economy.TT_PER_CAO} thiên thưởng → 1 cáo.
            • \`!gacha\` / \`!gacha <1-50>\` / \`!gacha all\` — Quay gacha, ${fmt(economy.GACHA.ROLL_COST)} ngọc/lần. Có pity ở lượt 20 (KT+) / 200 (TT).
            • \`!pity\` — Xem số lượt còn lại đến pity đảm bảo.
            • \`!toptt\` — Top 10 người có nhiều thiên thưởng (cáo tính 3 thiên thưởng).
            • \`!topngoc\` — Top 10 người có nhiều ngọc.
            • \`!coinflip <x>\` / \`!coinflip <sap|ngua> <x>\` — Cược x ngọc, 50/50 win/lose.
            • \`!tangngoc @user <n|all>\` — Tặng ngọc cho người khác.
            • \`!tangthienthuong @user [n|all]\` — Tặng thiên thưởng cho người khác.
            • \`!banthienthuong <n|all>\` — Bán thiên thưởng → ${fmt(economy.ROLLS_PER_THIENTHUONG * economy.GACHA.ROLL_COST)} ngọc/cái.
            • \`!bancao <n|all>\` — Bán cáo → ${fmt(economy.ROLLS_PER_THIENTHUONG * economy.GACHA.ROLL_COST * economy.TT_PER_CAO)} ngọc/cái.
            • Chat trong server: +${fmt(economy.CHAT_REWARD)} ngân phiếu/tin (cap ${fmt(economy.CHAT_DAILY_CAP)} tin/ngày).
            • Daily: +${fmt(economy.DAILY_REWARD.nganphieuMin)}-${fmt(economy.DAILY_REWARD.nganphieuMax)} ngân phiếu (random).
            • Báo danh bang chiến: +${fmt(economy.BANG_CHIEN_REWARD)} ngọc/lần, huỷ -${fmt(economy.BANG_CHIEN_REWARD)} ngọc.
        `;
        const devHelp = `

            **Admin / Dev Commands:**
            • \`!setup channel #channel\` — Set the channel for weekly signup posts.
            • \`!setmanager @user\` — Set a user as manager to receive participant lists.
            • \`!postnow\` — Post the weekly signup message immediately.
            • \`!remindnow\` — Send reminders to participants immediately.
            • \`!testreminders <day> <hour> <minute>\` — Schedule a one-time test reminder.
            • \`!sendlist\` — Send the current participant list to the manager.
            • \`!voteclass\` — Post a message for users to vote their class via reactions.
            • \`!uploademotes\` — Upload class emotes to the guild (requires Manage Emojis permission).
            • \`!upload_ingame_emotes\` — Upload ingame item emotes.
            • \`!gangoc <n> [#kênh]\` — Post a ngọc giveaway, users react to claim. Dùng #kênh để chỉ định kênh gửi.
        `;
        const helpText = isSuperAdmin(msg.author.id) ? (userHelp + devHelp) : userHelp;
        await msg.reply(helpText);
        return;
    }

    if (cmd === '!khodo') {
        const w = getWallet(guildId, msg.author.id);
        const lines = [
            `**Kho đồ của ${member.displayName}**`,
            `${renderEmote('nganphieu')} Ngân phiếu: **${fmt(w.nganphieu)}**`,
            `${renderEmote('ngoc')} Ngọc: **${fmt(w.ngoc)}**`
        ];
        for (const k of ITEM_KEYS) {
            lines.push(`${renderEmote(k)} ${ITEM_LABELS[k]}: **${fmt(w.items[k])}**`);
        }
        return msg.reply(lines.join('\n'));
    }

    if (cmd === '!doingoc') {
        let n;
        const w = getWallet(guildId, msg.author.id);
        if (parts[1] === 'all') {
            n = Math.floor(w.nganphieu / economy.NGAN_PHIEU_PER_NGOC);
            if (n <= 0) return msg.reply(`Bạn không có đủ ngân phiếu để đổi. Cần ít nhất ${fmt(economy.NGAN_PHIEU_PER_NGOC)}.`);
        } else {
            n = parseInt(parts[1], 10);
            if (!Number.isInteger(n) || n <= 0) return msg.reply(`Cú pháp: \`!doingoc <số lượng>\` hoặc \`!doingoc all\` — đổi ${fmt(economy.NGAN_PHIEU_PER_NGOC)} ngân phiếu thành 1 ngọc.`);
        }
        const cost = n * economy.NGAN_PHIEU_PER_NGOC;
        if (w.nganphieu < cost) return msg.reply(`Bạn cần ${fmt(cost)} ngân phiếu nhưng chỉ có ${fmt(w.nganphieu)}.`);
        addNganphieu(guildId, msg.author.id, -cost);
        addNgoc(guildId, msg.author.id, n);
        const w2 = getWallet(guildId, msg.author.id);
        return msg.reply(`Đã đổi ${fmt(cost)} ${renderEmote('nganphieu')} → ${fmt(n)} ${renderEmote('ngoc')}. Số dư: ${fmt(w2.nganphieu)} ngân phiếu, ${fmt(w2.ngoc)} ngọc.`);
    }

    if (cmd === '!gacha') {
        let n;
        if (parts[1] === 'all') {
            const w = getWallet(guildId, msg.author.id);
            n = Math.floor(w.ngoc / ROLL_COST);
            if (n <= 0) return msg.reply(`Bạn không có đủ ngọc để quay. Cần ít nhất ${fmt(ROLL_COST)} ngọc.`);
            const cost = n * ROLL_COST;
            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`gacha_all_confirm:${msg.author.id}`)
                    .setLabel('Xác nhận')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`gacha_all_cancel:${msg.author.id}`)
                    .setLabel('Huỷ')
                    .setStyle(ButtonStyle.Danger)
            );
            return msg.reply({ content: `Bạn sắp quay **${fmt(n)}** lần (-${fmt(cost)} ${renderEmote('ngoc')}). Xác nhận?`, components: [confirmRow] });
        } else {
            n = parts[1] ? parseInt(parts[1], 10) : 1;
            if (!Number.isInteger(n) || n < 1 || n > 50) return msg.reply(`Chỉ hỗ trợ từ 1 đến 50 lần. Dùng \`!gacha all\` để quay hết ngọc.`);
        }
        const cost = n * ROLL_COST;
        const w = getWallet(guildId, msg.author.id);
        if (w.ngoc < cost) return msg.reply(`Cần ${fmt(cost)} ngọc để quay ${fmt(n)} lần, bạn có ${fmt(w.ngoc)}.`);
        addNgoc(guildId, msg.author.id, -cost);

        let shakeMsg;
        const shakeEmoteId = data.ingameEmoteIds && data.ingameEmoteIds.shake_tt;
        if (shakeEmoteId) {
            shakeMsg = await msg.reply({ content: renderEmote('shake_tt').repeat(Math.min(n, 5)) });
        } else {
            const gifPath = path.resolve('emotes/ingame/shake_tt.gif');
            shakeMsg = await msg.reply({ files: [new AttachmentBuilder(gifPath)] });
        }

        await new Promise(r => setTimeout(r, 2000));

        const wallet = getWallet(guildId, msg.author.id);
        const counts = rollMany(n, wallet.pity);
        for (const k of ITEM_KEYS) {
            if (counts[k] > 0) addItem(guildId, msg.author.id, k, counts[k]);
        }
        saveData();
        const result = formatRollResult(counts);
        await shakeMsg.edit({ content: `**${member.displayName}** quay ${fmt(n)} lần (-${fmt(cost)} ${renderEmote('ngoc')}):\n${result}`, attachments: [] }).catch(e => log.error('gacha edit error', e));
        return;
    }

    if (cmd === '!daily') {
        const res = tryClaimDaily(guildId, msg.author.id);
        if (!res.claimed) return msg.reply('Bạn đã nhận daily hôm nay rồi. Quay lại sau 00:00.');
        const r = res.reward;
        return msg.reply(`🎁 Daily của ${member.displayName}: +${fmt(r.nganphieu)} ${renderEmote('nganphieu')}.`);
    }

    if (cmd === '!doithienthuong') {
        const n = parseInt(parts[1], 10);
        if (!Number.isInteger(n) || n <= 0) return msg.reply(`Cú pháp: \`!doithienthuong <số lượng cáo>\` — đổi ${economy.TT_PER_CAO} thiên thưởng thành 1 cáo.`);
        const cost = n * economy.TT_PER_CAO;
        const w = getWallet(guildId, msg.author.id);
        if (w.items.thienthuong < cost) return msg.reply(`Cần ${fmt(cost)} ${renderEmote('thienthuong')} nhưng chỉ có ${fmt(w.items.thienthuong)}.`);
        addItem(guildId, msg.author.id, 'thienthuong', -cost);
        addItem(guildId, msg.author.id, 'cao', n);
        const w2 = getWallet(guildId, msg.author.id);
        return msg.reply(`Đã đổi ${fmt(cost)} ${renderEmote('thienthuong')} → ${fmt(n)} ${renderEmote('cao')}. Số dư: ${fmt(w2.items.thienthuong)} thiên thưởng, ${fmt(w2.items.cao)} cáo.`);
    }

    if (cmd === '!tangthienthuong') {
        const mention = parts[1];
        if (!mention) return msg.reply('Cú pháp: `!tangthienthuong @user [số lượng|all]` (mặc định 1)');
        const targetId = mention.replace(/[^0-9]/g, '');
        if (!targetId) return msg.reply('Vui lòng mention user hợp lệ.');
        if (targetId === msg.author.id) return msg.reply('Không thể tự tặng chính mình.');
        const targetMember = await msg.guild.members.fetch(targetId).catch(() => null);
        if (!targetMember) return msg.reply('Không tìm thấy user trong server.');
        if (targetMember.user.bot) return msg.reply('Không tặng cho bot được.');
        const w = getWallet(guildId, msg.author.id);
        let amount;
        if (parts[2] === 'all') {
            amount = w.items.thienthuong;
            if (amount <= 0) return msg.reply('Bạn không có thiên thưởng để tặng.');
        } else {
            amount = parts[2] ? parseInt(parts[2], 10) : 1;
            if (!Number.isInteger(amount) || amount <= 0) return msg.reply('Cú pháp: `!tangthienthuong @user [số lượng|all]`');
            if (w.items.thienthuong < amount) return msg.reply(`Bạn chỉ có ${fmt(w.items.thienthuong)} thiên thưởng, không đủ tặng ${fmt(amount)}.`);
        }
        addItem(guildId, msg.author.id, 'thienthuong', -amount);
        addItem(guildId, targetId, 'thienthuong', amount);
        return msg.reply(`${member.displayName} đã tặng **${fmt(amount)}** ${renderEmote('thienthuong')} cho ${targetMember.displayName}.`);
    }

    if (cmd === '!tangngoc') {
        const mention = parts[1];
        if (!mention) return msg.reply('Cú pháp: `!tangngoc @user <số lượng|all>`');
        const targetId = mention.replace(/[^0-9]/g, '');
        if (!targetId) return msg.reply('Vui lòng mention user hợp lệ.');
        if (targetId === msg.author.id) return msg.reply('Không thể tự tặng chính mình.');
        const targetMember = await msg.guild.members.fetch(targetId).catch(() => null);
        if (!targetMember) return msg.reply('Không tìm thấy user trong server.');
        if (targetMember.user.bot) return msg.reply('Không tặng cho bot được.');
        const w = getWallet(guildId, msg.author.id);
        let amount;
        if (parts[2] === 'all') {
            amount = w.ngoc;
            if (amount <= 0) return msg.reply('Bạn không có ngọc để tặng.');
        } else {
            amount = parseInt(parts[2], 10);
            if (!Number.isInteger(amount) || amount <= 0) return msg.reply('Cú pháp: `!tangngoc @user <số lượng|all>`');
            if (w.ngoc < amount) return msg.reply(`Bạn chỉ có ${fmt(w.ngoc)} ngọc, không đủ tặng ${fmt(amount)}.`);
        }
        addNgoc(guildId, msg.author.id, -amount);
        addNgoc(guildId, targetId, amount);
        return msg.reply(`${member.displayName} đã tặng **${fmt(amount)}** ${renderEmote('ngoc')} cho ${targetMember.displayName}.`);
    }

    if (cmd === '!banthienthuong' || cmd === '!bancao') {
        const isCao = cmd === '!bancao';
        const itemKey = isCao ? 'cao' : 'thienthuong';
        const itemLabel = isCao ? 'cáo' : 'thiên thưởng';
        const pricePerUnit = isCao
            ? economy.ROLLS_PER_THIENTHUONG * ROLL_COST * economy.TT_PER_CAO
            : economy.ROLLS_PER_THIENTHUONG * ROLL_COST;
        const w = getWallet(guildId, msg.author.id);
        let n;
        if (parts[1] === 'all') {
            n = w.items[itemKey];
            if (n <= 0) return msg.reply(`Bạn không có ${itemLabel} để bán.`);
        } else {
            n = parseInt(parts[1], 10);
            if (!Number.isInteger(n) || n <= 0) return msg.reply(`Cú pháp: \`${cmd} <số lượng|all>\` — bán 1 ${itemLabel} = ${fmt(pricePerUnit)} ngọc.`);
            if (w.items[itemKey] < n) return msg.reply(`Bạn chỉ có ${fmt(w.items[itemKey])} ${itemLabel}, không đủ bán ${fmt(n)}.`);
        }
        const gained = n * pricePerUnit;
        addItem(guildId, msg.author.id, itemKey, -n);
        addNgoc(guildId, msg.author.id, gained);
        const w2 = getWallet(guildId, msg.author.id);
        return msg.reply(`Đã bán ${fmt(n)} ${renderEmote(itemKey)} → ${fmt(gained)} ${renderEmote('ngoc')}. Số dư: ${fmt(w2.items[itemKey])} ${itemLabel}, ${fmt(w2.ngoc)} ngọc.`);
    }

    if (cmd === '!gangoc') {
        if (!isSuperAdmin(msg.author.id)) return;
        let amount = null;
        let targetChannel = msg.channel;
        let channelMention = null;
        for (let i = 1; i < parts.length; i++) {
            const part = parts[i];
            if (part.startsWith('<#') && part.endsWith('>')) {
                channelMention = part.replace(/[^0-9]/g, '');
            } else {
                const parsed = parseInt(part, 10);
                if (Number.isInteger(parsed) && parsed > 0) {
                    amount = parsed;
                }
            }
        }
        if (!Number.isInteger(amount) || amount <= 0) return msg.reply('Cú pháp: `!gangoc <số lượng> [#kênal]`');
        if (channelMention) {
            targetChannel = await msg.guild.channels.fetch(channelMention).catch(() => null);
            if (!targetChannel) return msg.reply('Không tìm thấy kênh được chỉ định.');
        }
        const ngocId = data.ingameEmoteIds && data.ingameEmoteIds.ngoc;
        if (!ngocId) return msg.reply('Chưa upload emote ngọc. Chạy `!upload_ingame_emotes` trước.');
        const emoji = client.emojis.cache.get(ngocId);
        const sent = await targetChannel.send({ content: `🎉 Server tặng ${renderEmote('ngoc')} **${fmt(amount)} ngọc**! React ${renderEmote('ngoc')} để nhận (1 lần/user).` });
        try {
            if (emoji) await sent.react(emoji);
            else await sent.react(ngocId);
        } catch (e) {
            log.warn('ga_ngoc react failed', e);
        }
        data.gaNgocGiveaway = data.gaNgocGiveaway || {};
        data.gaNgocGiveaway[sent.id] = { guildId, amount, claimed: {} };
        saveData();
        return msg.reply(`✅ GA ngọc **${fmt(amount)}** đã được đăng lên ${targetChannel}`);
    }

    if (cmd === '!pity') {
        const w = getWallet(guildId, msg.author.id);
        const { ttLeft, ktLeft } = getPityStatus(w.pity);
        const lines = [
            `**Pity của ${member.displayName}**`,
            `Kỳ Thưởng: còn **${fmt(ktLeft)}** lượt (lượt thứ 20 đảm bảo Kỳ Thưởng+)`,
            `Thiên Thưởng: còn **${fmt(ttLeft)}** lượt (lượt thứ 200 đảm bảo Thiên Thưởng)`
        ];
        return msg.reply(lines.join('\n'));
    }

    if (cmd === '!toptt') {
        const wallets = data.wallet && data.wallet[guildId];
        if (!wallets) return msg.reply('Chưa có người nào đăng ký.');
        const rankings = [];
        for (const [userId, w] of Object.entries(wallets)) {
            if (!w.items) continue;
            const score = w.items.thienthuong + (w.items.cao * economy.TT_PER_CAO);
            if (score > 0) rankings.push({ userId, score, cao: w.items.cao, tt: w.items.thienthuong });
        }
        rankings.sort((a, b) => b.score - a.score);
        const top = rankings.slice(0, 10);
        if (top.length === 0) return msg.reply('Chưa có ai có thiên thưởng.');
        const lines = ['**Top 10 Thiên Thưởng**'];
        for (let i = 0; i < top.length; i++) {
            const { userId, score, cao, tt } = top[i];
            let name = userId;
            try {
                const member = await msg.guild.members.fetch(userId).catch(() => null);
                if (member) name = member.displayName;
            } catch (e) {}
            lines.push(`${i + 1}. **${name}**: ${fmt(tt)} ${renderEmote('thienthuong')} + ${fmt(cao)} ${renderEmote('cao')} = **${fmt(score)}** điểm`);
        }
        return msg.reply(lines.join('\n'));
    }

    if (cmd === '!topngoc') {
        const wallets = data.wallet && data.wallet[guildId];
        if (!wallets) return msg.reply('Chưa có người nào đăng ký.');
        const rankings = [];
        for (const [userId, w] of Object.entries(wallets)) {
            if (w.ngoc && w.ngoc > 0) rankings.push({ userId, ngoc: w.ngoc });
        }
        rankings.sort((a, b) => b.ngoc - a.ngoc);
        const top = rankings.slice(0, 10);
        if (top.length === 0) return msg.reply('Chưa có ai có ngọc.');
        const lines = ['**Top 10 Ngọc**'];
        for (let i = 0; i < top.length; i++) {
            const { userId, ngoc } = top[i];
            let name = userId;
            try {
                const member = await msg.guild.members.fetch(userId).catch(() => null);
                if (member) name = member.displayName;
            } catch (e) {}
            lines.push(`${i + 1}. **${name}**: ${fmt(ngoc)} ${renderEmote('ngoc')}`);
        }
        return msg.reply(lines.join('\n'));
    }

    if (cmd === '!coinflip') {
        let side = null;
        let amount = null;
        if (parts[1] === 'sap' || parts[1] === 'ngua') {
            side = parts[1];
            amount = parseInt(parts[2], 10);
        } else {
            amount = parseInt(parts[1], 10);
        }
        if (!Number.isInteger(amount) || amount <= 0) {
            return msg.reply(`Cú pháp: \`!coinflip <số ngọc>\` hoặc \`!coinflip <sap|ngua> <số ngọc>\``);
        }
        const w = getWallet(guildId, msg.author.id);
        if (w.ngoc < amount) return msg.reply(`Bạn cần ${fmt(amount)} ngọc nhưng chỉ có ${fmt(w.ngoc)}.`);
        const result = Math.random() < 0.5 ? 'sap' : 'ngua';
        const won = side ? (side === result) : (Math.random() < 0.5);
        if (won) {
            addNgoc(guildId, msg.author.id, amount);
            if (side) {
                return msg.reply(`🪙 Kết quả: **${result === 'sap' ? 'Sấp' : 'Ngửa'}**\nBạn đoán: **${side === 'sap' ? 'Sấp' : 'Ngửa'}**\n🎉 Thắng! +${fmt(amount)} ${renderEmote('ngoc')}`);
            } else {
                return msg.reply(`🪙 Kết quả: **${result === 'sap' ? 'Sấp' : 'Ngửa'}**\n🎉 Thắng! +${fmt(amount)} ${renderEmote('ngoc')}`);
            }
        } else {
            addNgoc(guildId, msg.author.id, -amount);
            if (side) {
                return msg.reply(`🪙 Kết quả: **${result === 'sap' ? 'Sấp' : 'Ngửa'}**\nBạn đoán: **${side === 'sap' ? 'Sấp' : 'Ngửa'}**\n😢 Thua! -${fmt(amount)} ${renderEmote('ngoc')}`);
            } else {
                return msg.reply(`🪙 Kết quả: **${result === 'sap' ? 'Sấp' : 'Ngửa'}**\n😢 Thua! -${fmt(amount)} ${renderEmote('ngoc')}`);
            }
        }
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

}

module.exports = { handleMessageCommand };
