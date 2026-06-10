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
const { rollMany, formatRollResult, getPityStatus } = require('./services/gacha');
const { runMultiRoll: runSlotMultiRoll, SLOT_MAX_ROLLS } = require('./services/slot');
const { runMultiFlip: runCoinflipMulti, COINFLIP_MAX_FLIPS } = require('./services/coinflip');
const dice = require('./services/dice');
const lottery = require('./services/lottery');
const metrics = require('./services/metrics');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const economy = require('./config/economy');
const { CURRENT_VERSION, CHANGELOG } = require('./config/changelog');
const wordchainEng = require('./services/wordchainEng');
const vuaTiengViet = require('./services/vuaTiengViet');
const flashMath = require('./services/flashMath');
const mathBoss = require('./services/mathBoss');
const bond = require('./services/bond');
const profileCmd = require('./commands/profile');
const profile = require('./services/profile');
const lixiSvc = require('./services/lixi');
const season = require('./services/season');
const seasonCfg = require('./config/season');
const seasonTeaser = require('./services/seasonTeaser');
const exchange = require('./services/exchange');

const BLOCKED_GAME_CMDS = new Set([
    '!slot', '!coinflip', '!tong', '!sum', '!mat', '!face',
    '!gacha', '!wordchain', '!vuatiengviet', '!flashmath', '!boss'
]);

const DISCLAIMER = `⚠️ **Lưu ý về tiền tệ & vật phẩm trong bot**
• **Ngọc, ngân phiếu, thiên thưởng** và **mọi vật phẩm** (cáo, diều, trang phục, danh hiệu…) trong bot chỉ là dữ liệu ảo dùng cho mục đích **giải trí trong server**.
• Chúng **KHÔNG có giá trị thực** và **KHÔNG quy đổi ra tiền thật** hay bất kỳ tài sản nào có giá trị thực.
• **Nghiêm cấm** mua bán, trao đổi, sang nhượng tiền tệ/vật phẩm trong bot để lấy tiền thật hoặc lợi ích bên ngoài. Mọi giao dịch như vậy bot **không công nhận** và **không chịu trách nhiệm**.
• Số dư và vật phẩm có thể bị điều chỉnh, reset hoặc mất do bảo trì, sửa lỗi hoặc cân bằng game — đây là điều bình thường và không phải là mất mát tài sản thực.`;

