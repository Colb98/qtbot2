const fs = require('fs');
const path = require('path');
const { AttachmentBuilder } = require('discord.js');
const log = require('../logger');
const client = require('./client');
const { data, saveData } = require('./state');
const { CLASS_NAMES, MANAGER_ID, EMOTE_GUILD_ID, EMOTE_FILES } = require('./constants');
const { sanitizeIngame, isManager, isAbsent, isParticipant, isSuperAdmin, checkGameCooldown, replyEphemeral, replyChunked } = require('./utils');
const { isMaintenance, setMaintenance, isBlockedByMaintenance } = require('./services/maintenance');
const { doWeeklyPost, sendReminders, sendListToManager, editMessage } = require('./services/guildWar');
const { updateGuildRoles, updateRoleIcons } = require('./services/roles');
const { testSendReminders } = require('./services/scheduler');
const { getWallet, addNganphieu, addNgoc, addItem, addLockedNgoc, addLockedItem, spendNgocForGame, renderEmote, tryClaimDaily, fmt, INGAME_EMOTE_NAMES, ITEM_KEYS, ITEM_LABELS } = require('./services/currency');
const { rollMany, formatRollResult, ROLL_COST, SUPPORTED_COUNTS, getPityStatus } = require('./services/gacha');
const { runMultiRoll: runSlotMultiRoll, SLOT_MAX_ROLLS } = require('./services/slot');
const { buildContinueButtons: buildCoinflipButtons, formatResult: formatCoinflipResult } = require('./services/coinflip');
const dice = require('./services/dice');
const lottery = require('./services/lottery');
const metrics = require('./services/metrics');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const economy = require('./config/economy');
const { CURRENT_VERSION, CHANGELOG } = require('./config/changelog');
const wordchainEng = require('./services/wordchainEng');
const vuaTiengViet = require('./services/vuaTiengViet');
const bond = require('./services/bond');
const profileCmd = require('./commands/profile');
const profile = require('./services/profile');

const BLOCKED_GAME_CMDS = new Set([
    '!slot', '!coinflip', '!tong', '!sum', '!mat', '!face',
    '!gacha', '!wordchain', '!vuatiengviet'
]);

