const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const giftcode = require('../services/giftcode');

const MAX_CODES = 10;

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

async function redeemAll(role, codes) {
    const lines = [];
    for (const code of codes) {
        try {
            const res = await giftcode.redeem(role, code);
            lines.push(res.ok ? `✅ \`${code}\` — nhập thành công` : `❌ \`${code}\` — ${res.message}`);
        } catch (e) {
            lines.push(`⚠️ \`${code}\` — không gọi được trang giftcode (${e.message})`);
        }
    }
    return lines;
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
            await interaction.reply({
                content: removed ? 'Đã xoá nhân vật đã lưu.' : 'Bạn chưa lưu nhân vật nào.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
        out.push(`Nhập mã cho ${describeRole(role)}:`, ...(await redeemAll(role, codes)));
        await interaction.editReply(out.join('\n'));
    }
};