async function handleMessageCommand(msg) {
    const parts = msg.content.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const guildId = msg.guildId;

    // Fast path: every guild message reaches here, but only "!" commands are
    // handled below. Bail immediately on plain chat so it costs ~nothing
    // (no member fetch, no walking the command chain).
    if (!cmd.startsWith('!')) return;

    if (BLOCKED_GAME_CMDS.has(cmd)) {
        const blockedArr = data.blockedGameChannels && data.blockedGameChannels[guildId];
        if (blockedArr && new Set(blockedArr).has(msg.channel.id)) {
            return msg.reply('❌ Kênh này không cho phép chơi game. Vui lòng vào kênh game để chơi.');
        }
    }

    // msg.member is already populated for guild messages — avoid a redundant
    // (and possibly network-bound) fetch on the command hot path.
    const member = msg.member || await msg.guild.members.fetch(msg.author.id);

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
• \`!doi [vật phẩm] [1|2|3|all]\` — Đổi vật phẩm cao cấp (TT → linh thú/trang phục, linh thú → bậc cao hơn). Không gõ vật phẩm → menu chọn. Vật phẩm mùa cũ vẫn đổi được nhưng **không tính điểm** BXH.
• \`!phangiai [linh thú] [n|all]\` — Phân giải linh thú → thiên thưởng. Linh thú giá trị ≥9 TT bị phạt: −10% TT hoặc trừ 20% giá trị bằng ngọc (chọn khi xác nhận).
• \`!gacha [1-100|all]\` — Quay gacha, ${fmt(economy.GACHA.ROLL_COST)} ngọc/lần. Pity lượt 20 (KT+) / 200 (TT).
• \`!pity\` — Xem lượt còn lại đến pity.
• \`!toptt\` / \`!topngoc\` — Bảng xếp hạng.
• \`!season\` — Xem mùa giải: thời gian còn lại, phần thưởng & cách nhận, thứ hạng của bạn.
• \`!nextseason\` — Teaser mùa mới: vật phẩm sắp ra, phần thưởng cuối mùa & huy hiệu Top 1-3.
• \`!tangngoc @user <n|all>\` / \`!tangthienthuong @user [n|all]\` — Tặng ngọc/thiên thưởng (+ Điểm Thân mật).
• \`!tangcao\` / \`!tangcao5\` / \`!tangcao9\` / \`!tangdieu @user [n|all]\` — Tặng vật phẩm (+ Điểm Thân mật).
• \`!tangphuongbang\` / \`!tangphuonghoa\` / \`!tangthantrang @user [n|all]\` — Tặng trang phục (+ Điểm Thân mật).
• \`!lixi <tổng> <số người>\` — Lì xì: chia tổng ngọc thành N phần random, mỗi phần ≥ floor(tổng / 2N). React 🧧 để nhận.
• \`!banthienthuong <n|all>\` / \`!bancao <n|all>\` — Bán đổi ngọc.
• \`!bankythuong\` / \`!bandieu\` / \`!bannhuom <n|all>\` — Bán low-tier (giá ${fmt(economy.SELL_PRICE_NGOC.kythuong)}/${fmt(economy.SELL_PRICE_NGOC.dieu)}/${fmt(economy.SELL_PRICE_NGOC.nhuom)} ngọc).
• \`!doi\` thay các lệnh cũ \`!doithienthuong\` / \`!doicao5\` / \`!doicao9\` / \`!doiphuongbang\` / \`!doiphuonghoa\` / \`!doithantrang\` (vd: \`!doi cao 1\`, \`!doi phuonghoa all\`).
  (Phượng & Thần Trang: chỉ đổi 1 chiều, không bán, có thể tặng.)
• \`!bond [@user]\` — Xem Điểm Thân mật (top 10 hoặc cụ thể với 1 user).

**Mini Games:**
• \`!coinflip [sap|ngua] <x|all> [số lần]\` — Cược ngọc 50/50, tối đa ${fmt(economy.COINFLIP_MAX_BET)}/lần. Tung nhiều lần cùng lúc (\`số lần\` tối đa ${COINFLIP_MAX_FLIPS}, vd \`!coinflip 500 5\` = 2500 ngọc).
• \`!slot <x|all> [n]\` — Slot 3 reels, tối đa ${fmt(economy.SLOT_MAX_BET)}/lượt. Jackpot x200. Có thể quay nhiều lượt cùng lúc (\`n\` tối đa 5, vd: \`!slot 500 5\` = 2500 ngọc).
• \`!tong <x|all> <3-18> [3-18 ...]\` — Đoán tổng 3 xúc xắc, cược nhiều cửa cùng lúc (mỗi cửa tối đa ${fmt(economy.TONG_MAX_BET)}, vd \`!tong 200 10 11\`). Trúng x8–x200.
• \`!mat <x|all> <1-6> [1-6 ...]\` — Đoán mặt xuất hiện trong 3 xúc xắc, cược nhiều cửa cùng lúc (mỗi cửa tối đa ${fmt(economy.MAT_MAX_BET)}, vd \`!mat 200 5 6\`). Trúng x2/x4/x6.
• \`!xoso\` — Xổ số tích lũy: chọn 4 số 1-${lottery.LOTTERY.NUMBER_POOL_MAX}, vé ${fmt(lottery.LOTTERY.TICKET_PRICE)} ngọc (max ${lottery.LOTTERY.MAX_TICKETS_PER_DRAW}/đợt). Quay 10h sáng & 10h tối. \`!xoso pool\` / \`!xoso bao [n]\` / \`!xoso ve\`.
• \`!wordchain\` — Tạo thread chơi nối từ tiếng Anh **co-op** (nhiều người cùng nối). Thưởng Ngọc theo các từ mỗi người đóng góp.
• \`!wordchain_top [week]\` — Bảng xếp hạng English Wordchain (lifetime / tuần).
• \`!boquathuong\` — Bỏ qua / nhận lại thưởng tuần English Wordchain (toggle, thưởng chuyển xuống người xếp dưới).
• \`!flashmath\` — Tạo thread **Flash Math**: trả lời nhanh phép tính, ai đúng trước nhận ngọc. **Hết giờ là kết thúc** — BXH xếp theo cấp cao nhất. Cap ${fmt(economy.FLASHMATH.DAILY_CAP)} ${renderEmote('ngoc')}/ngày. \`!flashmath_top\` (tuần) / \`!flashmath_top lifetime\` xem BXH, \`!flashmath_cap\` xem cap. Thưởng tuần: Top 1 = 15k · Top 2-3 = 8k · Top 4-10 = 4k.
• \`!boss <small|medium|big>\` — Triệu hồi **Boss toán học** để solo hoặc cả nhóm cùng đánh (giải phép tính = sát thương). Thưởng chia theo sát thương, cap ${fmt(economy.MATHBOSS.NGOC_DAILY_CAP)} ${renderEmote('ngoc')}/ngày.

**Khác:**
• Chat: +${fmt(economy.CHAT_REWARD)} ngân phiếu/tin (cap ${fmt(economy.CHAT_DAILY_CAP)}/ngày).
• Báo danh bang chiến: +${fmt(economy.BANG_CHIEN_REWARD)} ngọc/lần.
• \`!disclaimer\` — Lưu ý về tiền tệ & vật phẩm ảo (không có giá trị thực).

${DISCLAIMER}`;
        await replyChunked(msg, userHelp);
        return;
    }

    if (cmd === '!disclaimer') {
        await replyChunked(msg, DISCLAIMER);
        return;
    }

    if (cmd === '!devhelp') {
        if (!isSuperAdmin(msg.author.id)) return;
        const devHelp = `**Dev / Admin Commands — Bot v${CURRENT_VERSION}**

**Quản lý bot:**
• \`!maintenance on|off\` — Bật/tắt bảo trì (chặn input mới trước restart).
• \`!upload_ingame_emotes [force]\` — Upload emote ingame (slot, dice...). Tự xoá emote trùng, chỉ upload cái thiếu; \`force\` = upload lại toàn bộ.
• \`!uploademotes\` — Upload emote class.
• \`!gangoc <n> [#kênh]\` — GA ngọc, user react để nhận.

**Metrics & Debug:**
• \`!metrics [slot|coinflip|tong|mat|gacha|wordchain|vuatiengviet|flashmath|boss|daily|gangoc] [YYYY-MM-DD] [all|<guildId>]\` — Mặc định guild hiện tại; \`all\` để gộp; truyền guildId cụ thể để xem 1 guild khác.
• \`!metrics list\` — Liệt kê các file metrics đã lưu. \`!metrics guilds\` — Liệt kê guilds có data.
• \`!metrics_exclude [list|add|remove|clean] @user\` — Loại user khỏi metrics (skip toàn bộ record + dọn playerIds cũ).
• \`!metrics_adjust <guildId|_legacy> <YYYY-MM-DD|today> <game> <field=delta> [...]\` — Cộng/trừ trực tiếp vào bucket (vd: \`rolls=-30 burned=-3000 itemCounts.cao=-1\`).
• \`!wordchain_payout\` — Trả thưởng tuần trước cho top 10 English Wordchain ngay (cron tự chạy Thứ Hai 00:00 GMT+7).
• \`!wordchain_reset\` — Reset daily limit ngọc wordchain (20 lần/vị trí) cho toàn server (ManageGuild).
• \`!setwordchain_noti [#channel|clear]\` — Cài kênh riêng nhận thông báo thưởng tuần wordchain (ManageGuild). Mặc định dùng kênh bot.
• \`!setxoso_noti [#channel|clear]\` — Cài kênh thông báo xổ số tích lũy. Bắt buộc set để bot announce.
• \`!xoso_drawnow\` — Chạy quay xổ số thủ công (test / chữa cháy nếu cron lỡ).
• \`!vtv_fixscore @user <±delta>\` — Cộng/trừ điểm lifetime Vua Tiếng Việt của 1 người (vd \`+5000\` / \`-3000\`).

**Mùa Giải (Season):**
• \`!season_setchannel [#channel|clear]\` — Cài kênh announce kết thúc mùa.
• \`!season_setlength <số tuần>\` — Đổi độ dài mùa (mặc định 8 tuần).
• \`!season_setend +<ngày>|<YYYY-MM-DD>\` — Đặt thời điểm kết thúc mùa hiện tại.
• \`!season_end\` — Chốt mùa ngay (trao danh hiệu/huy hiệu, sang mùa mới). Dùng test / chữa cháy nếu cron lỡ.

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
        const GAMES = new Set(['slot', 'coinflip', 'tong', 'mat', 'gacha', 'wordchain', 'wordchain_eng', 'vuatiengviet', 'flashmath', 'mathboss', 'boss', 'daily', 'gangoc']);
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
            n = Math.floor(totalNgocGacha / economy.GACHA.ROLL_COST);
            if (n <= 0) return msg.reply(`Bạn không có đủ ngọc để quay. Cần ít nhất ${fmt(economy.GACHA.ROLL_COST)} ngọc.`);
            const cost = n * economy.GACHA.ROLL_COST;
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
        const cost = n * economy.GACHA.ROLL_COST;
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
            if (counts[k] > 0) addItem(guildId, msg.author.id, season.mapGachaKey(k), counts[k]);
        }
        if (counts.cao > 0 || counts.thienthuong > 0) season.bumpScoreTime(guildId, msg.author.id);
        saveData();
        metrics.recordGacha({ guildId, rolls: n, cost, counts, userId: msg.author.id, ...gachaMeta });
        profile.recordGacha(guildId, msg.author.id, n, counts);
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

    // ── Unified exchange: !doi [item] [1|2|3|all] ───────────────────────────
    // No args → interactive picker (select + qty buttons). Covers every premium
    // item of every season up to the current one (old items score 0).
    if (cmd === '!doi') {
        if (!parts[1]) {
            return msg.reply({
                content: exchange.DOI_HEADER,
                components: exchange.buildDoiComponents(guildId, msg.author.id, null),
                allowedMentions: { parse: [] }
            });
        }
        const entry = exchange.resolveAlias(parts[1]);
        if (!entry) {
            const names = exchange.catalog().map(e => `\`${e.key}\``).join(', ');
            return msg.reply(`Không có vật phẩm \`${parts[1]}\`. Vật phẩm hợp lệ: ${names}. Hoặc gõ \`!doi\` để mở menu.`);
        }
        const qty = !parts[2] ? 1 : (parts[2] === 'all' ? 'all' : parseInt(parts[2], 10));
        if (qty !== 'all' && (!Number.isInteger(qty) || qty <= 0)) {
            return msg.reply(`Cú pháp: \`!doi ${entry.key} <số lượng|all>\` — đổi ${exchange.costText(entry)} → 1 ${entry.label}.`);
        }
        const res = exchange.performExchange(guildId, msg.author.id, entry.key, qty);
        if (!res.ok) return msg.reply(`⛔ ${res.error}`);
        return msg.reply(`✅ ${exchange.exchangeResultText(guildId, msg.author.id, res)}`);
    }

    // ── Unified dismantle: !phangiai [pet] [n|all] ──────────────────────────
    // Pets only. Unit value >= 9 TT → penalty, chosen via confirm buttons.
    if (cmd === '!phangiai') {
        if (!parts[1]) {
            const components = exchange.buildPhangiaiComponents(guildId, msg.author.id, null);
            if (!components) return msg.reply('Bạn không có linh thú nào để phân giải.');
            return msg.reply({ content: exchange.PG_HEADER, components, allowedMentions: { parse: [] } });
        }
        const entry = exchange.resolveAlias(parts[1]);
        if (!entry) {
            const names = exchange.catalog().filter(e => e.dismantlable).map(e => `\`${e.key}\``).join(', ');
            return msg.reply(`Không có vật phẩm \`${parts[1]}\`. Linh thú phân giải được: ${names}. Hoặc gõ \`!phangiai\` để mở menu.`);
        }
        const qty = !parts[2] ? 1 : (parts[2] === 'all' ? 'all' : parseInt(parts[2], 10));
        if (qty !== 'all' && (!Number.isInteger(qty) || qty <= 0)) {
            return msg.reply(`Cú pháp: \`!phangiai ${entry.key} <số lượng|all>\` — phân giải 1 ${entry.label} → ${fmt(entry.value)} thiên thưởng.`);
        }
        const quote = exchange.dismantleQuote(guildId, msg.author.id, entry.key, qty);
        if (!quote.ok) return msg.reply(`⛔ ${quote.error}`);
        if (quote.penalized) {
            const confirm = exchange.buildPenaltyConfirm(msg.author.id, quote);
            return msg.reply({ ...confirm, allowedMentions: { parse: [] } });
        }
        const res = exchange.performDismantle(guildId, msg.author.id, entry.key, quote.n, 'plain');
        if (!res.ok) return msg.reply(`⛔ ${res.error}`);
        return msg.reply(`✅ ${exchange.dismantleResultText(guildId, msg.author.id, res)}`);
    }

    // Legacy exchange commands — folded into !doi / !phangiai.
    const LEGACY_DOI = {
        '!doithienthuong': 'cao', '!doicao5': 'cao5', '!doicao9': 'cao9',
        '!doiphuongbang': 'phuongbang', '!doiphuonghoa': 'phuonghoa', '!doithantrang': 'thantrang'
    };
    if (LEGACY_DOI[cmd]) {
        return msg.reply(`Lệnh này đã gộp về \`!doi\`. Dùng: \`!doi ${LEGACY_DOI[cmd]} <số lượng|all>\` — hoặc \`!doi\` để mở menu chọn.`);
    }
    if (cmd === '!phangiaicao') {
        return msg.reply('Lệnh này đã gộp về `!phangiai`. Dùng: `!phangiai cao <số lượng|all>` — hoặc `!phangiai` để mở menu chọn.');
    }

    if (cmd === '!tangthienthuong' || cmd === '!tangcao' || cmd === '!tangcao5' || cmd === '!tangcao9' || cmd === '!tangdieu'
        || cmd === '!tangphuongbang' || cmd === '!tangphuonghoa' || cmd === '!tangthantrang') {
        // Premium tiers resolve to the CURRENT season's item key, so gifts always
        // move current-season items (past-season premium items are frozen and
        // simply have no command path). Non-premium gifts use a fixed key.
        const giftMap = {
            '!tangthienthuong': { key: 'thienthuong', bondPer: economy.BOND.PER_THIENTHUONG },
            '!tangcao': { tier: 'pet1', bondPer: economy.BOND.PER_CAO },
            '!tangcao5': { tier: 'pet2', bondPer: economy.BOND.PER_CAO5 },
            '!tangcao9': { tier: 'pet3', bondPer: economy.BOND.PER_CAO9 },
            '!tangdieu': { key: 'dieu', bondPer: economy.BOND.PER_DIEU },
            '!tangphuongbang': { tier: 'thanthu', bondPer: economy.BOND.PER_PHUONGHOANG1 },
            '!tangphuonghoa': { tier: 'thanthuplus', bondPer: economy.BOND.PER_PHUONGHOANG2 },
            '!tangthantrang': { tier: 'thantrang', bondPer: economy.BOND.PER_THANTRANG }
        };
        const giftEntry = giftMap[cmd];
        const itemKey = giftEntry.key || season.resolveItem(giftEntry.tier);
        if (!itemKey) return msg.reply('Mùa này không có vật phẩm này.');
        const bondPer = giftEntry.bondPer;
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
        if (season.isScoredKey(itemKey)) season.bumpScoreTime(guildId, targetId);
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
        const itemKey = isCao ? season.resolveItem('pet1') : 'thienthuong';
        const itemLabel = isCao ? ITEM_LABELS[itemKey] : 'thiên thưởng';
        const pricePerUnit = isCao
            ? economy.ROLLS_PER_THIENTHUONG * economy.GACHA.ROLL_COST * season.exchangeRatio('ttPerPet1')
            : economy.ROLLS_PER_THIENTHUONG * economy.GACHA.ROLL_COST;
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

    if (cmd === '!lixi') {
        const totalArg = parseInt(parts[1], 10);
        const peopleArg = parseInt(parts[2], 10);
        const usage = `Cú pháp: \`!lixi <tổng ngọc> <số người>\` (tối đa ${lixiSvc.LIXI_MAX_PEOPLE} người). Mỗi phần ≥ floor(tổng / (2·số người)).`;
        if (!Number.isInteger(totalArg) || totalArg <= 0 || !Number.isInteger(peopleArg) || peopleArg <= 0) {
            return msg.reply(usage);
        }
        if (peopleArg > lixiSvc.LIXI_MAX_PEOPLE) {
            return msg.reply(`Số người tối đa là ${lixiSvc.LIXI_MAX_PEOPLE}.`);
        }
        if (totalArg < peopleArg) {
            return msg.reply(`Tổng ngọc phải ≥ số người (mỗi phần ≥ 1). Cần ít nhất ${fmt(peopleArg)} ngọc.`);
        }
        const w = getWallet(guildId, msg.author.id);
        const haveNgoc = w.ngoc + (w.lockedNgoc || 0);
        if (haveNgoc < totalArg) {
            return msg.reply(`Bạn cần ${fmt(totalArg)} ${renderEmote('ngoc')} nhưng chỉ có ${fmt(haveNgoc)}.`);
        }

        let parts_;
        try { parts_ = lixiSvc.splitLixi(totalArg, peopleArg); }
        catch (e) { return msg.reply(`Không tạo được lì xì: ${e.message}`); }

        spendNgocForGame(guildId, msg.author.id, totalArg);

        const ngocEmote = renderEmote('ngoc');
        const minPart = Math.floor(totalArg / (2 * peopleArg));
        const intro = [
            `# 🧧 Lì xì từ **${member.displayName}** 🧧`,
            `**${fmt(totalArg)}** ${ngocEmote} chia cho **${fmt(peopleArg)}** người — mỗi phần ≥ **${fmt(Math.max(1, minPart))}**.`,
            `React ${lixiSvc.LIXI_EMOJI} để nhận (1 lần/người, không gồm chủ lì xì).`
        ].join('\n');
        const sent = await msg.channel.send({ content: intro });
        try { await sent.react(lixiSvc.LIXI_EMOJI); } catch (e) { log.warn('lixi react failed', e); }
        lixiSvc.createLixi({
            messageId: sent.id, channelId: sent.channel.id, guildId,
            authorId: msg.author.id, total: totalArg, people: peopleArg, parts: parts_
        });
        return;
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
        // Ranking (current-season premium items + thiên thưởng), tiebroken by
        // who reached the score first — see services/season.js.
        const ranking = season.rankGuild(guildId);
        const top = ranking.slice(0, 10);
        if (top.length === 0) return msg.reply('Chưa có ai có thiên thưởng.');
        // Display order: thiên thưởng first, then the premium tiers.
        const scored = season.scoredItems();
        const displayKeys = ['thienthuong', ...scored.filter(s => s.key !== 'thienthuong').map(s => s.key)];
        const lines = ['**Top 10 Thiên Thưởng**'];
        for (let i = 0; i < top.length; i++) {
            const { userId, score, owned } = top[i];
            let name = userId;
            try {
                const member = await msg.guild.members.fetch(userId).catch(() => null);
                if (member) name = member.displayName;
            } catch (e) {}
            const partsLine = [];
            for (const key of displayKeys) {
                if (owned[key] > 0) partsLine.push(`${fmt(owned[key])} ${renderEmote(key)}`);
            }
            lines.push(`${i + 1}. **${name}**: ${partsLine.join(' + ')} = **${fmt(score)}** điểm`);
        }
        return msg.reply(lines.join('\n'));
    }

    if (cmd === '!topngoc') {
        const rankings = season.rankGuildNgoc(guildId);
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
        lines.push('');
        lines.push('*Cuối mùa, Top 1-3 nhận **danh hiệu vĩnh viễn + huy hiệu** trưng trên profile (`!nextseason` để xem).*');
        return msg.reply(lines.join('\n'));
    }

    if (cmd === '!season') {
        const sub = (parts[1] || '').toLowerCase();
        // `!season top` → same ranking as !toptt.
        if (sub === 'top') {
            const ranking = season.rankGuild(guildId);
            const top = ranking.slice(0, 10);
            if (top.length === 0) return msg.reply('Chưa có ai có thiên thưởng.');
            const scored = season.scoredItems();
            const displayKeys = ['thienthuong', ...scored.filter(s => s.key !== 'thienthuong').map(s => s.key)];
            const lines = [`**Top 10 Thiên Thưởng — Mùa ${season.getCurrentSeasonId()}**`];
            for (let i = 0; i < top.length; i++) {
                const { userId, score, owned } = top[i];
                let name = userId;
                const m2 = await msg.guild.members.fetch(userId).catch(() => null);
                if (m2) name = m2.displayName;
                const partsLine = [];
                for (const key of displayKeys) if (owned[key] > 0) partsLine.push(`${fmt(owned[key])} ${renderEmote(key)}`);
                lines.push(`${i + 1}. **${name}**: ${partsLine.join(' + ')} = **${fmt(score)}** điểm`);
            }
            return msg.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
        }

        const cur = season.getCurrentSeason();
        const remMs = season.timeRemainingMs();
        const days = Math.floor(remMs / 86400000);
        const hours = Math.floor((remMs % 86400000) / 3600000);
        const endsAt = season.getState().endsAt;
        const { rank, score, total } = season.getUserRank(guildId, msg.author.id);
        const premiumStr = season.scoredItems()
            .filter(s => s.tier)
            .map(s => `${renderEmote(s.key)} ${ITEM_LABELS[s.key]} (×${fmt(s.mult)})`)
            .join(', ');
        const lines = [
            `# 🏆 Mùa ${cur.id} — ${cur.name}`,
            `⏳ Kết thúc sau **${days} ngày ${hours} giờ** — <t:${Math.floor(endsAt / 1000)}:R> (reset 00:00 GMT+7).`,
            '',
            `**Điểm BXH mùa này** = ${renderEmote('thienthuong')} Thiên Thưởng (×1) + vật phẩm cao cấp của mùa:`,
            premiumStr,
            `Thứ hạng của bạn: ${rank ? `**#${rank}**/${total}` : '*chưa xếp hạng*'} — **${fmt(score)}** điểm.`,
            '',
            `**Cách nhận vật phẩm cao cấp:** quay \`!gacha\`, hoặc đổi bằng \`!doi\` (gõ \`!doi\` để mở menu; \`!phangiai\` phân giải linh thú → thiên thưởng).`,
            '',
            '**🎁 Khi mùa kết thúc (tự động):**',
            '• **Top 1-5** BXH Thiên Thưởng nhận **danh hiệu vĩnh viễn** hiện dưới tên (Top 1-3 kèm **huy hiệu** độc quyền — gắn vào ô khoe vật phẩm trong `/profile`).',
            '• **Top 1-3** BXH Ngọc (`!topngoc`) cũng nhận **danh hiệu vĩnh viễn + huy hiệu** riêng.',
            '• Ai đang giữ vật phẩm cao cấp của mùa nhận **danh hiệu sưu tầm** — chọn khoe trong `/profile`.',
            '• Vật phẩm cao cấp **mùa cũ không còn tính điểm BXH** (vẫn đổi `!doi` / phân giải `!phangiai` được, nhưng **không bán / tặng**).',
            `• ${renderEmote('thienthuong')} **Thiên Thưởng giữ nguyên** và vẫn tính điểm sang mùa mới.`,
            '',
            'Xem bảng xếp hạng: `!toptt` (hoặc `!season top`).'
        ];
        return msg.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
    }

    if (cmd === '!nextseason') {
        const curId = season.getCurrentSeasonId();
        const cur = season.getCurrentSeason();
        const nextId = curId + 1;
        const next = seasonCfg.getSeason(nextId);
        const remMs = season.timeRemainingMs();
        const days = Math.floor(remMs / 86400000);
        const hours = Math.floor((remMs % 86400000) / 3600000);
        // Only show a chat emote for an item once its emote has been uploaded.
        const emoteIf = (key) => (data.ingameEmoteIds && data.ingameEmoteIds[key]) ? `${renderEmote(key)} ` : '';

        const lines = [];
        if (next) {
            lines.push(`# 🔮 Sắp ra mắt — Mùa ${next.id}: ${next.name}!`);
            lines.push('');
            lines.push('**✨ Vật phẩm cao cấp mùa mới:**');
            for (const tier of seasonCfg.seasonTiers(nextId)) {
                const key = next.items[tier];
                lines.push(`• ${emoteIf(key)}**${ITEM_LABELS[key]}**`);
            }
            const p1 = next.items.pet1, p2 = next.items.pet2;
            if (p1 && p2) {
                const r12 = season.exchangeRatio('pet1PerPet2', nextId);
                lines.push(`*Quy đổi: ${r12} ${ITEM_LABELS[p1]} = 1 ${ITEM_LABELS[p2]}${seasonCfg.hasTier('pet3', nextId) ? '' : ' · mùa này chỉ có 2 bậc linh thú'}.*`);
            }
            lines.push('');
        } else {
            lines.push('# 🔮 Mùa Giải tiếp theo sắp tới!');
            lines.push('');
        }

        lines.push(`**🏆 Phần thưởng cuối Mùa ${cur.id} — ${cur.name} (đang diễn ra, còn ${days} ngày ${hours} giờ):**`);
        lines.push('Top BXH Thiên Thưởng nhận **danh hiệu vĩnh viễn dưới tên**, Top 1-3 kèm **huy hiệu** độc quyền (gắn vào ô khoe vật phẩm):');
        const medal = { 1: '🥇', 2: '🥈', 3: '🥉' };
        for (const rank of [1, 2, 3, 4, 5]) {
            const tt = cur.topTitles[rank];
            if (!tt) continue;
            if (rank === 5 && cur.topTitles[4] && cur.topTitles[4].id === tt.id) {
                // top4-5 share a title; render once as "Top 4-5"
                continue;
            }
            const label = (rank === 4 && cur.topTitles[5] && cur.topTitles[5].id === tt.id) ? 'Top 4-5' : `Top ${rank}`;
            lines.push(`• ${medal[rank] || '🎖️'} **${label}**: *${tt.name}*${tt.badge ? ' 🎖️ (huy hiệu)' : ''}`);
        }
        if (cur.topNgoc) {
            lines.push(`Top 1-3 BXH Ngọc (\`!topngoc\`) cũng nhận **danh hiệu + huy hiệu** riêng:`);
            for (const rank of [1, 2, 3]) {
                const tn = cur.topNgoc[rank];
                if (!tn) continue;
                lines.push(`• ${medal[rank]} **Top ${rank}**: *${tn.name}*${tn.badge ? ' 🎖️ (huy hiệu)' : ''}`);
            }
        }
        lines.push('Giữ vật phẩm cao cấp tới cuối mùa → **danh hiệu sưu tầm** (chọn khoe ở `/profile`):');
        for (const tier of seasonCfg.seasonTiers(cur.id)) {
            const key = cur.items[tier];
            const title = cur.titles[tier];
            if (title) lines.push(`• ${emoteIf(key)}${ITEM_LABELS[key]} → *${title.name}*`);
        }
        lines.push('');
        lines.push(`Vật phẩm cao cấp mùa cũ **không còn tính điểm BXH** (vẫn đổi/phân giải được qua \`!doi\` / \`!phangiai\`); ${renderEmote('thienthuong')} **Thiên Thưởng giữ nguyên**. Gõ \`!season\` để xem chi tiết.`);

        const files = [];
        if (next) {
            try {
                const strip = await seasonTeaser.renderItemsStrip(nextId);
                if (strip) files.push(new AttachmentBuilder(strip, { name: `mua${nextId}_vatpham.png` }));
            } catch (e) { log.warn(`nextseason items strip failed: ${e.message}`); }
        }
        try {
            // Badges of the CURRENT season — what players are racing for now.
            const badges = await seasonTeaser.renderBadgeStrip(curId);
            if (badges) files.push(new AttachmentBuilder(badges, { name: `mua${curId}_huyhieu.png` }));
        } catch (e) { log.warn(`nextseason badge strip failed: ${e.message}`); }
        try {
            const demo = await seasonTeaser.renderDemoCard();
            if (demo) files.push(new AttachmentBuilder(demo, { name: 'huyhieu_demo.png' }));
        } catch (e) { log.warn(`nextseason demo card failed: ${e.message}`); }

        return msg.reply({ content: lines.join('\n'), files, allowedMentions: { parse: [] } });
    }

    if (cmd === '!season_end') {
        if (!isSuperAdmin(msg.author.id)) return;
        const res = await season.runRollover(client, { force: true });
        if (!res.rolled) return msg.reply(`Không chốt mùa được (lý do: ${res.reason}).`);
        return msg.reply(`✅ Đã chốt **Mùa ${res.endingId}** → bắt đầu **Mùa ${res.newId}**. Danh hiệu/huy hiệu đã trao, thông báo đã gửi (nếu có cài kênh).`);
    }

    if (cmd === '!season_setchannel') {
        if (!isSuperAdmin(msg.author.id)) return;
        const arg = parts[1];
        if (!arg) {
            const current = season.getState().announceChannel[guildId];
            return msg.reply(current
                ? `Kênh thông báo mùa giải: <#${current}>. \`!season_setchannel #channel\` đổi · \`!season_setchannel clear\` xoá.`
                : 'Chưa cài kênh. Dùng `!season_setchannel #channel`.');
        }
        if (arg.toLowerCase() === 'clear') {
            season.setAnnounceChannel(guildId, null);
            return msg.reply('✅ Đã xoá kênh thông báo mùa giải.');
        }
        const channelId = arg.replace(/[^0-9]/g, '');
        if (!channelId) return msg.reply('Vui lòng mention `#channel` hợp lệ hoặc `clear`.');
        const targetChannel = await msg.guild.channels.fetch(channelId).catch(() => null);
        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) return msg.reply('Kênh phải là text channel hợp lệ.');
        season.setAnnounceChannel(guildId, channelId);
        return msg.reply(`✅ Kênh thông báo mùa giải: <#${channelId}>.`);
    }

    if (cmd === '!season_setlength') {
        if (!isSuperAdmin(msg.author.id)) return;
        const weeks = parseInt(parts[1], 10);
        if (!Number.isInteger(weeks) || weeks <= 0) return msg.reply('Cú pháp: `!season_setlength <số tuần>` (vd `!season_setlength 8`).');
        const st = season.setLengthDays(weeks * 7);
        return msg.reply(`✅ Độ dài mùa: **${weeks} tuần** (${weeks * 7} ngày). Mùa hiện tại kết thúc <t:${Math.floor(st.endsAt / 1000)}:F>.`);
    }

    if (cmd === '!season_setend') {
        if (!isSuperAdmin(msg.author.id)) return;
        const arg = parts[1];
        if (!arg) return msg.reply('Cú pháp: `!season_setend +<số ngày>` hoặc `!season_setend <YYYY-MM-DD>`.');
        let endsAt;
        if (arg.startsWith('+')) {
            const d = parseInt(arg.slice(1), 10);
            if (!Number.isInteger(d) || d <= 0) return msg.reply('Số ngày không hợp lệ.');
            endsAt = Date.now() + d * 86400000;
        } else {
            const t = Date.parse(arg);
            if (Number.isNaN(t)) return msg.reply('Ngày không hợp lệ (dùng `YYYY-MM-DD`).');
            endsAt = t;
        }
        const st = season.setEndsAt(endsAt);
        return msg.reply(`✅ Mùa hiện tại sẽ kết thúc <t:${Math.floor(st.endsAt / 1000)}:F> (<t:${Math.floor(st.endsAt / 1000)}:R>).`);
    }

    if (cmd === '!coinflip') {
        let side = null;
        let amountStr, flipsStr;
        if (parts[1] === 'sap' || parts[1] === 'ngua') {
            side = parts[1];
            amountStr = parts[2];
            flipsStr = parts[3];
        } else {
            amountStr = parts[1];
            flipsStr = parts[2];
        }
        const syntax = `Cú pháp: \`!coinflip <số ngọc|all> [số lần]\` hoặc \`!coinflip <sap|ngua> <số ngọc|all> [số lần]\` (tối đa ${fmt(economy.COINFLIP_MAX_BET)} ngọc/lần, ${COINFLIP_MAX_FLIPS} lần).`;
        const isAll = amountStr === 'all';
        let rawAmount = null;
        if (!isAll) {
            rawAmount = parseInt(amountStr, 10);
            if (!Number.isInteger(rawAmount) || rawAmount <= 0) return msg.reply(syntax);
        }
        let flips = 1;
        if (flipsStr !== undefined) {
            flips = parseInt(flipsStr, 10);
            if (!Number.isInteger(flips) || flips < 1 || flips > COINFLIP_MAX_FLIPS) {
                return msg.reply(`Số lần tung phải là số nguyên từ 1 đến ${COINFLIP_MAX_FLIPS}.`);
            }
        }
        const cd = checkGameCooldown(msg.author.id);
        if (cd.onCooldown) {
            const secLeft = Math.ceil(cd.msLeft / 1000);
            return replyEphemeral(msg, `⏳ Vui lòng chờ ${secLeft}s trước khi chơi tiếp.`);
        }
        const res = runCoinflipMulti({
            guildId, userId: msg.author.id, displayName: member.displayName,
            side, isAll, requestedAmount: rawAmount, flips, viaButton: false, metrics
        });
        if (res.error === 'no_ngoc') return msg.reply('Bạn không có ngọc để chơi.');
        if (res.error === 'insufficient') return msg.reply(`Bạn cần ${fmt(res.needed)} ngọc nhưng chỉ có ${fmt(res.available)}.`);
        return msg.reply({ content: res.content, components: res.components });
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
        const example = isTong ? `${cmdLabel} 200 10 11` : `${cmdLabel} 200 5 6`;
        const syntax = `Cú pháp: \`${cmdLabel} <số ngọc|all> <${guessLabel}> [${guessLabel} ...]\` — cược nhiều cửa cùng lúc (mỗi cửa tối đa ${fmt(maxBet)} ngọc). VD: \`${example}\`.`;

        if (parts.length < 3) return msg.reply(syntax);
        const token1 = parts[1].toLowerCase();
        const isAll = token1 === 'all' || token1 === 'allin';
        let rawAmount = null;
        if (!isAll) {
            rawAmount = parseInt(token1, 10);
            if (!Number.isInteger(rawAmount) || rawAmount <= 0) return msg.reply(syntax);
        }

        // Parse one or more guesses; all must be unique integers in range.
        const guesses = [];
        for (const t of parts.slice(2)) {
            const g = parseInt(t, 10);
            if (!Number.isInteger(g) || g < guessMin || g > guessMax) {
                return msg.reply(`${isTong ? 'Tổng' : 'Mặt'} phải là số nguyên từ ${guessMin} đến ${guessMax}.`);
            }
            guesses.push(g);
        }
        if (new Set(guesses).size !== guesses.length) {
            return msg.reply(`Các ${isTong ? 'tổng' : 'mặt'} cược phải khác nhau (không trùng).`);
        }
        const nBets = guesses.length;

        const cd = checkGameCooldown(msg.author.id);
        if (cd.onCooldown) {
            const secLeft = Math.ceil(cd.msLeft / 1000);
            return replyEphemeral(msg, `⏳ Vui lòng chờ ${secLeft}s trước khi chơi tiếp.`);
        }

        const w = getWallet(guildId, msg.author.id);
        const totalNgocDice = w.ngoc + w.lockedNgoc;
        let amountPer;
        if (isAll) {
            // Distribute the wallet across the chosen cửa, capped per cửa.
            amountPer = Math.min(Math.floor(totalNgocDice / nBets), maxBet);
            if (amountPer <= 0) return msg.reply('Bạn không có đủ ngọc để chơi.');
        } else {
            amountPer = Math.min(rawAmount, maxBet);
            if (totalNgocDice < amountPer * nBets) {
                return msg.reply(`Bạn cần ${fmt(amountPer * nBets)} ngọc (${fmt(amountPer)} × ${nBets} cửa) nhưng chỉ có ${fmt(totalNgocDice)}.`);
            }
        }
        const totalCost = amountPer * nBets;

        const roll = dice.rollDice();
        const play = isTong
            ? dice.playTongMulti(roll, guesses, amountPer)
            : dice.playMatMulti(roll, guesses, amountPer);

        spendNgocForGame(guildId, msg.author.id, totalCost);
        if (play.totalPayout > 0) {
            addNgoc(guildId, msg.author.id, play.totalPayout);
            profile.recordWin(guildId, msg.author.id, play.totalPayout, isTong ? 'Tổng xúc xắc' : 'Mặt xúc xắc');
        }
        profile.recordGame(guildId, msg.author.id, game, totalCost, play.totalPayout);
        const newW = getWallet(guildId, msg.author.id);

        // One metrics record per cửa — each is a bet of amountPer.
        for (const r of play.results) {
            if (isTong) {
                metrics.recordTong({ guildId, amount: amountPer, won: r.won, mult: r.mult, guess: r.guess, viaButton: false, wasAllIn: isAll, userId: msg.author.id });
            } else {
                metrics.recordMat({ guildId, amount: amountPer, won: r.won, mult: r.mult, face: r.face, matches: r.matches, viaButton: false, wasAllIn: isAll, userId: msg.author.id });
            }
        }

        const totalNgocAfterDice = newW.ngoc + newW.lockedNgoc;

        // Single cửa → keep the familiar result + interactive replay buttons.
        if (nBets === 1) {
            const g = guesses[0];
            const r = play.results[0];
            const content = isTong
                ? dice.formatTongResult({ displayName: member.displayName, guess: g, roll, sum: play.sum, won: r.won, amount: amountPer, mult: r.mult })
                : dice.formatMatResult({ displayName: member.displayName, face: g, roll, matches: r.matches, won: r.won, amount: amountPer, mult: r.mult });
            const buildBtns = isTong ? dice.buildTongButtons : dice.buildMatButtons;
            const components = totalNgocAfterDice > 0 ? buildBtns(msg.author.id, amountPer, g, totalNgocAfterDice) : [];
            return msg.reply({ content, components });
        }

        // Multi cửa → rich aggregate result + multi-cửa replay buttons.
        const content = isTong
            ? dice.formatTongResultMulti({ displayName: member.displayName, roll, sum: play.sum, results: play.results, amountPer, totalCost, totalPayout: play.totalPayout })
            : dice.formatMatResultMulti({ displayName: member.displayName, roll, results: play.results, amountPer, totalCost, totalPayout: play.totalPayout });
        const buildMulti = isTong ? dice.buildTongButtonsMulti : dice.buildMatButtonsMulti;
        const components = totalNgocAfterDice > 0 ? buildMulti(msg.author.id, amountPer, guesses, totalNgocAfterDice) : [];
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

    if (cmd === '!flashmath' || cmd === '!flash') {
        if (msg.channel.type !== ChannelType.GuildText) {
            return msg.reply('Lệnh này chỉ dùng trong text channel (không trong thread hoặc DM).');
        }
        try {
            const thread = await flashMath.startSession({ channel: msg.channel, invokerId: msg.author.id });
            return msg.reply(`Đã tạo thread Flash Math: <#${thread.id}>`);
        } catch (e) {
            log.error('flashmath start failed', e);
            return msg.reply('Không thể bắt đầu trò chơi.');
        }
    }

    if (cmd === '!flashmath_top' || cmd === '!flash_top') {
        const mode = (parts[1] || '').toLowerCase();
        const isLifetime = mode === 'lifetime' || mode === 'life' || mode === 'all' || mode === 'l';
        const top = isLifetime
            ? flashMath.getLifetimeTop(guildId, 10)
            : flashMath.getWeeklyTop(guildId, 10);
        const header = isLifetime
            ? `🏆 **Top Flash Math — Lifetime** (cấp cao nhất)`
            : `🏆 **Top Flash Math — Tuần này** (cấp cao nhất)`;
        const lines = [header];
        if (top.length === 0) {
            lines.push('_Chưa có ai trên bảng xếp hạng._');
        } else {
            for (let i = 0; i < top.length; i++) {
                const [userId, v] = top[i];
                let name = userId;
                try { const m = await msg.guild.members.fetch(userId).catch(() => null); if (m) name = m.displayName; } catch (e) { /* ignore */ }
                lines.push(`${i + 1}. **${name}** — Cấp **${v.level || 0}**`);
            }
        }
        if (!isLifetime) {
            const table = flashMath.getWeeklyRewardTable();
            if (table && table.length > 0) {
                lines.push('');
                lines.push(`🎁 **Thưởng tuần (reset Thứ Hai 00:00 GMT+7)**`);
                for (const tier of table) {
                    const range = tier.from === tier.to ? `Top ${tier.from}` : `Top ${tier.from}-${tier.to}`;
                    lines.push(`• ${range}: **${fmt(tier.ngoc)}** ${renderEmote('ngoc')}`);
                }
                lines.push(`Gõ \`!flashmath_top lifetime\` để xem bảng all-time.`);
            }
        }
        return msg.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
    }

    if (cmd === '!flashmath_payout') {
        if (!isSuperAdmin(msg.author.id)) return;
        try {
            const results = await flashMath.runWeeklyPayout();
            if (!results || results.length === 0) {
                return msg.reply('Không có ai để trả thưởng (hoặc tuần trước đã trả rồi).');
            }
            const totalWinners = results.reduce((a, r) => a + r.paid.length, 0);
            return msg.reply(`✅ Flash Math: đã trả thưởng tuần trước cho ${totalWinners} người trong ${results.length} guild.`);
        } catch (e) {
            log.error('flashmath_payout error', e);
            return msg.reply('Lỗi khi trả thưởng. Xem log.');
        }
    }

    if (cmd === '!flashmath_cap') {
        const status = flashMath.getCapStatus(guildId, msg.author.id);
        return msg.reply(`📊 **Cap Flash Math hôm nay:** **${fmt(status.earned)}** / **${fmt(status.cap)}** ${renderEmote('ngoc')}`);
    }

    if (cmd === '!boss') {
        if (msg.channel.type !== ChannelType.GuildText) {
            return msg.reply('Lệnh này chỉ dùng trong text channel (không trong thread hoặc DM).');
        }
        const arg = (parts[1] || '').toLowerCase();
        let tier = null;
        if (arg === 'small' || arg === 'nho' || arg === 'nhỏ' || arg === 's') tier = 'small';
        else if (arg === 'medium' || arg === 'vua' || arg === 'vừa' || arg === 'm') tier = 'medium';
        else if (arg === 'big' || arg === 'lon' || arg === 'lớn' || arg === 'b') tier = 'big';
        if (!tier) {
            return msg.reply('Cú pháp: `!boss <small|medium|big>` — triệu hồi boss toán học để cả nhóm (hoặc solo) đánh.');
        }
        const chk = mathBoss.checkSummon(guildId, msg.author.id, tier);
        if (!chk.ok) {
            return msg.reply(`Bạn đã triệu hồi đủ **${mathBoss.TIERS[tier].label}** hôm nay (${chk.used}/${chk.cap}). Thử lại vào ngày mai.`);
        }
        try {
            const thread = await mathBoss.startSession({ channel: msg.channel, invokerId: msg.author.id, invokerName: member.displayName, tier });
            mathBoss.consumeSummon(guildId, msg.author.id, tier);
            return msg.reply(`Đã triệu hồi ${mathBoss.TIERS[tier].label}: <#${thread.id}>`);
        } catch (e) {
            log.error('boss start failed', e);
            return msg.reply('Không thể bắt đầu raid.');
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

    if (cmd === '!vtv_fixscore') {
        if (!isSuperAdmin(msg.author.id)) return;
        const mention = parts[1];
        const deltaStr = parts[2];
        const usage = 'Cú pháp: `!vtv_fixscore @user <delta>` — delta là số nguyên có dấu (+ cộng, - trừ) vào điểm lifetime Vua Tiếng Việt.';
        if (!mention || deltaStr === undefined) return msg.reply(usage);
        const targetId = mention.replace(/[^0-9]/g, '');
        if (!targetId) return msg.reply('Vui lòng mention user hợp lệ.');
        const delta = parseInt(deltaStr, 10);
        if (!Number.isInteger(delta) || delta === 0) return msg.reply('Delta phải là số nguyên khác 0 (vd `+5000` hoặc `-3000`).');
        const targetMember = await msg.guild.members.fetch(targetId).catch(() => null);
        const name = targetMember ? targetMember.displayName : targetId;
        try {
            const res = vuaTiengViet.adminAdjustLifetime(guildId, targetId, delta);
            const sign = res.applied >= 0 ? '+' : '';
            return msg.reply(`✅ ${name}: **${fmt(res.before)}** → **${fmt(res.after)}** ${renderEmote('ngoc')} (${sign}${fmt(res.applied)}).`);
        } catch (e) {
            return msg.reply(`Lỗi: ${e.message}`);
        }
    }

    // !upload_ingame_emotes [force] — idempotent: dedups same-name copies
    // (Discord shows them as :ig_x~1:), reuses the survivor, uploads only
    // missing emotes. `force` re-uploads everything (art updates). Progress is
    // live-edited into the reply + logged per emote, and failures are reported
    // chunked (a single >2000-char reply used to fail silently).
    if (cmd === '!upload_ingame_emotes') {
        if (!isSuperAdmin(msg.author.id)) return;
        if (msg.guildId !== EMOTE_GUILD_ID) {
            return msg.reply(`Lệnh này phải chạy trong emote guild. Current = ${msg.guildId}`);
        }
        const force = (parts[1] || '').toLowerCase() === 'force';
        const ids = data.ingameEmoteIds || {};
        const failures = [];
        const GIF_EMOTES = new Set(['shake_tt', 'slotanim']);
        const EMOJI_MAX_BYTES = 256 * 1024; // Discord hard limit per emoji
        // Fresh fetch — the old code trusted the (possibly stale) cache, missed
        // the existing emoji and re-created it, which is how duplicates piled up.
        const allEmojis = await msg.guild.emojis.fetch().catch(() => msg.guild.emojis.cache);
        const slotLimit = [50, 100, 150, 250][msg.guild.premiumTier] || 50; // per kind (static/animated)
        const staticUsed = allEmojis.filter(e => !e.animated).size;
        const animUsed = allEmojis.filter(e => e.animated).size;

        const status = await msg.reply(
            `⏳ Upload ${INGAME_EMOTE_NAMES.length} emote (force=${force ? 'có' : 'không'})… ` +
            `Slot guild: ${staticUsed}/${slotLimit} tĩnh, ${animUsed}/${slotLimit} động.`);
        const progress = [];
        let lastEdit = 0;
        const report = async (line, { final = false, flush = false } = {}) => {
            if (line) { progress.push(line); log.info(`upload_ingame_emotes: ${line}`); }
            const now = Date.now();
            if (!final && !flush && now - lastEdit < 1500) return; // throttle edits
            lastEdit = now;
            const head = final ? `✅ Xong (force=${force ? 'có' : 'không'}).` : '⏳ Đang upload…';
            const tail = progress.slice(-18).join('\n');
            await status.edit(`${head}\n\`\`\`\n${tail}\n\`\`\``.slice(0, 1990)).catch(() => {});
        };

        // Discord has a hidden, very aggressive rate limit on emoji create —
        // @discordjs/rest WAITS it out silently (looks like a hang). Surface it
        // via the rateLimited event and time out requests stuck in that queue.
        const EMOJI_REQ_TIMEOUT_MS = 45000;
        let rateLimitInfo = null;
        const onRateLimited = (info) => {
            rateLimitInfo = info;
            const waitS = Math.ceil((info.timeToReset || 0) / 1000);
            log.warn(`upload_ingame_emotes: rate limited on ${info.method} ${info.route} — wait ${waitS}s (global=${!!info.global})`);
            report(`⏳ Discord rate-limit: phải chờ ${waitS}s (${info.method} ${info.route})`, { flush: true }).catch(() => {});
        };
        msg.client.rest.on('rateLimited', onRateLimited);
        const withTimeout = (promise, what) => Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(
                () => reject(new Error(`timeout sau ${EMOJI_REQ_TIMEOUT_MS / 1000}s (kẹt rate limit?): ${what}`)),
                EMOJI_REQ_TIMEOUT_MS).unref())
        ]);

        let created = 0, reused = 0, deduped = 0, aborted = false;
        try {
        for (const name of INGAME_EMOTE_NAMES) {
            const emoteName = `ig_${name}`;
            // All copies sharing this name; keep the one our stored id points at
            // (messages already reference it), else the newest. Delete the rest.
            const matches = [...allEmojis.filter(e => e.name === emoteName).values()]
                .sort((a, b) =>
                    (b.id === ids[name] ? 1 : 0) - (a.id === ids[name] ? 1 : 0)
                    || (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
            const survivor = matches[0] || null;
            for (const dupe of matches.slice(1)) {
                await withTimeout(dupe.delete('Dedup ingame emote'), `xoá trùng ${emoteName}`).catch(() => {});
                deduped++;
                await report(`~ ${emoteName}: xoá bản trùng (${dupe.id})`);
            }

            const ext = GIF_EMOTES.has(name) ? 'gif' : 'png';
            const filePath = path.resolve(`emotes/ingame/${name}.${ext}`);
            if (!fs.existsSync(filePath)) {
                if (survivor) { ids[name] = survivor.id; reused++; await report(`= ${emoteName}: thiếu file, giữ emote cũ`); }
                else { failures.push(`${name}: thiếu file ${name}.${ext}`); await report(`✖ ${emoteName}: thiếu file`); }
                continue;
            }
            const sizeKB = (fs.statSync(filePath).size / 1024).toFixed(1);
            if (fs.statSync(filePath).size > EMOJI_MAX_BYTES) {
                failures.push(`${name}: file ${sizeKB}KB > 256KB (Discord từ chối)`);
                await report(`✖ ${emoteName}: ${sizeKB}KB > 256KB`);
                continue;
            }
            if (survivor && !force) {
                ids[name] = survivor.id;
                reused++;
                await report(`= ${emoteName}: giữ nguyên`);
                continue;
            }
            // Create FIRST, delete the old copy after — if create fails we keep
            // the working emote instead of losing it. Duplicate names are legal.
            // Exception: at the slot cap create fails (code 30008) → free the
            // old slot and retry once.
            try {
                const buffer = fs.readFileSync(filePath);
                await report(`… ${emoteName}: đang upload (${sizeKB}KB)`, { flush: true });
                let emoji;
                try {
                    emoji = await withTimeout(
                        msg.guild.emojis.create({ attachment: buffer, name: emoteName }),
                        `upload ${emoteName}`);
                } catch (e) {
                    const capHit = e.code === 30008 || /maximum number of emojis/i.test(e.message || '');
                    if (!capHit || !survivor) throw e;
                    await withTimeout(survivor.delete('Free slot to recreate ingame emote'), `xoá ${emoteName}`).catch(() => {});
                    await report(`~ ${emoteName}: hết slot, xoá emote cũ rồi thử lại`);
                    emoji = await withTimeout(
                        msg.guild.emojis.create({ attachment: buffer, name: emoteName }),
                        `upload lại ${emoteName}`);
                }
                if (survivor && emoji.id !== survivor.id) await survivor.delete('Replaced by re-upload').catch(() => {});
                ids[name] = emoji.id;
                created++;
                await report(`+ ${emoteName}: upload OK (${sizeKB}KB, id ${emoji.id})`);
            } catch (e) {
                const detail = (e.rawError ? JSON.stringify(e.rawError) : (e.message || String(e))).slice(0, 200);
                log.error(`upload_ingame_emotes error for ${name}`, e);
                failures.push(`${name} (${sizeKB}KB): ${detail}`);
                await report(`✖ ${emoteName}: ${detail.slice(0, 120)}`);
                // A timeout means we're stuck in Discord's hidden emoji-create
                // rate limit — every further create would queue behind the same
                // wall, so stop here instead of "hanging" through the rest.
                if (/^timeout/.test(e.message || '')) {
                    aborted = true;
                    const waitS = rateLimitInfo ? Math.ceil((rateLimitInfo.timeToReset || 0) / 1000) : null;
                    failures.push(`→ Dừng: Discord rate-limit tạo emoji${waitS ? `, thử lại sau ~${waitS}s` : ', thử lại sau ít phút/giờ'}.`);
                    break;
                }
            }
        }
        } finally {
            msg.client.rest.off('rateLimited', onRateLimited);
        }
        data.ingameEmoteIds = ids;
        saveData();
        await report(null, { final: true });

        let summary = `Emote ingame: **${created}** upload mới, **${reused}** giữ nguyên, **${deduped}** bản trùng đã xoá, **${failures.length}** lỗi (${Object.keys(ids).length}/${INGAME_EMOTE_NAMES.length} có id).`;
        if (aborted) summary = `⚠️ **Dừng giữa chừng vì rate limit.** ${summary}\nEmote chưa upload sẽ được xử lý khi chạy lại lệnh (không cần \`force\`).`;
        if (!force && !aborted && created === 0 && deduped === 0 && failures.length === 0) summary += ' Dùng `!upload_ingame_emotes force` nếu muốn upload lại toàn bộ.';
        if (failures.length) summary += `\nLỗi:\n\`\`\`\n${failures.join('\n')}\n\`\`\``;
        return replyChunked(msg, summary);
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