async function handleMessageCommand(msg) {
    const parts = msg.content.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const guildId = msg.guildId;

    if (BLOCKED_GAME_CMDS.has(cmd)) {
        const blockedArr = data.blockedGameChannels && data.blockedGameChannels[guildId];
        if (blockedArr && new Set(blockedArr).has(msg.channel.id)) {
            return msg.reply('❌ Kênh này không cho phép chơi game. Vui lòng vào kênh game để chơi.');
        }
    }

    const member = await msg.guild.members.fetch(msg.author.id);

    if (cmd === '!maintenance') {
        if (!isSuperAdmin(msg.author.id)) return;
        const arg = (parts[1] || '').toLowerCase();
        if (arg === 'on') {
            setMaintenance(true);
            return msg.reply('🔧 Đã BẬT chế độ bảo trì. Bot sẽ từ chối yêu cầu mới cho đến khi tắt hoặc restart.');
        }
        if (arg === 'off') {
            setMaintenance(false);
            return msg.reply('✅ Đã TẮT chế độ bảo trì. Bot hoạt động bình thường.');
        }
        const status = isMaintenance() ? 'BẬT 🔧' : 'TẮT ✅';
        return msg.reply(`Trạng thái bảo trì: **${status}**.\nCú pháp: \`!maintenance on|off\`.`);
    }

    if (isBlockedByMaintenance(msg.author.id, msg.guild)) {
        if (!cmd.startsWith('!')) return;
        return replyEphemeral(msg, '🔧 Bot đang bảo trì, vui lòng thử lại sau ít phút.');
    }

    if (cmd === '!profile') {
        try {
            await profileCmd.sendProfileCard(msg, msg.author);
        } catch (e) {
            log.error('!profile error:', e);
            await msg.reply('Render profile lỗi.').catch(() => {});
        }
        return;
    }

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
        const userHelp = `**Bot v${CURRENT_VERSION}** — Dùng \`!changelog\` để xem các tính năng mới.

**Tiền tệ & Gacha:**
• \`!khodo\` — Xem kho đồ (ngân phiếu, ngọc, vật phẩm).
• \`!daily\` — Nhận thưởng hàng ngày (1 lần/ngày).
• \`!doingoc <n|all>\` — Đổi ngân phiếu → ngọc.
• \`!doithienthuong <n>\` — Đổi ${economy.TT_PER_CAO} thiên thưởng → 1 cáo.
• \`!gacha [1-100|all]\` — Quay gacha, ${fmt(economy.GACHA.ROLL_COST)} ngọc/lần. Pity lượt 20 (KT+) / 200 (TT).
• \`!pity\` — Xem lượt còn lại đến pity.
• \`!toptt\` / \`!topngoc\` — Bảng xếp hạng.
• \`!tangngoc @user <n|all>\` / \`!tangthienthuong @user [n|all]\` — Tặng ngọc/thiên thưởng (+ Điểm Thân mật).
• \`!tangcao\` / \`!tangcao5\` / \`!tangcao9\` / \`!tangdieu @user [n|all]\` — Tặng vật phẩm (+ Điểm Thân mật).
• \`!tangphuongbang\` / \`!tangphuonghoa\` / \`!tangthantrang @user [n|all]\` — Tặng trang phục (+ Điểm Thân mật).
• \`!banthienthuong <n|all>\` / \`!bancao <n|all>\` — Bán đổi ngọc.
• \`!bankythuong\` / \`!bandieu\` / \`!bannhuom <n|all>\` — Bán low-tier (giá ${fmt(economy.SELL_PRICE_NGOC.kythuong)}/${fmt(economy.SELL_PRICE_NGOC.dieu)}/${fmt(economy.SELL_PRICE_NGOC.nhuom)} ngọc).
• \`!doicao5 <n|all>\` / \`!doicao9 <n|all>\` — Đổi ${economy.CAO_PER_CAO5} cáo → 1 cáo 5 đuôi; ${economy.CAO5_PER_CAO9} cáo 5 đuôi → 1 cáo 9 đuôi.
• \`!doiphuongbang <n|all>\` — ${economy.PHUONGBANG_TT} thiên thưởng → 1 Phượng Băng.
• \`!doiphuonghoa <n|all>\` — 1 Phượng Băng + ${economy.PHUONGHOA_TT} thiên thưởng → 1 Phượng Hoả.
• \`!doithantrang <n|all>\` — ${economy.THANTRANG_TT} thiên thưởng → 1 Thần Trang.
  (Phượng & Thần Trang: chỉ đổi 1 chiều, không bán, có thể tặng.)
• \`!bond [@user]\` — Xem Điểm Thân mật (top 10 hoặc cụ thể với 1 user).

**Mini Games:**
• \`!coinflip [sap|ngua] <x|all>\` — Cược ngọc 50/50, tối đa ${fmt(economy.COINFLIP_MAX_BET)}/lượt.
• \`!slot <x|all> [n]\` — Slot 3 reels, tối đa ${fmt(economy.SLOT_MAX_BET)}/lượt. Jackpot x200. Có thể quay nhiều lượt cùng lúc (\`n\` tối đa 5, vd: \`!slot 500 5\` = 2500 ngọc).
• \`!tong <x|all|allin> <3-18>\` — Đoán tổng 3 xúc xắc, tối đa ${fmt(economy.TONG_MAX_BET)}/lượt. Trúng x8–x200.
• \`!mat <x|all|allin> <1-6>\` — Đoán mặt xuất hiện trong 3 xúc xắc, tối đa ${fmt(economy.MAT_MAX_BET)}/lượt. Trúng x2/x4/x6.
• \`!xoso\` — Xổ số tích lũy: chọn 4 số 1-${lottery.LOTTERY.NUMBER_POOL_MAX}, vé ${fmt(lottery.LOTTERY.TICKET_PRICE)} ngọc (max ${lottery.LOTTERY.MAX_TICKETS_PER_DRAW}/đợt). Quay 10h sáng & 10h tối. \`!xoso pool\` / \`!xoso bao [n]\` / \`!xoso ve\`.
• \`!wordchain\` — Tạo thread chơi nối từ tiếng Anh **co-op** (nhiều người cùng nối). Thưởng Ngọc theo các từ mỗi người đóng góp.
• \`!wordchain_top [week]\` — Bảng xếp hạng English Wordchain (lifetime / tuần).
• \`!boquathuong\` — Bỏ qua / nhận lại thưởng tuần English Wordchain (toggle, thưởng chuyển xuống người xếp dưới).

**Khác:**
• Chat: +${fmt(economy.CHAT_REWARD)} ngân phiếu/tin (cap ${fmt(economy.CHAT_DAILY_CAP)}/ngày).
• Báo danh bang chiến: +${fmt(economy.BANG_CHIEN_REWARD)} ngọc/lần.`;
        await replyChunked(msg, userHelp);
        return;
    }

    if (cmd === '!devhelp') {
        if (!isSuperAdmin(msg.author.id)) return;
        const devHelp = `**Dev / Admin Commands — Bot v${CURRENT_VERSION}**

**Quản lý bot:**
• \`!maintenance on|off\` — Bật/tắt bảo trì (chặn input mới trước restart).
• \`!upload_ingame_emotes\` — Upload emote ingame (slot, dice...).
• \`!uploademotes\` — Upload emote class.
• \`!gangoc <n> [#kênh]\` — GA ngọc, user react để nhận.

**Metrics & Debug:**
• \`!metrics [slot|coinflip|tong|mat|gacha|wordchain|daily|gangoc] [YYYY-MM-DD] [all|<guildId>]\` — Mặc định guild hiện tại; \`all\` để gộp; truyền guildId cụ thể để xem 1 guild khác.
• \`!metrics list\` — Liệt kê các file metrics đã lưu. \`!metrics guilds\` — Liệt kê guilds có data.
• \`!metrics_exclude [list|add|remove|clean] @user\` — Loại user khỏi metrics (skip toàn bộ record + dọn playerIds cũ).
• \`!metrics_adjust <guildId|_legacy> <YYYY-MM-DD|today> <game> <field=delta> [...]\` — Cộng/trừ trực tiếp vào bucket (vd: \`rolls=-30 burned=-3000 itemCounts.cao=-1\`).
• \`!wordchain_payout\` — Trả thưởng tuần trước cho top 10 English Wordchain ngay (cron tự chạy Thứ Hai 00:00 GMT+7).
• \`!wordchain_reset\` — Reset daily limit ngọc wordchain (20 lần/vị trí) cho toàn server (ManageGuild).
• \`!setwordchain_noti [#channel|clear]\` — Cài kênh riêng nhận thông báo thưởng tuần wordchain (ManageGuild). Mặc định dùng kênh bot.
• \`!setxoso_noti [#channel|clear]\` — Cài kênh thông báo xổ số tích lũy. Bắt buộc set để bot announce.
• \`!xoso_drawnow\` — Chạy quay xổ số thủ công (test / chữa cháy nếu cron lỡ).

**Guild War:**
• \`!setup channel #channel\` — Set kênh đăng ký bang chiến.
• \`!setmanager @user\` — Set manager nhận danh sách.
• \`!postnow\` — Đăng tin bang chiến ngay.
• \`!remindnow\` — Gửi nhắc nhở ngay.
• \`!testreminders <day> <hour> <minute>\` — Lên lịch nhắc nhở test.
• \`!sendlist\` — Gửi danh sách cho manager.
• \`!voteclass\` — Đăng bình chọn class.`;
        await replyChunked(msg, devHelp);
        return;
    }

    if (cmd === '!metrics') {
        if (!isSuperAdmin(msg.author.id)) return;
        // !metrics [slot|coinflip|tong|mat|...] [YYYY-MM-DD] [all]
        // Defaults to current guild's metrics; pass 'all' to aggregate across guilds.
        // !metrics list / !metrics guilds
        const GAMES = new Set(['slot', 'coinflip', 'tong', 'mat', 'gacha', 'wordchain', 'wordchain_eng', 'daily', 'gangoc']);
        const argTokens = parts.slice(1).map(p => p.toLowerCase());

        if (argTokens[0] === 'list') {
            const buckets = metrics.listBuckets();
            if (!buckets.length) return msg.reply('Chưa có file metrics nào.');
            return msg.reply(`📂 **Metrics files** (${buckets.length}):\n${buckets.join('\n')}`);
        }
        if (argTokens[0] === 'guilds') {
            const gs = metrics.listAllGuilds();
            if (!gs.length) return msg.reply('Chưa có guild nào có metrics.');
            const lines = gs.map(g => {
                const guild = client.guilds.cache.get(g);
                const name = guild ? guild.name : (g === metrics.LEGACY_GUILD_KEY ? '(legacy/pre-split)' : '(unknown)');
                return `\`${g}\` — ${name}`;
            });
            return msg.reply(`🏰 **Guilds in metrics**:\n${lines.join('\n')}`);
        }

        let game = null, dateArg = null;
        let guildFilter = guildId; // default: current guild only
        for (const tok of argTokens) {
            if (tok === 'all') guildFilter = 'all';
            else if (GAMES.has(tok)) game = tok;
            else if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) dateArg = tok;
            else if (/^\d{15,20}$/.test(tok)) guildFilter = tok;
        }

        if (game) {
            return msg.reply(`\`\`\`\n${metrics.formatGame(game, guildFilter)}\n\`\`\``);
        }
        const sections = metrics.formatAllSections(dateArg || undefined, guildFilter);
        const chunks = metrics.packSections(sections, 1900);
        if (chunks.length === 0) return msg.reply('Chưa có dữ liệu metrics.');
        await msg.reply(`\`\`\`\n${chunks[0]}\n\`\`\``);
        for (let i = 1; i < chunks.length; i++) {
            await msg.channel.send(`\`\`\`\n${chunks[i]}\n\`\`\``);
        }
        return;
    }

    if (cmd === '!metrics_exclude' || cmd === '!metrics_ex') {
        if (!isSuperAdmin(msg.author.id)) return;
        const sub = (parts[1] || '').toLowerCase();
        const arg = parts[2];
        const extractId = () => {
            if (!arg) return null;
            if (/^\d{15,20}$/.test(arg)) return arg;
            const m = arg.match(/^<@!?(\d{15,20})>$/);
            return m ? m[1] : null;
        };

        if (!sub || sub === 'list') {
            const ids = metrics.listExcluded();
            if (ids.length === 0) return msg.reply('Exclude list trống. Cú pháp: `!metrics_exclude add|remove|clean @user|<userId>`.');
            const lines = await Promise.all(ids.map(async id => {
                const m = await msg.guild.members.fetch(id).catch(() => null);
                return `\`${id}\` — ${m ? m.displayName : '(unknown)'}`;
            }));
            return msg.reply(`🚫 **Metrics exclude list** (${ids.length}):\n${lines.join('\n')}`);
        }
        const uid = extractId();
        if (!uid) return msg.reply('Cần mention @user hoặc user ID. Cú pháp: `!metrics_exclude add|remove|clean @user|<userId>`.');
        if (sub === 'add') {
            const added = metrics.addExcluded(uid);
            const cleaned = metrics.purgeUserFromPlayerIds(uid);
            return msg.reply(`${added ? '✅ Đã thêm' : 'ℹ️ Đã có trong list'} \`${uid}\`. Dọn khỏi ${cleaned} bucket(s) đã có.`);
        }
        if (sub === 'remove') {
            const removed = metrics.removeExcluded(uid);
            return msg.reply(removed ? `✅ Đã bỏ \`${uid}\` khỏi exclude list (data cũ vẫn rỗng nếu đã clean).` : `\`${uid}\` không có trong list.`);
        }
        if (sub === 'clean') {
            const cleaned = metrics.purgeUserFromPlayerIds(uid);
            return msg.reply(`🧹 Đã xoá \`${uid}\` khỏi playerIds trên ${cleaned} bucket(s).`);
        }
        return msg.reply('Cú pháp: `!metrics_exclude [list]` | `add @user` | `remove @user` | `clean @user`.');
    }

    if (cmd === '!metrics_adjust') {
        if (!isSuperAdmin(msg.author.id)) return;
        // !metrics_adjust <guildId|_legacy> <YYYY-MM-DD|today> <game> <field=delta> [field=delta ...]
        const guildArg = parts[1];
        const dateArg = parts[2];
        const gameArg = (parts[3] || '').toLowerCase();
        const deltaTokens = parts.slice(4);
        if (!guildArg || !dateArg || !gameArg || deltaTokens.length === 0) {
            return msg.reply(
                'Cú pháp: `!metrics_adjust <guildId|_legacy> <YYYY-MM-DD|today> <game> <field=delta> [...]`\n' +
                'VD: `!metrics_adjust _legacy 2026-05-23 gacha rolls=-30 burned=-3000 hits=-1 itemCounts.cao=-1`'
            );
        }
        const bucket = dateArg.toLowerCase() === 'today' ? metrics.currentBucket() : dateArg;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(bucket)) return msg.reply('Date phải dạng `YYYY-MM-DD` hoặc `today`.');
        const deltas = {};
        for (const tok of deltaTokens) {
            const eq = tok.indexOf('=');
            if (eq < 0) return msg.reply(`Token không hợp lệ: \`${tok}\` — cần dạng \`field=delta\`.`);
            const key = tok.slice(0, eq);
            const val = Number(tok.slice(eq + 1));
            if (!Number.isFinite(val)) return msg.reply(`Delta không phải số: \`${tok}\`.`);
            deltas[key] = val;
        }
        try {
            const { applied, skipped } = metrics.adjustBucket(bucket, guildArg, gameArg, deltas);
            const appliedStr = Object.entries(applied).map(([k, v]) => `${k}${v >= 0 ? '+' : ''}${v}`).join(', ') || '(nothing)';
            const skippedStr = Object.entries(skipped).map(([k, r]) => `${k} (${r})`).join(', ');
            return msg.reply(
                `🛠️ Adjusted bucket \`${bucket}\` / guild \`${guildArg}\` / game \`${gameArg}\`\n` +
                `Applied: ${appliedStr}` + (skippedStr ? `\nSkipped: ${skippedStr}` : '')
            );
        } catch (e) {
            return msg.reply(`❌ Lỗi: ${e.message}`);
        }
    }

    if (cmd === '!changelog') {
        const arg = parts[1];
        let versions;
        if (!arg) {
            versions = [CURRENT_VERSION];
        } else if (arg === 'all') {
            versions = Object.keys(CHANGELOG).sort((a, b) => parseFloat(b) - parseFloat(a));
        } else if (CHANGELOG[arg]) {
            versions = [arg];
        } else {
            return msg.reply(`Không tìm thấy version \`${arg}\`. Dùng \`!changelog\`, \`!changelog all\`, hoặc \`!changelog <version>\`.`);
        }
        const sections = versions.map(v => {
            const entry = CHANGELOG[v];
            const header = `**Version ${v}** — ${entry.date} — *${entry.title}*`;
            const body = entry.changes.map(c => `• ${c}`).join('\n');
            return `${header}\n${body}`;
        });
        return msg.reply(`📋 **Changelog** (current: v${CURRENT_VERSION})\n\n${sections.join('\n\n')}`);
    }

    if (cmd === '!khodo') {
        const w = getWallet(guildId, msg.author.id);
        const lines = [
            `**Kho đồ của ${member.displayName}**`,
            `${renderEmote('nganphieu')} Ngân phiếu: **${fmt(w.nganphieu)}**`,
            `${renderEmote('ngoc')} Ngọc: **${fmt(w.ngoc + w.lockedNgoc)}**`
        ];
        let hiddenCount = 0;
        for (const k of ITEM_KEYS) {
            const total = (w.items[k] || 0) + (w.lockedItems[k] || 0);
            if (total > 0) {
                lines.push(`${renderEmote(k)} ${ITEM_LABELS[k]}: **${fmt(total)}**`);
            } else {
                hiddenCount++;
            }
        }
        const components = [];
        if (hiddenCount > 0) {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`khodo:all:${msg.author.id}`)
                    .setLabel(`Xem hết (+${hiddenCount} trống)`)
                    .setStyle(ButtonStyle.Secondary)
            ));
        }
        return msg.reply({ content: lines.join('\n'), components });
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
        return msg.reply(`Đã đổi ${fmt(cost)} ${renderEmote('nganphieu')} → ${fmt(n)} ${renderEmote('ngoc')}. Số dư: ${fmt(w2.nganphieu)} ngân phiếu, ${fmt(w2.ngoc + w2.lockedNgoc)} ngọc.`);
    }

    if (cmd === '!gacha') {
        let n;
        if (parts[1] === 'all') {
            const w = getWallet(guildId, msg.author.id);
            const totalNgocGacha = w.ngoc + w.lockedNgoc;
            n = Math.floor(totalNgocGacha / ROLL_COST);
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
            if (!Number.isInteger(n) || n < 1 || n > 100) return msg.reply(`Chỉ hỗ trợ từ 1 đến 100 lần. Dùng \`!gacha all\` để quay hết ngọc.`);
        }
        const cost = n * ROLL_COST;
        const w = getWallet(guildId, msg.author.id);
        const totalNgocGacha = w.ngoc + w.lockedNgoc;
        if (totalNgocGacha < cost) return msg.reply(`Cần ${fmt(cost)} ngọc để quay ${fmt(n)} lần, bạn có ${fmt(totalNgocGacha)}.`);
        spendNgocForGame(guildId, msg.author.id, cost);

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
        const gachaMeta = {};
        const counts = rollMany(n, wallet.pity, gachaMeta);
        for (const k of ITEM_KEYS) {
            if (counts[k] > 0) addItem(guildId, msg.author.id, k, counts[k]);
        }
        saveData();
        metrics.recordGacha({ guildId, rolls: n, cost, counts, userId: msg.author.id, ...gachaMeta });
        const result = formatRollResult(counts);
        await shakeMsg.edit({ content: `**${member.displayName}** quay ${fmt(n)} lần (-${fmt(cost)} ${renderEmote('ngoc')}):\n${result}`, attachments: [] }).catch(e => log.error('gacha edit error', e));
        return;
    }

    if (cmd === '!daily') {
        const res = tryClaimDaily(guildId, msg.author.id);
        if (!res.claimed) return msg.reply('Bạn đã nhận daily hôm nay rồi. Quay lại sau 00:00.');
        const r = res.reward;
        metrics.recordDaily({ guildId, nganphieu: r.nganphieu, userId: msg.author.id });
        return msg.reply(`🎁 Daily của ${member.displayName}: +${fmt(r.nganphieu)} ${renderEmote('nganphieu')}.`);
    }

    if (cmd === '!doithienthuong') {
        const n = parseInt(parts[1], 10);
        if (!Number.isInteger(n) || n <= 0) return msg.reply(`Cú pháp: \`!doithienthuong <số lượng cáo>\` — đổi ${economy.TT_PER_CAO} thiên thưởng thành 1 cáo.`);
        const cost = n * economy.TT_PER_CAO;
        const w = getWallet(guildId, msg.author.id);
        const totalTT = w.items.thienthuong + w.lockedItems.thienthuong;
        if (totalTT < cost) return msg.reply(`Cần ${fmt(cost)} ${renderEmote('thienthuong')} nhưng chỉ có ${fmt(totalTT)}.`);
        const nonLockedTTUsed = Math.min(cost, w.items.thienthuong);
        const lockedTTUsed = cost - nonLockedTTUsed;
        w.items.thienthuong -= nonLockedTTUsed;
        w.lockedItems.thienthuong -= lockedTTUsed;
        const nonLockedCao = Math.floor(nonLockedTTUsed / economy.TT_PER_CAO);
        const lockedCao = n - nonLockedCao;
        w.items.cao += nonLockedCao;
        w.lockedItems.cao += lockedCao;
        saveData();
        const w2 = getWallet(guildId, msg.author.id);
        return msg.reply(`Đã đổi ${fmt(cost)} ${renderEmote('thienthuong')} → ${fmt(n)} ${renderEmote('cao')}. Số dư: ${fmt(w2.items.thienthuong)} thiên thưởng, ${fmt(w2.items.cao)} cáo.`);
    }

    if (cmd === '!tangthienthuong' || cmd === '!tangcao' || cmd === '!tangcao5' || cmd === '!tangcao9' || cmd === '!tangdieu'
        || cmd === '!tangphuongbang' || cmd === '!tangphuonghoa' || cmd === '!tangthantrang') {
        const giftMap = {
            '!tangthienthuong': { key: 'thienthuong', bondPer: economy.BOND.PER_THIENTHUONG },
            '!tangcao': { key: 'cao', bondPer: economy.BOND.PER_CAO },
            '!tangcao5': { key: 'cao5', bondPer: economy.BOND.PER_CAO5 },
            '!tangcao9': { key: 'cao9', bondPer: economy.BOND.PER_CAO9 },
            '!tangdieu': { key: 'dieu', bondPer: economy.BOND.PER_DIEU },
            '!tangphuongbang': { key: 'phuonghoang1', bondPer: economy.BOND.PER_PHUONGHOANG1 },
            '!tangphuonghoa': { key: 'phuonghoang2', bondPer: economy.BOND.PER_PHUONGHOANG2 },
            '!tangthantrang': { key: 'thantrang', bondPer: economy.BOND.PER_THANTRANG }
        };
        const { key: itemKey, bondPer } = giftMap[cmd];
        const itemLabel = ITEM_LABELS[itemKey];
        const mention = parts[1];
        if (!mention) return msg.reply(`Cú pháp: \`${cmd} @user [số lượng|all]\` (mặc định 1)`);
        const targetId = mention.replace(/[^0-9]/g, '');
        if (!targetId) return msg.reply('Vui lòng mention user hợp lệ.');
        if (targetId === msg.author.id) return msg.reply('Không thể tự tặng chính mình.');
        const targetMember = await msg.guild.members.fetch(targetId).catch(() => null);
        if (!targetMember) return msg.reply('Không tìm thấy user trong server.');
        if (targetMember.user.bot) return msg.reply('Không tặng cho bot được.');
        const w = getWallet(guildId, msg.author.id);
        const lockedItemAmt = w.lockedItems[itemKey];
        const totalItem = w.items[itemKey] + lockedItemAmt;
        let amount;
        if (parts[2] === 'all') {
            amount = totalItem;
            if (amount <= 0) return msg.reply(`Bạn không có ${itemLabel} để tặng.`);
        } else {
            amount = parts[2] ? parseInt(parts[2], 10) : 1;
            if (!Number.isInteger(amount) || amount <= 0) return msg.reply(`Cú pháp: \`${cmd} @user [số lượng|all]\``);
            if (totalItem < amount) return msg.reply(`Bạn chỉ có ${fmt(totalItem)} ${itemLabel}, không đủ tặng ${fmt(amount)}.`);
        }
        const nonLockedUsed = Math.min(amount, w.items[itemKey]);
        const lockedUsed = amount - nonLockedUsed;
        w.items[itemKey] -= nonLockedUsed;
        w.lockedItems[itemKey] -= lockedUsed;
        saveData();
        addLockedItem(guildId, targetId, itemKey, amount);
        const bondDelta = Math.floor(nonLockedUsed * bondPer);
        const newBond = bond.addBond(guildId, msg.author.id, targetId, bondDelta);
        const emoji = bond.emojiFor(newBond);
        const lockedNote = lockedUsed > 0 ? ` (có ${fmt(lockedUsed)} ${itemLabel} khoá không tăng thân mật)` : '';
        return msg.reply(`${member.displayName} đã tặng **${fmt(amount)}** ${renderEmote(itemKey)} cho ${targetMember.displayName}. ${emoji} Điểm Thân mật +${fmt(bondDelta)} → **${fmt(newBond)}**.${lockedNote}`);
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
        const totalNgocGift = w.ngoc + w.lockedNgoc;
        let amount;
        if (parts[2] === 'all') {
            amount = totalNgocGift;
            if (amount <= 0) return msg.reply('Bạn không có ngọc để tặng.');
        } else {
            amount = parseInt(parts[2], 10);
            if (!Number.isInteger(amount) || amount <= 0) return msg.reply('Cú pháp: `!tangngoc @user <số lượng|all>`');
            if (totalNgocGift < amount) return msg.reply(`Bạn chỉ có ${fmt(totalNgocGift)} ngọc, không đủ tặng ${fmt(amount)}.`);
        }
        const nonLockedUsed = Math.min(amount, w.ngoc);
        const lockedUsed = amount - nonLockedUsed;
        w.ngoc -= nonLockedUsed;
        w.lockedNgoc -= lockedUsed;
        saveData();
        addLockedNgoc(guildId, targetId, amount);
        const bondDelta = Math.floor(nonLockedUsed * economy.BOND.PER_NGOC);
        const newBond = bond.addBond(guildId, msg.author.id, targetId, bondDelta);
        const bondLine = bondDelta > 0
            ? ` ${bond.emojiFor(newBond)} Điểm Thân mật +${fmt(bondDelta)} → **${fmt(newBond)}**.`
            : '';
        const lockedNote = lockedUsed > 0 ? ` (có ${fmt(lockedUsed)} ngọc khoá không tăng thân mật)` : '';
        return msg.reply(`${member.displayName} đã tặng **${fmt(amount)}** ${renderEmote('ngoc')} cho ${targetMember.displayName}.${bondLine}${lockedNote}`);
    }

    if (cmd === '!banthienthuong' || cmd === '!bancao') {
        const isCao = cmd === '!bancao';
        const itemKey = isCao ? 'cao' : 'thienthuong';
        const itemLabel = isCao ? 'cáo' : 'thiên thưởng';
        const pricePerUnit = isCao
            ? economy.ROLLS_PER_THIENTHUONG * ROLL_COST * economy.TT_PER_CAO
            : economy.ROLLS_PER_THIENTHUONG * ROLL_COST;
        const w = getWallet(guildId, msg.author.id);
        const totalSell = w.items[itemKey] + w.lockedItems[itemKey];
        let n;
        if (parts[1] === 'all') {
            n = totalSell;
            if (n <= 0) return msg.reply(`Bạn không có ${itemLabel} để bán.`);
        } else {
            n = parseInt(parts[1], 10);
            if (!Number.isInteger(n) || n <= 0) return msg.reply(`Cú pháp: \`${cmd} <số lượng|all>\` — bán 1 ${itemLabel} = ${fmt(pricePerUnit)} ngọc.`);
            if (totalSell < n) return msg.reply(`Bạn chỉ có ${fmt(totalSell)} ${itemLabel}, không đủ bán ${fmt(n)}.`);
        }
        const nonLockedSold = Math.min(n, w.items[itemKey]);
        const lockedSold = n - nonLockedSold;
        w.items[itemKey] -= nonLockedSold;
        w.lockedItems[itemKey] -= lockedSold;
        const gained = n * pricePerUnit;
        addNgoc(guildId, msg.author.id, gained);
        saveData();
        const w2 = getWallet(guildId, msg.author.id);
        return msg.reply(`Đã bán ${fmt(n)} ${renderEmote(itemKey)} → ${fmt(gained)} ${renderEmote('ngoc')}. Số dư: ${fmt(w2.items[itemKey] + w2.lockedItems[itemKey])} ${itemLabel}, ${fmt(w2.ngoc + w2.lockedNgoc)} ngọc.`);
    }

    if (cmd === '!bankythuong' || cmd === '!bandieu' || cmd === '!bannhuom') {
        const itemKey = cmd === '!bankythuong' ? 'kythuong' : (cmd === '!bandieu' ? 'dieu' : 'nhuom');
        const itemLabel = ITEM_LABELS[itemKey];
        const pricePerUnit = economy.SELL_PRICE_NGOC[itemKey];
        const w = getWallet(guildId, msg.author.id);
        const totalSell = w.items[itemKey] + w.lockedItems[itemKey];
        let n;
        if (parts[1] === 'all') {
            n = totalSell;
            if (n <= 0) return msg.reply(`Bạn không có ${itemLabel} để bán.`);
        } else {
            n = parseInt(parts[1], 10);
            if (!Number.isInteger(n) || n <= 0) return msg.reply(`Cú pháp: \`${cmd} <số lượng|all>\` — bán 1 ${itemLabel} = ${fmt(pricePerUnit)} ngọc.`);
            if (totalSell < n) return msg.reply(`Bạn chỉ có ${fmt(totalSell)} ${itemLabel}, không đủ bán ${fmt(n)}.`);
        }
        const nonLockedSold = Math.min(n, w.items[itemKey]);
        const lockedSold = n - nonLockedSold;
        w.items[itemKey] -= nonLockedSold;
        w.lockedItems[itemKey] -= lockedSold;
        const gained = n * pricePerUnit;
        addNgoc(guildId, msg.author.id, gained);
        saveData();
        const w2 = getWallet(guildId, msg.author.id);
        return msg.reply(`Đã bán ${fmt(n)} ${renderEmote(itemKey)} → ${fmt(gained)} ${renderEmote('ngoc')}. Số dư: ${fmt(w2.items[itemKey] + w2.lockedItems[itemKey])} ${itemLabel}, ${fmt(w2.ngoc + w2.lockedNgoc)} ngọc.`);
    }

    if (cmd === '!doicao5' || cmd === '!doicao9') {
        const isCao9 = cmd === '!doicao9';
        const srcKey = isCao9 ? 'cao5' : 'cao';
        const dstKey = isCao9 ? 'cao9' : 'cao5';
        const ratio = isCao9 ? economy.CAO5_PER_CAO9 : economy.CAO_PER_CAO5;
        const w = getWallet(guildId, msg.author.id);
        const totalSrc = w.items[srcKey] + w.lockedItems[srcKey];
        const n = parts[1] === 'all'
            ? Math.floor(totalSrc / ratio)
            : parseInt(parts[1], 10);
        if (!Number.isInteger(n) || n <= 0) return msg.reply(`Cú pháp: \`${cmd} <số lượng|all>\` — đổi ${ratio} ${ITEM_LABELS[srcKey]} → 1 ${ITEM_LABELS[dstKey]}.`);
        const cost = n * ratio;
        if (totalSrc < cost) return msg.reply(`Cần ${fmt(cost)} ${renderEmote(srcKey)} nhưng chỉ có ${fmt(totalSrc)}.`);
        const nonLockedUsed = Math.min(cost, w.items[srcKey]);
        const lockedUsed = cost - nonLockedUsed;
        w.items[srcKey] -= nonLockedUsed;
        w.lockedItems[srcKey] -= lockedUsed;
        const nonLockedDst = Math.floor(nonLockedUsed / ratio);
        const lockedDst = n - nonLockedDst;
        w.items[dstKey] += nonLockedDst;
        w.lockedItems[dstKey] += lockedDst;
        saveData();
        const w2 = getWallet(guildId, msg.author.id);
        return msg.reply(`Đã đổi ${fmt(cost)} ${renderEmote(srcKey)} → ${fmt(n)} ${renderEmote(dstKey)}. Số dư: ${fmt(w2.items[srcKey])} ${ITEM_LABELS[srcKey]}, ${fmt(w2.items[dstKey])} ${ITEM_LABELS[dstKey]}.`);
    }

    if (cmd === '!doiphuongbang' || cmd === '!doithantrang') {
        const isThantrang = cmd === '!doithantrang';
        const dstKey = isThantrang ? 'thantrang' : 'phuonghoang1';
        const ttPer = isThantrang ? economy.THANTRANG_TT : economy.PHUONGBANG_TT;
        const w = getWallet(guildId, msg.author.id);
        const totalTT = w.items.thienthuong + w.lockedItems.thienthuong;
        const n = parts[1] === 'all'
            ? Math.floor(totalTT / ttPer)
            : parseInt(parts[1], 10);
        if (!Number.isInteger(n) || n <= 0) {
            return msg.reply(`Cú pháp: \`${cmd} <số lượng|all>\` — đổi ${fmt(ttPer)} ${renderEmote('thienthuong')} → 1 ${renderEmote(dstKey)} ${ITEM_LABELS[dstKey]}.`);
        }
        const cost = n * ttPer;
        if (totalTT < cost) return msg.reply(`Cần ${fmt(cost)} ${renderEmote('thienthuong')} nhưng chỉ có ${fmt(totalTT)}.`);
        const nonLockedTTUsed = Math.min(cost, w.items.thienthuong);
        const lockedTTUsed = cost - nonLockedTTUsed;
        w.items.thienthuong -= nonLockedTTUsed;
        w.lockedItems.thienthuong -= lockedTTUsed;
        const nonLockedDst = Math.floor(nonLockedTTUsed / ttPer);
        const lockedDst = n - nonLockedDst;
        w.items[dstKey] += nonLockedDst;
        w.lockedItems[dstKey] += lockedDst;
        saveData();
        const w2 = getWallet(guildId, msg.author.id);
        return msg.reply(`Đã đổi ${fmt(cost)} ${renderEmote('thienthuong')} → ${fmt(n)} ${renderEmote(dstKey)}. Số dư: ${fmt(w2.items.thienthuong)} thiên thưởng, ${fmt(w2.items[dstKey])} ${ITEM_LABELS[dstKey]}.`);
    }

    if (cmd === '!doiphuonghoa') {
        const ttPer = economy.PHUONGHOA_TT;
        const w = getWallet(guildId, msg.author.id);
        const totalP1 = w.items.phuonghoang1 + w.lockedItems.phuonghoang1;
        const totalTT = w.items.thienthuong + w.lockedItems.thienthuong;
        const maxByTt = Math.floor(totalTT / ttPer);
        const n = parts[1] === 'all'
            ? Math.min(totalP1, maxByTt)
            : parseInt(parts[1], 10);
        if (!Number.isInteger(n) || n <= 0) {
            return msg.reply(`Cú pháp: \`!doiphuonghoa <số lượng|all>\` — đổi 1 ${renderEmote('phuonghoang1')} + ${fmt(ttPer)} ${renderEmote('thienthuong')} → 1 ${renderEmote('phuonghoang2')} Phượng Hoả.`);
        }
        const ttCost = n * ttPer;
        if (totalP1 < n) return msg.reply(`Cần ${fmt(n)} ${renderEmote('phuonghoang1')} nhưng chỉ có ${fmt(totalP1)}.`);
        if (totalTT < ttCost) return msg.reply(`Cần ${fmt(ttCost)} ${renderEmote('thienthuong')} nhưng chỉ có ${fmt(totalTT)}.`);
        const nonLockedP1Used = Math.min(n, w.items.phuonghoang1);
        const lockedP1Used = n - nonLockedP1Used;
        const nonLockedTTUsed = Math.min(ttCost, w.items.thienthuong);
        const lockedTTUsed = ttCost - nonLockedTTUsed;
        w.items.phuonghoang1 -= nonLockedP1Used;
        w.lockedItems.phuonghoang1 -= lockedP1Used;
        w.items.thienthuong -= nonLockedTTUsed;
        w.lockedItems.thienthuong -= lockedTTUsed;
        const nonLockedP2 = Math.min(nonLockedP1Used, Math.floor(nonLockedTTUsed / ttPer));
        const lockedP2 = n - nonLockedP2;
        w.items.phuonghoang2 += nonLockedP2;
        w.lockedItems.phuonghoang2 += lockedP2;
        saveData();
        const w2 = getWallet(guildId, msg.author.id);
        return msg.reply(`Đã đổi ${fmt(n)} ${renderEmote('phuonghoang1')} + ${fmt(ttCost)} ${renderEmote('thienthuong')} → ${fmt(n)} ${renderEmote('phuonghoang2')}. Số dư: ${fmt(w2.items.phuonghoang1)} Phượng Băng, ${fmt(w2.items.phuonghoang2)} Phượng Hoả, ${fmt(w2.items.thienthuong)} thiên thưởng.`);
    }

    if (cmd === '!bond' || cmd === '!thanmat') {
        const mention = parts[1];
        if (mention) {
            const targetId = mention.replace(/[^0-9]/g, '');
            if (!targetId) return msg.reply('Vui lòng mention user hợp lệ.');
            if (targetId === msg.author.id) return msg.reply('Không thể xem Điểm Thân mật với chính mình.');
            const targetMember = await msg.guild.members.fetch(targetId).catch(() => null);
            if (!targetMember) return msg.reply('Không tìm thấy user trong server.');
            const score = bond.getBond(guildId, msg.author.id, targetId);
            const emoji = bond.emojiFor(score);
            return msg.reply(`${emoji} **Điểm Thân mật** giữa ${member.displayName} và ${targetMember.displayName}: **${fmt(score)}**`);
        }
        const rows = bond.listBondsFor(guildId, msg.author.id, 10);
        if (rows.length === 0) return msg.reply('Bạn chưa có liên kết Điểm Thân mật nào. Tặng diều/ngọc/thiên thưởng/cáo để tăng.');
        const lines = [`**Điểm Thân mật của ${member.displayName}**`];
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            let name = r.otherId;
            try {
                const m = await msg.guild.members.fetch(r.otherId).catch(() => null);
                if (m) name = m.displayName;
            } catch (e) { /* ignore */ }
            lines.push(`${i + 1}. ${bond.emojiFor(r.score)} **${name}** — ${fmt(r.score)}`);
        }
        return msg.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
    }

    if (cmd === '!boquathuong') {
        const nowOptedOut = wordchainEng.toggleOptOut(guildId, msg.author.id);
        if (nowOptedOut) {
            return msg.reply(`✅ Bạn đã **bỏ qua** thưởng tuần English Wordchain. Thưởng sẽ chuyển xuống người xếp dưới. Gõ \`!boquathuong\` lần nữa để bật lại.`);
        }
        return msg.reply(`✅ Bạn đã **bật lại** nhận thưởng tuần English Wordchain.`);
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
        metrics.recordGangocCreated({ guildId, amount });
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
        // Each item's TT-equivalent value (1 unit = N thiên thưởng).
        // All items exchanged from TT contribute to the score, even forward-only sinks.
        const TT_PER_CAO = economy.TT_PER_CAO;
        const TT_PER_CAO5 = TT_PER_CAO * economy.CAO_PER_CAO5;
        const TT_PER_CAO9 = TT_PER_CAO5 * economy.CAO5_PER_CAO9;
        const TT_PER_PHUONGBANG = economy.PHUONGBANG_TT;
        const TT_PER_PHUONGHOA = economy.PHUONGBANG_TT + economy.PHUONGHOA_TT;
        const TT_PER_THANTRANG = economy.THANTRANG_TT;
        const SCORED_ITEMS = [
            { key: 'thienthuong', mult: 1 },
            { key: 'cao', mult: TT_PER_CAO },
            { key: 'cao5', mult: TT_PER_CAO5 },
            { key: 'cao9', mult: TT_PER_CAO9 },
            { key: 'phuonghoang1', mult: TT_PER_PHUONGBANG },
            { key: 'phuonghoang2', mult: TT_PER_PHUONGHOA },
            { key: 'thantrang', mult: TT_PER_THANTRANG }
        ];
        const rankings = [];
        for (const [userId, w] of Object.entries(wallets)) {
            if (!w.items) continue;
            let score = 0;
            const owned = {};
            for (const { key, mult } of SCORED_ITEMS) {
                const n = (w.items[key] || 0) + ((w.lockedItems && w.lockedItems[key]) || 0);
                owned[key] = n;
                score += n * mult;
            }
            if (score > 0) rankings.push({ userId, score, owned });
        }
        rankings.sort((a, b) => b.score - a.score);
        const top = rankings.slice(0, 10);
        if (top.length === 0) return msg.reply('Chưa có ai có thiên thưởng.');
        const lines = ['**Top 10 Thiên Thưởng**'];
        for (let i = 0; i < top.length; i++) {
            const { userId, score, owned } = top[i];
            let name = userId;
            try {
                const member = await msg.guild.members.fetch(userId).catch(() => null);
                if (member) name = member.displayName;
            } catch (e) {}
            const partsLine = [];
            for (const { key } of SCORED_ITEMS) {
                if (owned[key] > 0) partsLine.push(`${fmt(owned[key])} ${renderEmote(key)}`);
            }
            lines.push(`${i + 1}. **${name}**: ${partsLine.join(' + ')} = **${fmt(score)}** điểm`);
        }
        return msg.reply(lines.join('\n'));
    }

    if (cmd === '!topngoc') {
        const wallets = data.wallet && data.wallet[guildId];
        if (!wallets) return msg.reply('Chưa có người nào đăng ký.');
        const rankings = [];
        for (const [userId, w] of Object.entries(wallets)) {
            const totalN = (w.ngoc || 0) + (w.lockedNgoc || 0);
            if (totalN > 0) rankings.push({ userId, ngoc: totalN });
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
        let amountStr;
        if (parts[1] === 'sap' || parts[1] === 'ngua') {
            side = parts[1];
            amountStr = parts[2];
        } else {
            amountStr = parts[1];
        }
        const isAll = amountStr === 'all';
        let rawAmount = null;
        if (!isAll) {
            rawAmount = parseInt(amountStr, 10);
            if (!Number.isInteger(rawAmount) || rawAmount <= 0) {
                return msg.reply(`Cú pháp: \`!coinflip <số ngọc|all>\` hoặc \`!coinflip <sap|ngua> <số ngọc|all>\` (tối đa ${fmt(economy.COINFLIP_MAX_BET)} ngọc).`);
            }
        }
        const cd = checkGameCooldown(msg.author.id);
        if (cd.onCooldown) {
            const secLeft = Math.ceil(cd.msLeft / 1000);
            return replyEphemeral(msg, `⏳ Vui lòng chờ ${secLeft}s trước khi chơi tiếp.`);
        }
        const w = getWallet(guildId, msg.author.id);
        const totalNgocCf = w.ngoc + w.lockedNgoc;
        let amount;
        if (isAll) {
            amount = Math.min(totalNgocCf, economy.COINFLIP_MAX_BET);
            if (amount <= 0) return msg.reply('Bạn không có ngọc để chơi.');
        } else {
            amount = Math.min(rawAmount, economy.COINFLIP_MAX_BET);
            if (totalNgocCf < amount) return msg.reply(`Bạn cần ${fmt(amount)} ngọc nhưng chỉ có ${fmt(totalNgocCf)}.`);
        }
        const result = Math.random() < 0.5 ? 'sap' : 'ngua';
        const won = side ? (side === result) : (Math.random() < 0.5);
        spendNgocForGame(guildId, msg.author.id, amount);
        if (won) {
            addNgoc(guildId, msg.author.id, amount * 2);
            profile.recordWin(guildId, msg.author.id, amount * 2, 'Coinflip');
        }
        const newW = getWallet(guildId, msg.author.id);
        const bigWin = won && (isAll || amount >= 5000);
        metrics.recordCoinflip({ guildId, amount, won, side, viaButton: false, wasAllIn: isAll, bigWin, userId: msg.author.id });
        const content = formatCoinflipResult({ displayName: member.displayName, side, result, won, amount, wasAllIn: isAll });
        const totalNgocAfterCf = newW.ngoc + newW.lockedNgoc;
        const components = totalNgocAfterCf > 0 ? [buildCoinflipButtons(msg.author.id, amount, side, totalNgocAfterCf)] : [];
        return msg.reply({ content, components });
    }

    if (cmd === '!slot') {
        const isAll = parts[1] === 'all';
        let rawAmount = null;
        if (!isAll) {
            rawAmount = parseInt(parts[1], 10);
            if (!Number.isInteger(rawAmount) || rawAmount <= 0) {
                return msg.reply(`Cú pháp: \`!slot <số ngọc|all> [số lượt]\` (tối đa ${fmt(economy.SLOT_MAX_BET)} ngọc/lượt, tối đa ${SLOT_MAX_ROLLS} lượt).`);
            }
        }
        let rolls = 1;
        if (parts[2] !== undefined) {
            rolls = parseInt(parts[2], 10);
            if (!Number.isInteger(rolls) || rolls < 1 || rolls > SLOT_MAX_ROLLS) {
                return msg.reply(`Số lượt phải là số nguyên từ 1 đến ${SLOT_MAX_ROLLS}.`);
            }
        }
        const cd = checkGameCooldown(msg.author.id);
        if (cd.onCooldown) {
            const secLeft = Math.ceil(cd.msLeft / 1000);
            return replyEphemeral(msg, `⏳ Vui lòng chờ ${secLeft}s trước khi chơi tiếp.`);
        }

        const result = await runSlotMultiRoll({
            guildId, userId: msg.author.id, displayName: member.displayName,
            requestedAmount: rawAmount, isAll, rolls,
            sendInitial: (content) => msg.reply(content),
            log, metrics
        });
        if (result.error === 'no_ngoc') return msg.reply('Bạn không có ngọc để chơi slot.');
        if (result.error === 'insufficient') {
            return msg.reply(`Bạn cần ${fmt(result.needed || rawAmount)} ngọc nhưng chỉ có ${fmt(result.available)}.`);
        }
        return;
    }

    if (cmd === '!tong' || cmd === '!sum' || cmd === '!mat' || cmd === '!face') {
        const isTong = (cmd === '!tong' || cmd === '!sum');
        const game = isTong ? 'tong' : 'mat';
        const maxBet = isTong ? economy.TONG_MAX_BET : economy.MAT_MAX_BET;
        const guessMin = isTong ? 3 : 1;
        const guessMax = isTong ? 18 : 6;
        const cmdLabel = isTong ? '!tong' : '!mat';
        const guessLabel = isTong ? 'tổng (3-18)' : 'mặt (1-6)';
        const syntax = `Cú pháp: \`${cmdLabel} <số ngọc|all> <${guessLabel}>\` hoặc \`${cmdLabel} allin <${guessLabel}>\` (tối đa ${fmt(maxBet)} ngọc/lượt).`;

        if (parts.length < 3) return msg.reply(syntax);
        const token1 = parts[1].toLowerCase();
        const isAll = token1 === 'all' || token1 === 'allin';
        let rawAmount = null;
        if (!isAll) {
            rawAmount = parseInt(token1, 10);
            if (!Number.isInteger(rawAmount) || rawAmount <= 0) return msg.reply(syntax);
        }
        const guess = parseInt(parts[2], 10);
        if (!Number.isInteger(guess) || guess < guessMin || guess > guessMax) {
            return msg.reply(`${isTong ? 'Tổng' : 'Mặt'} phải là số nguyên từ ${guessMin} đến ${guessMax}.`);
        }

        const cd = checkGameCooldown(msg.author.id);
        if (cd.onCooldown) {
            const secLeft = Math.ceil(cd.msLeft / 1000);
            return replyEphemeral(msg, `⏳ Vui lòng chờ ${secLeft}s trước khi chơi tiếp.`);
        }

        const w = getWallet(guildId, msg.author.id);
        const totalNgocDice = w.ngoc + w.lockedNgoc;
        let amount;
        if (isAll) {
            amount = Math.min(totalNgocDice, maxBet);
            if (amount <= 0) return msg.reply('Bạn không có ngọc để chơi.');
        } else {
            amount = Math.min(rawAmount, maxBet);
            if (totalNgocDice < amount) return msg.reply(`Bạn cần ${fmt(amount)} ngọc nhưng chỉ có ${fmt(totalNgocDice)}.`);
        }

        const roll = dice.rollDice();
        const play = isTong ? dice.playTong(roll, guess) : dice.playMat(roll, guess);
        spendNgocForGame(guildId, msg.author.id, amount);
        if (play.won) {
            const payout = amount * play.mult;
            addNgoc(guildId, msg.author.id, payout);
            profile.recordWin(guildId, msg.author.id, payout, isTong ? 'Tổng xúc xắc' : 'Mặt xúc xắc');
        }
        const newW = getWallet(guildId, msg.author.id);

        if (isTong) {
            metrics.recordTong({ guildId, amount, won: play.won, mult: play.mult, guess, viaButton: false, wasAllIn: isAll, userId: msg.author.id });
        } else {
            metrics.recordMat({ guildId, amount, won: play.won, mult: play.mult, face: guess, matches: play.matches, viaButton: false, wasAllIn: isAll, userId: msg.author.id });
        }

        const content = isTong
            ? dice.formatTongResult({ displayName: member.displayName, guess, roll, sum: play.sum, won: play.won, amount, mult: play.mult })
            : dice.formatMatResult({ displayName: member.displayName, face: guess, roll, matches: play.matches, won: play.won, amount, mult: play.mult });
        const buildBtns = isTong ? dice.buildTongButtons : dice.buildMatButtons;
        const totalNgocAfterDice = newW.ngoc + newW.lockedNgoc;
        const components = totalNgocAfterDice > 0 ? buildBtns(msg.author.id, amount, guess, totalNgocAfterDice) : [];
        return msg.reply({ content, components });
    }

    if (cmd === '!xoso') {
        const sub = (parts[1] || '').toLowerCase();
        const ngocEmote = renderEmote('ngoc');

        if (sub === 'pool' || sub === '') {
            const pool = lottery.getPool(guildId);
            const ticketCount = lottery.getTicketCount(guildId);
            const myCount = lottery.userTicketsThisDraw(guildId, msg.author.id).length;
            const nextTs = lottery.nextDrawUnix();
            const lines = [
                `# 🎰 Xổ Số Tích Lũy`,
                `## 💰 Pool jackpot: **${fmt(pool)}** ${ngocEmote}`,
                `-# Vé bán đợt này: **${fmt(ticketCount)}** · Vé của bạn: **${myCount}/${lottery.LOTTERY.MAX_TICKETS_PER_DRAW}**`,
                ``,
                `⏰ Đợt sau: <t:${nextTs}:F> (<t:${nextTs}:R>)`,
                `🎟️ Giá vé: **${fmt(lottery.LOTTERY.TICKET_PRICE)}** ${ngocEmote} · Chọn 4 số trong 1-${lottery.LOTTERY.NUMBER_POOL_MAX}`,
                `> \`!xoso <a b c d>\` — mua vé với 4 số đã chọn`,
                `> \`!xoso bao [n]\` — mua n vé random (mặc định 1, tối đa ${lottery.LOTTERY.MAX_TICKETS_PER_DRAW}/đợt)`,
                `> \`!xoso ve\` — xem vé của bạn`,
                ``,
                `🏆 4/4 = toàn bộ pool · 3/4 = ${fmt(lottery.LOTTERY.PRIZE_3_OF_4)} ${ngocEmote} · 2/4 = ${fmt(lottery.LOTTERY.PRIZE_2_OF_4)} ${ngocEmote}`,
                `-# Nhiều người trúng jackpot: chia đều pool.`
            ];
            return msg.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
        }

        if (sub === 've') {
            const tickets = lottery.userTicketsThisDraw(guildId, msg.author.id);
            const nextTs = lottery.nextDrawUnix();
            if (tickets.length === 0) {
                return msg.reply(`Bạn chưa mua vé đợt này. Đợt quay: <t:${nextTs}:R>. \`!xoso bao\` để mua vé random.`);
            }
            const lines = [`### 🎟️ Vé xổ số của ${member.displayName} (đợt này)`];
            for (let i = 0; i < tickets.length; i++) {
                lines.push(`${i + 1}. ${lottery.fmtNumbers(tickets[i].numbers)}`);
            }
            lines.push(`-# ${tickets.length}/${lottery.LOTTERY.MAX_TICKETS_PER_DRAW} vé · Quay <t:${nextTs}:R>`);
            return msg.reply(lines.join('\n'));
        }

        if (sub === 'bao') {
            const count = parts[2] ? parseInt(parts[2], 10) : 1;
            if (!Number.isInteger(count) || count <= 0) {
                return msg.reply(`Cú pháp: \`!xoso bao [số vé]\` (mặc định 1, tối đa ${lottery.LOTTERY.MAX_TICKETS_PER_DRAW}/đợt).`);
            }
            const res = lottery.buyRandomTickets(guildId, msg.author.id, count);
            if (!res.ok) {
                if (res.error === 'limit_reached') return msg.reply(`Bạn đã mua tối đa ${lottery.LOTTERY.MAX_TICKETS_PER_DRAW} vé đợt này.`);
                if (res.error === 'insufficient') return msg.reply(`Cần ${fmt(res.need)} ${ngocEmote} nhưng bạn chỉ có ${fmt(res.have)}.`);
                return msg.reply('Không thể mua vé.');
            }
            const nextTs = lottery.nextDrawUnix();
            const ticketLines = res.bought.map((t, i) => `${i + 1}. ${lottery.fmtNumbers(t.numbers)}`);
            const lines = [
                `🎟️ **${member.displayName}** mua **${res.bought.length}** vé bao (-${fmt(res.bought.length * lottery.LOTTERY.TICKET_PRICE)} ${ngocEmote})`,
                ...ticketLines,
                `-# Pool: **${fmt(res.newPool)}** ${ngocEmote} · Vé của bạn: **${res.newCount}/${lottery.LOTTERY.MAX_TICKETS_PER_DRAW}** · Quay <t:${nextTs}:R>`
            ];
            return msg.reply(lines.join('\n'));
        }

        // Manual numbers: !xoso 3 7 11 14
        const rawNums = parts.slice(1);
        if (rawNums.length !== lottery.LOTTERY.NUMBERS_PER_TICKET) {
            return msg.reply(`Cú pháp: \`!xoso <a b c d>\` — 4 số khác nhau trong 1-${lottery.LOTTERY.NUMBER_POOL_MAX}. Hoặc dùng \`!xoso bao\`, \`!xoso pool\`, \`!xoso ve\`.`);
        }
        const nums = lottery.parseNumbers(rawNums);
        if (!nums || !lottery.validateNumbers(nums)) {
            return msg.reply(`4 số phải khác nhau và nằm trong 1-${lottery.LOTTERY.NUMBER_POOL_MAX}.`);
        }
        const res = lottery.buyTicket(guildId, msg.author.id, nums);
        if (!res.ok) {
            if (res.error === 'invalid_numbers') return msg.reply(`4 số phải khác nhau và nằm trong 1-${lottery.LOTTERY.NUMBER_POOL_MAX}.`);
            if (res.error === 'limit_reached') return msg.reply(`Bạn đã mua tối đa ${lottery.LOTTERY.MAX_TICKETS_PER_DRAW} vé đợt này.`);
            if (res.error === 'insufficient') return msg.reply(`Cần ${fmt(lottery.LOTTERY.TICKET_PRICE)} ${ngocEmote} nhưng bạn chỉ có ${fmt(res.have)}.`);
            return msg.reply('Không thể mua vé.');
        }
        const nextTs = lottery.nextDrawUnix();
        return msg.reply(`🎟️ **${member.displayName}** mua 1 vé: ${lottery.fmtNumbers(res.ticket.numbers)} (-${fmt(lottery.LOTTERY.TICKET_PRICE)} ${ngocEmote})\n-# Pool: **${fmt(res.newPool)}** ${ngocEmote} · Vé của bạn: **${res.newCount}/${lottery.LOTTERY.MAX_TICKETS_PER_DRAW}** · Quay <t:${nextTs}:R>`);
    }

    if (cmd === '!setxoso_noti') {
        if (!isSuperAdmin(msg.author.id)) return;
        const arg = parts[1];
        if (!arg) {
            const current = lottery.getNotificationChannelId(guildId);
            return msg.reply(
                current
                    ? `Kênh thông báo xổ số: <#${current}>. \`!setxoso_noti #channel\` để đổi · \`!setxoso_noti clear\` để xoá.`
                    : 'Chưa cài kênh. Dùng `!setxoso_noti #channel`.'
            );
        }
        if (arg.toLowerCase() === 'clear') {
            lottery.setNotificationChannel(guildId, null);
            return msg.reply('✅ Đã xoá kênh thông báo xổ số.');
        }
        const channelId = arg.replace(/[^0-9]/g, '');
        if (!channelId) return msg.reply('Vui lòng mention `#channel` hợp lệ hoặc `clear`.');
        const targetChannel = await msg.guild.channels.fetch(channelId).catch(() => null);
        if (!targetChannel) return msg.reply('Không tìm thấy kênh được chỉ định.');
        if (targetChannel.type !== ChannelType.GuildText) return msg.reply('Kênh phải là text channel.');
        lottery.setNotificationChannel(guildId, channelId);
        return msg.reply(`✅ Kênh thông báo xổ số: <#${channelId}>.`);
    }

    if (cmd === '!xoso_drawnow') {
        if (!isSuperAdmin(msg.author.id)) return;
        const result = lottery.runDraw(guildId);
        await lottery.announceDraw(result);
        return msg.reply(`✅ Đã chạy quay xổ số thủ công (${result.ticketCount} vé). Kết quả ở kênh thông báo.`);
    }

    if (cmd === '!blockgames') {
        if (!isSuperAdmin(msg.author.id)) return;
        if (!data.blockedGameChannels) data.blockedGameChannels = {};
        if (!data.blockedGameChannels[guildId]) data.blockedGameChannels[guildId] = [];
        const blocked = data.blockedGameChannels[guildId];
        const action = (parts[1] || '').toLowerCase();

        if (action === 'list') {
            if (blocked.length === 0) return msg.reply('Không có kênh nào bị chặn game.');
            const lines = ['**Kênh bị chặn game:**'];
            for (const cid of blocked) lines.push(`• <#${cid}>`);
            return msg.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
        }

        const USAGE = 'Cú pháp: `!blockgames add|remove #channel` hoặc `!blockgames list`';
        const target = msg.mentions.channels.first();
        if (!target) return msg.reply(USAGE);

        if (action === 'add') {
            if (blocked.includes(target.id)) return msg.reply(`<#${target.id}> đã bị chặn rồi.`);
            blocked.push(target.id);
            saveData();
            return msg.reply(`✅ Đã chặn game trong <#${target.id}>. Ảnh hưởng: ${[...BLOCKED_GAME_CMDS].join(', ')}`);
        } else if (action === 'remove') {
            const idx = blocked.indexOf(target.id);
            if (idx === -1) return msg.reply(`<#${target.id}> chưa bị chặn.`);
            blocked.splice(idx, 1);
            saveData();
            return msg.reply(`✅ Đã bỏ chặn game trong <#${target.id}>.`);
        }
        return msg.reply(USAGE);
    }

    if (cmd === '!wordchain') {
        if (msg.channel.type !== ChannelType.GuildText) {
            return msg.reply('Lệnh này chỉ dùng trong text channel (không trong thread hoặc DM).');
        }
        try {
            const thread = await wordchainEng.startSession({ channel: msg.channel, invokerId: msg.author.id });
            return msg.reply(`Đã tạo thread English wordchain: <#${thread.id}>`);
        } catch (e) {
            log.error('wordchain start failed', e);
            return msg.reply('Không thể bắt đầu trò chơi.');
        }
    }

    if (cmd === '!wordchain_top') {
        const mode = (parts[1] || '').toLowerCase();
        const isLifetime = mode === 'lifetime' || mode === 'life' || mode === 'all' || mode === 'l';
        const top = isLifetime
            ? wordchainEng.getLifetimeTop(guildId, 10)
            : wordchainEng.getWeeklyTop(guildId, 10);
        const header = isLifetime
            ? `🏆 **Top English Wordchain — Lifetime**`
            : `🏆 **Top English Wordchain — Tuần này**`;
        const lines = [header];
        if (top.length === 0) {
            lines.push(isLifetime
                ? '_Chưa có ai trên bảng xếp hạng lifetime._'
                : '_Chưa có ai trên bảng xếp hạng tuần này._');
        } else {
            for (let i = 0; i < top.length; i++) {
                const [userId, best] = top[i];
                let name = userId;
                try {
                    const m = await msg.guild.members.fetch(userId).catch(() => null);
                    if (m) name = m.displayName;
                } catch (e) { /* ignore */ }
                lines.push(`${i + 1}. **${name}** — **${best}** từ`);
            }
        }
        if (!isLifetime) {
            const table = wordchainEng.getWeeklyRewardTable();
            if (table && table.length > 0) {
                lines.push('');
                lines.push(`🎁 **Thưởng tuần (reset Thứ Hai 00:00 GMT+7)** — ${renderEmote('ngoc')}`);
                for (const tier of table) {
                    const range = tier.from === tier.to ? `Top ${tier.from}` : `Top ${tier.from}-${tier.to}`;
                    lines.push(`• ${range}: **${fmt(tier.ngoc)}**`);
                }
                lines.push(`Gõ \`!wordchain_top lifetime\` để xem bảng all-time.`);
            }
        }
        return msg.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
    }

    if (cmd === '!wordchain_payout') {
        if (!isSuperAdmin(msg.author.id)) return;
        try {
            const results = await wordchainEng.runWeeklyPayout();
            if (!results || results.length === 0) {
                return msg.reply('Không có ai để trả thưởng (hoặc tuần trước đã trả rồi).');
            }
            const totalWinners = results.reduce((a, r) => a + r.paid.length, 0);
            return msg.reply(`✅ Đã trả thưởng tuần trước cho ${totalWinners} người trong ${results.length} guild.`);
        } catch (e) {
            log.error('wordchain_payout error', e);
            return msg.reply('Lỗi khi trả thưởng. Xem log.');
        }
    }

    if (cmd === '!vuatiengviet') {
        if (msg.channel.type !== ChannelType.GuildText) {
            return msg.reply('Lệnh này chỉ dùng trong text channel (không trong thread hoặc DM).');
        }
        const modeArg = (parts[1] || '').toLowerCase();
        let difficulty = 'easy';
        if (modeArg === 'medium' || modeArg === 'trung') difficulty = 'medium';
        else if (modeArg === 'hard' || modeArg === 'kho' || modeArg === 'khó') difficulty = 'hard';
        try {
            const thread = await vuaTiengViet.startSession({ channel: msg.channel, invokerId: msg.author.id, difficulty });
            return msg.reply(`Đã tạo thread Vua Tiếng Việt: <#${thread.id}>`);
        } catch (e) {
            log.error('vuatiengviet start failed', e);
            return msg.reply('Không thể bắt đầu trò chơi.');
        }
    }

    if (cmd === '!vuatiengviet_cap') {
        const status = vuaTiengViet.getCapStatus(guildId, msg.author.id);
        const lines = [
            `📊 **Cap Vua Tiếng Việt của bạn hôm nay:**`,
            `🟢 Dễ: **${fmt(status.easy.earned)}** / **${fmt(status.easy.cap)}** ${renderEmote('ngoc')}`,
            `🟡 Trung Bình: **${fmt(status.medium.earned)}** / **${fmt(status.medium.cap)}** ${renderEmote('ngoc')}`,
            `🔴 Khó: **${fmt(status.hard.earned)}** / **${fmt(status.hard.cap)}** ${renderEmote('ngoc')}`
        ];
        return msg.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
    }

    if (cmd === '!vuatiengviet_top') {
        const mode = (parts[1] || '').toLowerCase();
        const isLifetime = mode === 'lifetime' || mode === 'life' || mode === 'all' || mode === 'l';
        const top = isLifetime
            ? vuaTiengViet.getLifetimeTop(guildId, 10)
            : vuaTiengViet.getWeeklyTop(guildId, 10);
        const header = isLifetime
            ? `🏆 **Top Vua Tiếng Việt — Lifetime** (tổng ngọc kiếm được)`
            : `🏆 **Top Vua Tiếng Việt — Tuần này** (tổng ngọc kiếm được)`;
        const lines = [header];
        if (top.length === 0) {
            lines.push('_Chưa có ai trên bảng xếp hạng._');
        } else {
            for (let i = 0; i < top.length; i++) {
                const [userId, v] = top[i];
                let name = userId;
                try { const m = await msg.guild.members.fetch(userId).catch(() => null); if (m) name = m.displayName; } catch (e) { /* ignore */ }
                lines.push(`${i + 1}. **${name}** — **${fmt(v.ngoc || 0)}** ${renderEmote('ngoc')} (${fmt(v.words || 0)} từ)`);
            }
        }
        if (!isLifetime) {
            const table = vuaTiengViet.getWeeklyRewardTable();
            if (table && table.length > 0) {
                lines.push('');
                lines.push(`🎁 **Thưởng tuần (reset Thứ Hai 00:00 GMT+7)**`);
                for (const tier of table) {
                    const range = tier.from === tier.to ? `Top ${tier.from}` : `Top ${tier.from}-${tier.to}`;
                    lines.push(`• ${range}: **${fmt(tier.ngoc)}** ${renderEmote('ngoc')}`);
                }
                lines.push(`Gõ \`!vuatiengviet_top lifetime\` để xem bảng all-time.`);
            }
        }
        return msg.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
    }

    if (cmd === '!vtv_boquathuong') {
        const nowOut = vuaTiengViet.toggleOptOut(guildId, msg.author.id);
        return msg.reply(nowOut
            ? 'Bạn đã bỏ qua thưởng tuần Vua Tiếng Việt. Gõ lại để nhận lại.'
            : 'Bạn đã đăng ký nhận thưởng tuần Vua Tiếng Việt trở lại.');
    }

    if (cmd === '!vuatiengviet_payout') {
        if (!isSuperAdmin(msg.author.id)) return;
        try {
            const results = await vuaTiengViet.runWeeklyPayout();
            if (!results || results.length === 0) {
                return msg.reply('Không có ai để trả thưởng (hoặc tuần trước đã trả rồi).');
            }
            const totalWinners = results.reduce((a, r) => a + r.paid.length, 0);
            return msg.reply(`✅ Đã trả thưởng tuần trước cho ${totalWinners} người trong ${results.length} guild.`);
        } catch (e) {
            log.error('vuatiengviet_payout error', e);
            return msg.reply('Lỗi khi trả thưởng. Xem log.');
        }
    }

    if (cmd === '!vuatiengviet_resetcap') {
        if (!isSuperAdmin(msg.author.id)) return;
        const count = vuaTiengViet.resetDailyCaps(guildId);
        return msg.reply(`✅ Đã reset cap ngày Vua Tiếng Việt cho **${count}** người trong server.`);
    }

    if (cmd === '!upload_ingame_emotes') {
        if (!isSuperAdmin(msg.author.id)) return;
        if (msg.guildId !== EMOTE_GUILD_ID) {
            return msg.reply(`Lệnh này phải chạy trong emote guild. Current = ${msg.guildId}`);
        }
        const ids = data.ingameEmoteIds || {};
        const failures = [];
        const GIF_EMOTES = new Set(['shake_tt', 'slotanim']);
        for (const name of INGAME_EMOTE_NAMES) {
            const ext = GIF_EMOTES.has(name) ? 'gif' : 'png';
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

    if (cmd === '!wordchain_reset') {
        if (!msg.member.permissions.has('ManageGuild') && !isSuperAdmin(msg.author.id)) return;
        if (!data.wordchainEng || !data.wordchainEng.wordCounts || !data.wordchainEng.wordCounts[guildId]) {
            return msg.reply('Không có dữ liệu daily limit để reset.');
        }
        data.wordchainEng.wordCounts[guildId] = {};
        saveData();
        return msg.reply('✅ Đã reset daily limit ngọc wordchain cho toàn bộ user trong server.');
    }

    if (cmd === '!setwordchain_noti') {
        if (!msg.member.permissions.has('ManageGuild') && !isSuperAdmin(msg.author.id)) return;
        const arg = parts[1];
        if (!arg) {
            const current = data.wordchainNotiChannel && data.wordchainNotiChannel[guildId];
            return msg.reply(
                current
                    ? `Kênh thông báo thưởng tuần wordchain: <#${current}>. Dùng \`!setwordchain_noti #channel\` để đổi hoặc \`!setwordchain_noti clear\` để xoá.`
                    : 'Chưa cài kênh riêng. Dùng `!setwordchain_noti #channel`. (Nếu chưa cài sẽ dùng kênh mặc định của bot.)'
            );
        }
        if (arg.toLowerCase() === 'clear') {
            if (data.wordchainNotiChannel) delete data.wordchainNotiChannel[guildId];
            saveData();
            return msg.reply('✅ Đã xoá kênh thông báo wordchain. Sẽ dùng kênh mặc định của bot.');
        }
        const channelId = arg.replace(/[^0-9]/g, '');
        if (!channelId) return msg.reply('Vui lòng mention `#channel` hợp lệ hoặc `clear`.');
        const targetChannel = await msg.guild.channels.fetch(channelId).catch(() => null);
        if (!targetChannel) return msg.reply('Không tìm thấy kênh được chỉ định.');
        data.wordchainNotiChannel = data.wordchainNotiChannel || {};
        data.wordchainNotiChannel[guildId] = channelId;
        saveData();
        return msg.reply(`✅ Kênh thông báo thưởng tuần wordchain: <#${channelId}>.`);
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
