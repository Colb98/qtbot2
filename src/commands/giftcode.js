const { SlashCommandBuilder } = require('discord.js');
const giftcode = require('../services/giftcode');
const { addNgoc, fmt, renderEmote } = require('../services/currency');
const economy = require('../config/economy');

const MAX_CODES = 10;
// Pause between redeems while sharing a code, so a fan-out to every saved
// character doesn't hammer the giftcode API.
const SHARE_DELAY_MS = 500;
const MENTIONS_PER_MESSAGE = 50;
const NO_PINGS = { parse: [] };

// Fan-outs run one at a time across all users for the same reason.
let shareQueue = Promise.resolve();

function enqueueShare(fn) {
    const run = shareQueue.then(fn);
    shareQueue = run.catch(() => {});
    return run;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function roleKey(r) {
    return `${r.serverId}:${r.roleId}`;
}

function codeList(codes) {
    return codes.map(c => `\`${c}\``).join(', ');
}

function describeRole(r) {
    return `**${r.roleName || '(không tên)'}** — ID \`${r.roleId}\`, server ${r.serverName || r.serverId}${r.level ? `, cấp ${r.level}` : ''}`;
}

function parseCodes(raw) {
    return [...new Set(raw.split(/[\s,;]+/).map(c => c.trim()).filter(Boolean))];
}

async function matchServer(input) {
    const servers = await giftcode.listServers();
    const lower = input.trim().toLowerCase();
    const found = servers.find(s => s.serverId === lower || s.serverName.toLowerCase() === lower);
    return { found, servers };
}

async function linkRole(interaction, roleId, serverInput) {
    let serverId;
    if (serverInput) {
        const { found, servers } = await matchServer(serverInput);
        if (!found) {
            return { error: `Không có server "${serverInput}". Các server hiện có: ${servers.map(s => s.serverName).join(', ')}` };
        }
        serverId = found.serverId;
    }
    const { roles, message } = await giftcode.findRoles(roleId, serverId);
    if (!roles.length) {
        return { error: `Không tìm thấy nhân vật ID \`${roleId}\`${message ? ` (${message})` : ''}. Kiểm tra lại ID trong game nhé.` };
    }
    if (roles.length > 1) {
        return {
            error: 'ID này có nhân vật ở nhiều server, chọn lại kèm `server`:\n' +
                roles.map(r => `• ${describeRole(r)}`).join('\n')
        };
    }
    giftcode.saveRole(interaction.user.id, roles[0]);
    return { role: roles[0] };
}

// Redeems for the caller only. A code the caller is first to redeem (in a
// server) is claimed for sharing; later redeemers of it get no share.
async function redeemOwn(userId, role, codes, canShare) {
    const lines = [];
    const shared = [];
    for (const code of codes) {
        let res;
        try {
            res = await giftcode.redeem(role, code);
        } catch (e) {
            lines.push(`⚠️ \`${code}\` — không gọi được trang giftcode (${e.message})`);
            continue;
        }
        const claim = giftcode.getClaim(code);
        const note = claim && claim.by !== userId ? ` (<@${claim.by}> đã nhập hộ mọi người mã này rồi, không có thưởng)` : '';
        if (!res.ok) {
            lines.push(`❌ \`${code}\` — ${res.message}${note}`);
            continue;
        }
        lines.push(`✅ \`${code}\` — nhập thành công${note}`);
        if (canShare && giftcode.tryClaim(code, userId)) shared.push(code);
    }
    return { lines, shared };
}

// Redeems the codes for every other saved character. Returns the Discord IDs
// that got at least one code and the number of successful redeems.
async function shareCodes(userId, ownRole, codes) {
    const seen = new Set([roleKey(ownRole)]);
    const targets = [];
    for (const [discordId, role] of giftcode.listRoles()) {
        if (discordId === userId || seen.has(roleKey(role))) continue;
        seen.add(roleKey(role));
        targets.push([discordId, role]);
    }

    const recipients = new Set();
    let total = 0;
    for (const code of codes) {
        let count = 0;
        for (const [discordId, role] of targets) {
            await sleep(SHARE_DELAY_MS);
            try {
                const res = await giftcode.redeem(role, code);
                if (res.ok) {
                    count++;
                    recipients.add(discordId);
                }
            } catch {
                // API hiccup for this character; skip it.
            }
        }
        giftcode.setClaimCount(code, count);
        total += count;
    }
    return { recipients: [...recipients], total };
}

// Mentions only ping on a new message, not an edit, so tag in follow-ups.
async function announceShare(interaction, recipients, codes) {
    for (let i = 0; i < recipients.length; i += MENTIONS_PER_MESSAGE) {
        const chunk = recipients.slice(i, i + MENTIONS_PER_MESSAGE);
        const tags = chunk.map(id => `<@${id}>`).join(' ');
        const payload = {
            content: i === 0 ? `📢 <@${interaction.user.id}> vừa nhập hộ ${codeList(codes)} cho:\n${tags}` : tags,
            allowedMentions: { users: chunk }
        };
        try {
            await interaction.followUp(payload);
        } catch {
            // Interaction token expired on a long fan-out; post directly.
            await interaction.channel?.send(payload).catch(() => {});
        }
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('giftcode')
        .setDescription('Nhập giftcode Nghịch Thủy Hàn giùm bạn')
        .addStringOption(o =>
            o.setName('code').setDescription('Mã cần nhập (nhiều mã cách nhau bằng dấu cách hoặc dấu phẩy)').setRequired(false)
        )
        .addStringOption(o =>
            o.setName('id').setDescription('ID nhân vật (chỉ cần nhập lần đầu hoặc khi đổi nhân vật)').setRequired(false)
        )
        .addStringOption(o =>
            o.setName('server').setDescription('Tên server, chỉ cần khi ID có ở nhiều server').setRequired(false)
        )
        .addBooleanOption(o =>
            o.setName('xoa').setDescription('Xoá nhân vật đã lưu').setRequired(false)
        ),
    async execute(interaction) {
        const rawCode = interaction.options.getString('code');
        const roleId = interaction.options.getString('id')?.trim();
        const serverInput = interaction.options.getString('server');
        const remove = interaction.options.getBoolean('xoa');

        if (remove) {
            const removed = giftcode.removeRole(interaction.user.id);
            await interaction.reply(removed ? 'Đã xoá nhân vật đã lưu.' : 'Bạn chưa lưu nhân vật nào.');
            return;
        }

        await interaction.deferReply();
        const out = [];
        let role = giftcode.getRole(interaction.user.id);

        try {
            if (roleId) {
                const linked = await linkRole(interaction, roleId, serverInput);
                if (linked.error) {
                    await interaction.editReply(linked.error);
                    return;
                }
                role = linked.role;
                out.push(`Đã lưu nhân vật: ${describeRole(role)}`);
            }
        } catch (e) {
            await interaction.editReply(`Không gọi được trang giftcode (${e.message}). Thử lại sau nhé.`);
            return;
        }

        if (!rawCode) {
            if (!out.length) {
                out.push(role
                    ? `Nhân vật đang lưu: ${describeRole(role)}\nDùng \`/giftcode code:<mã>\` để nhập mã.`
                    : 'Bạn chưa lưu nhân vật. Dùng `/giftcode id:<ID nhân vật>` trước, sau đó chỉ cần `/giftcode code:<mã>`.');
            }
            await interaction.editReply(out.join('\n'));
            return;
        }

        if (!role) {
            await interaction.editReply('Bạn chưa lưu nhân vật. Dùng `/giftcode id:<ID nhân vật> code:<mã>` cho lần đầu nhé.');
            return;
        }

        const codes = parseCodes(rawCode);
        if (codes.length > MAX_CODES) {
            await interaction.editReply(`Tối đa ${MAX_CODES} mã mỗi lần.`);
            return;
        }
        const userId = interaction.user.id;
        const { lines, shared } = await redeemOwn(userId, role, codes, !!interaction.guildId);
        out.push(`Nhập mã cho ${describeRole(role)}:`, ...lines);
        if (!shared.length) {
            await interaction.editReply({ content: out.join('\n'), allowedMentions: NO_PINGS });
            return;
        }

        await interaction.editReply({
            content: [...out, `⏳ Đang nhập hộ ${codeList(shared)} cho mọi người đã lưu nhân vật...`].join('\n'),
            allowedMentions: NO_PINGS
        });
        const { recipients, total } = await enqueueShare(() => shareCodes(userId, role, shared));
        const reward = total * economy.GIFTCODE_SHARE_REWARD;
        if (reward > 0) addNgoc(interaction.guildId, userId, reward);
        out.push(total
            ? `🎁 Đã nhập hộ cho **${recipients.length}** người${shared.length > 1 ? ` (${total} lượt)` : ''} — bạn được thưởng **${fmt(reward)}** ${renderEmote('ngoc')}`
            : '🎁 Không nhập hộ được cho ai (mọi người đều đã có mã này).');
        // A long fan-out can outlive the 15-minute interaction token.
        await interaction.editReply({ content: out.join('\n'), allowedMentions: NO_PINGS }).catch(() => {});
        if (recipients.length) await announceShare(interaction, recipients, shared);
    }
};
