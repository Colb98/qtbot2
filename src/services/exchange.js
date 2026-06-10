// Unified premium-item exchange & dismantle (!doi / !phangiai).
//
// The catalog spans ALL seasons up to the current one: current-season items
// behave exactly as the old per-item commands did; past-season items remain
// exchangeable/dismantlable forever so collectors can still complete old sets.
// Old items score 0 on the leaderboard by construction — scoring only reads
// current-season keys — so this does NOT reopen the "park score in pets"
// loophole; converting old pets back to TT goes through the dismantle penalty.
//
// Recipes/values always use the item's OWN season ratios via
// season.exchangeRatio(name, seasonId) (Season 1 omits ratios → economy.js
// defaults, still admin-editable), and are computed lazily on every call so
// runtime ratio overrides apply immediately.
//
// Dismantle (pet tiers only): yields the pet's full TT value per unit; when the
// UNIT value is >= PENALTY_MIN_VALUE TT the player picks one of two penalties
// (confirm buttons):
//   • TT route   — receive total − ceil(10% × total)
//   • Ngọc route — receive the full total, pay ceil(20% × total × ngọc-per-TT)
// where ngọc-per-TT = ROLLS_PER_THIENTHUONG × GACHA.ROLL_COST (the
// !banthienthuong sell rate, 5 000 ngọc by default).
const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
    MessageFlags
} = require('discord.js');
const log = require('../../logger');
const { saveData } = require('../state');
const { getWallet, ITEM_LABELS, fmt, renderEmote } = require('./currency');
const economy = require('../config/economy');
const cfg = require('../config/season');
const season = require('./season');

const PENALTY_MIN_VALUE = 9;     // unit TT value at/above which dismantle is penalized
const PENALTY_TT_RATE = 0.1;     // TT route: lose ceil(10% of the total yield)
const PENALTY_NGOC_RATE = 0.2;   // ngọc route: pay 20% of the total value in ngọc
const DISMANTLE_TIERS = new Set(['pet1', 'pet2', 'pet3']);
const QTY_CHOICES = [1, 2, 3, 'all'];

function ngocPerTT() { return economy.ROLLS_PER_THIENTHUONG * economy.GACHA.ROLL_COST; }

// ── Catalog ─────────────────────────────────────────────────────────────────
// One entry per premium item of every season <= current, current season first
// (then newest→oldest). { key, tier, seasonId, label, current, cost, value,
// dismantlable } where cost = { tt?: n, items?: { srcKey: qty } }.
function catalog() {
    const curId = season.getCurrentSeasonId();
    const ids = cfg.SEASON_IDS.filter(id => id <= curId)
        .sort((a, b) => (b === curId) - (a === curId) || b - a);
    const out = [];
    for (const id of ids) {
        const s = cfg.getSeason(id);
        for (const tier of cfg.seasonTiers(id)) {
            const key = s.items[tier];
            const r = (name) => season.exchangeRatio(name, id);
            let cost;
            switch (tier) {
                case 'pet1':        cost = { tt: r('ttPerPet1') }; break;
                case 'pet2':        cost = { items: { [s.items.pet1]: r('pet1PerPet2') } }; break;
                case 'pet3':        cost = { items: { [s.items.pet2]: r('pet2PerPet3') } }; break;
                case 'thanthu':     cost = { tt: r('ttPerThanthu') }; break;
                case 'thanthuplus': cost = { tt: r('ttPerThanthuplus'), items: { [s.items.thanthu]: 1 } }; break;
                case 'thantrang':   cost = { tt: r('ttPerThantrang') }; break;
                default: continue;
            }
            out.push({
                key, tier, seasonId: id,
                label: ITEM_LABELS[key] || key,
                current: id === curId,
                cost,
                value: season.tierMult(tier, id),
                dismantlable: DISMANTLE_TIERS.has(tier)
            });
        }
    }
    return out;
}

function findByKey(key) {
    return catalog().find(e => e.key === key) || null;
}

// ── Alias resolution ────────────────────────────────────────────────────────
// Accepts the raw wallet key, the diacritics-stripped label (spaces removed),
// and the legacy command names. E.g. cao / cao5duoi / "Sói Tinh Hà"→soitinhha /
// phuongbang→phuonghoang1.
const LEGACY_ALIASES = {
    phuonghoang1: ['phuongbang'],
    phuonghoang2: ['phuonghoa']
};

function norm(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'D')
        .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveAlias(input) {
    const want = norm(input);
    if (!want) return null;
    for (const entry of catalog()) {
        const aliases = [entry.key, entry.label, ...(LEGACY_ALIASES[entry.key] || [])];
        if (aliases.some(a => norm(a) === want)) return entry;
    }
    return null;
}

// "3 Thiên Thưởng" / "3 Cáo" / "1 Phượng Băng + 200 Thiên Thưởng"
function costText(entry) {
    const parts = [];
    if (entry.cost.items) {
        for (const [k, q] of Object.entries(entry.cost.items)) parts.push(`${fmt(q)} ${ITEM_LABELS[k] || k}`);
    }
    if (entry.cost.tt) parts.push(`${fmt(entry.cost.tt)} Thiên Thưởng`);
    return parts.join(' + ');
}

// Emote-rich version of costText for result messages.
function costEmotes(entry, n) {
    const parts = [];
    if (entry.cost.items) {
        for (const [k, q] of Object.entries(entry.cost.items)) parts.push(`${fmt(n * q)} ${renderEmote(k)}`);
    }
    if (entry.cost.tt) parts.push(`${fmt(n * entry.cost.tt)} ${renderEmote('thienthuong')}`);
    return parts.join(' + ');
}

// ── Exchange (!doi) ─────────────────────────────────────────────────────────
function maxAffordable(w, entry) {
    let max = Infinity;
    if (entry.cost.tt) max = Math.min(max, Math.floor((w.items.thienthuong + w.lockedItems.thienthuong) / entry.cost.tt));
    if (entry.cost.items) {
        for (const [k, q] of Object.entries(entry.cost.items)) {
            max = Math.min(max, Math.floor((w.items[k] + w.lockedItems[k]) / q));
        }
    }
    return max === Infinity ? 0 : max;
}

// Deduct `amount` of `key` from a wallet, non-locked first. Returns the
// non-locked portion actually used (callers derive the locked split from it).
function deduct(w, key, amount) {
    const nonLocked = Math.min(amount, w.items[key]);
    w.items[key] -= nonLocked;
    w.lockedItems[key] -= amount - nonLocked;
    return nonLocked;
}

// Exchange `qty` (number | 'all') of catalog item `key`. Mirrors the legacy
// per-command behavior: costs consume non-locked funds first; outputs minted
// from any locked input are locked.
function performExchange(guildId, userId, key, qty) {
    const entry = findByKey(key);
    if (!entry) return { ok: false, error: 'Vật phẩm không hợp lệ.' };
    const w = getWallet(guildId, userId);
    const max = maxAffordable(w, entry);
    const n = qty === 'all' ? max : qty;
    if (!Number.isInteger(n) || n <= 0) {
        return {
            ok: false,
            error: qty === 'all'
                ? `Không đủ nguyên liệu để đổi ${entry.label} (cần ${costText(entry)} / 1).`
                : 'Số lượng không hợp lệ.'
        };
    }
    if (n > max) return { ok: false, error: `Không đủ nguyên liệu để đổi ${fmt(n)} ${entry.label} (tối đa **${fmt(max)}** với ${costText(entry)} / 1).` };

    // Output is non-locked only insofar as EVERY cost component was paid from
    // non-locked funds (same rule the legacy commands used).
    let nonLockedOut = n;
    if (entry.cost.tt) {
        const nl = deduct(w, 'thienthuong', n * entry.cost.tt);
        nonLockedOut = Math.min(nonLockedOut, Math.floor(nl / entry.cost.tt));
    }
    if (entry.cost.items) {
        for (const [k, q] of Object.entries(entry.cost.items)) {
            const nl = deduct(w, k, n * q);
            nonLockedOut = Math.min(nonLockedOut, Math.floor(nl / q));
        }
    }
    w.items[entry.key] += nonLockedOut;
    w.lockedItems[entry.key] += n - nonLockedOut;
    saveData();
    return { ok: true, entry, n };
}

function exchangeResultText(guildId, userId, res) {
    const { entry, n } = res;
    const w = getWallet(guildId, userId);
    const owned = w.items[entry.key] + w.lockedItems[entry.key];
    const oldNote = entry.current ? '' : ` *(vật phẩm Mùa ${entry.seasonId} — không tính điểm BXH)*`;
    return `Đã đổi ${costEmotes(entry, n)} → **${fmt(n)}** ${renderEmote(entry.key)} ${entry.label}.${oldNote} Hiện có: ${fmt(owned)} ${entry.label}.`;
}

// ── Dismantle (!phangiai) ───────────────────────────────────────────────────
// Validates and prices a dismantle without mutating anything. qty: number|'all'.
function dismantleQuote(guildId, userId, key, qty) {
    const entry = findByKey(key);
    if (!entry) return { ok: false, error: 'Vật phẩm không hợp lệ.' };
    if (!entry.dismantlable) return { ok: false, error: `${entry.label} không phân giải được (chỉ linh thú).` };
    const w = getWallet(guildId, userId);
    const owned = w.items[key] + w.lockedItems[key];
    const n = qty === 'all' ? owned : qty;
    if (!Number.isInteger(n) || n <= 0) {
        return { ok: false, error: qty === 'all' ? `Bạn không có ${entry.label} để phân giải.` : 'Số lượng không hợp lệ.' };
    }
    if (n > owned) return { ok: false, error: `Bạn chỉ có ${fmt(owned)} ${entry.label}, không đủ phân giải ${fmt(n)}.` };
    const total = n * entry.value;
    const penalized = entry.value >= PENALTY_MIN_VALUE;
    return {
        ok: true, entry, n, total, penalized,
        ttPenalty: penalized ? Math.ceil(total * PENALTY_TT_RATE) : 0,
        ngocCost: penalized ? Math.ceil(total * PENALTY_NGOC_RATE * ngocPerTT()) : 0
    };
}

// Execute a dismantle. mode: 'plain' (no penalty), 'tt' (−10% TT) or 'ngoc'
// (full TT, pay ngọc). Re-validates funds — quotes can go stale between the
// confirm message and the button click.
function performDismantle(guildId, userId, key, n, mode) {
    const q = dismantleQuote(guildId, userId, key, n);
    if (!q.ok) return q;
    if (q.penalized && mode !== 'tt' && mode !== 'ngoc') return { ok: false, error: 'Phân giải này cần chọn hình thức phạt.' };
    const w = getWallet(guildId, userId);
    if (q.penalized && mode === 'ngoc' && (w.ngoc + w.lockedNgoc) < q.ngocCost) {
        return { ok: false, error: `Cần ${fmt(q.ngocCost)} ${renderEmote('ngoc')} để trả phí nhưng bạn chỉ có ${fmt(w.ngoc + w.lockedNgoc)}.` };
    }

    const nonLockedUsed = deduct(w, key, q.n);
    let nonLockedTT = nonLockedUsed * q.entry.value;
    let lockedTT = (q.n - nonLockedUsed) * q.entry.value;
    let received = q.total;
    if (q.penalized && mode === 'tt') {
        received = q.total - q.ttPenalty;
        const fromNonLocked = Math.min(q.ttPenalty, nonLockedTT);
        nonLockedTT -= fromNonLocked;
        lockedTT -= q.ttPenalty - fromNonLocked;
    } else if (q.penalized && mode === 'ngoc') {
        const nlNgoc = Math.min(q.ngocCost, w.ngoc);
        w.ngoc -= nlNgoc;
        w.lockedNgoc -= q.ngocCost - nlNgoc;
    }
    w.items.thienthuong += nonLockedTT;
    w.lockedItems.thienthuong += lockedTT;
    saveData();
    return {
        ok: true, entry: q.entry, n: q.n, mode, penalized: q.penalized,
        received, ttPenalty: q.ttPenalty, ngocCost: q.ngocCost, lockedTT
    };
}

function dismantleResultText(guildId, userId, res) {
    const { entry, n } = res;
    const w = getWallet(guildId, userId);
    const lockedNote = res.lockedTT > 0 ? ` (có ${fmt(res.lockedTT)} thiên thưởng khoá)` : '';
    let penaltyNote = '';
    if (res.penalized && res.mode === 'tt') penaltyNote = ` *(đã trừ phạt ${fmt(res.ttPenalty)} thiên thưởng)*`;
    if (res.penalized && res.mode === 'ngoc') penaltyNote = ` *(đã trừ phí ${fmt(res.ngocCost)} ${renderEmote('ngoc')})*`;
    return `Đã phân giải ${fmt(n)} ${renderEmote(entry.key)} → **${fmt(res.received)}** ${renderEmote('thienthuong')}${lockedNote}.${penaltyNote} Số dư: ${fmt(w.items.thienthuong + w.lockedItems.thienthuong)} thiên thưởng.`;
}

// ── Picker / confirm UI ─────────────────────────────────────────────────────
// customIds: doi:item:<uid> · doi:qty:<uid>:<key>:<1|2|3|all>
//            pg:item:<uid>  · pg:qty:<uid>:<key>:<1|2|3|all>
//            pg:go:<uid>:<key>:<n>:<tt|ngoc> · pg:cancel:<uid>
const DOI_HEADER = '🔁 **Đổi vật phẩm** — chọn vật phẩm rồi bấm số lượng. Vật phẩm mùa cũ vẫn đổi được nhưng **không tính điểm** BXH mùa này.';
const PG_HEADER = '⚗️ **Phân giải linh thú → thiên thưởng** — chọn linh thú rồi bấm số lượng. Linh thú giá trị **≥9 TT** chịu phạt: −10% thiên thưởng hoặc trừ 20% giá trị bằng ngọc (chọn khi xác nhận).';

function qtyRow(ns, userId, selectedKey) {
    const row = new ActionRowBuilder();
    for (const q of QTY_CHOICES) {
        row.addComponents(new ButtonBuilder()
            .setCustomId(`${ns}:qty:${userId}:${selectedKey || '-'}:${q}`)
            .setLabel(q === 'all' ? 'Tất cả' : String(q))
            .setStyle(q === 'all' ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(!selectedKey));
    }
    return row;
}

function buildDoiComponents(guildId, userId, selectedKey) {
    const opts = catalog().map(e => {
        const o = new StringSelectMenuOptionBuilder()
            .setLabel(`${e.label} — ${costText(e)}`.slice(0, 100))
            .setValue(e.key)
            .setDescription((e.current ? `Mùa ${e.seasonId} (hiện tại)` : `Mùa ${e.seasonId} — không tính điểm BXH`).slice(0, 100));
        if (e.key === selectedKey) o.setDefault(true);
        return o;
    });
    const select = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`doi:item:${userId}`)
            .setPlaceholder('Chọn vật phẩm muốn đổi')
            .addOptions(...opts.slice(0, 25))
    );
    return [select, qtyRow('doi', userId, selectedKey)];
}

function buildPhangiaiComponents(guildId, userId, selectedKey) {
    const w = getWallet(guildId, userId);
    const owned = catalog().filter(e => e.dismantlable && (w.items[e.key] + w.lockedItems[e.key]) > 0);
    if (owned.length === 0) return null;
    const opts = owned.map(e => {
        const total = w.items[e.key] + w.lockedItems[e.key];
        const o = new StringSelectMenuOptionBuilder()
            .setLabel(`${e.label} ×${fmt(total)} — ${fmt(e.value)} TT/con`.slice(0, 100))
            .setValue(e.key)
            .setDescription((e.value >= PENALTY_MIN_VALUE
                ? `Mùa ${e.seasonId} · có phạt (giá trị ≥${PENALTY_MIN_VALUE} TT)`
                : `Mùa ${e.seasonId} · không phạt`).slice(0, 100));
        if (e.key === selectedKey) o.setDefault(true);
        return o;
    });
    const select = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`pg:item:${userId}`)
            .setPlaceholder('Chọn linh thú muốn phân giải')
            .addOptions(...opts.slice(0, 25))
    );
    return [select, qtyRow('pg', userId, selectedKey)];
}

// Confirm message for a penalized dismantle (quote from dismantleQuote).
function buildPenaltyConfirm(userId, quote) {
    const { entry, n, total, ttPenalty, ngocCost } = quote;
    const content = [
        `⚠️ **Phân giải ${fmt(n)} ${renderEmote(entry.key)} ${entry.label}** (giá trị ${fmt(total)} ${renderEmote('thienthuong')}) — chọn hình thức:`,
        `• **Trừ thiên thưởng:** nhận **${fmt(total - ttPenalty)}** ${renderEmote('thienthuong')} (phạt −${fmt(ttPenalty)}).`,
        `• **Trừ ngọc:** nhận đủ **${fmt(total)}** ${renderEmote('thienthuong')}, trả phí **${fmt(ngocCost)}** ${renderEmote('ngoc')}.`
    ].join('\n');
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pg:go:${userId}:${entry.key}:${n}:tt`)
            .setLabel(`Nhận ${fmt(total - ttPenalty)} TT (−10%)`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`pg:go:${userId}:${entry.key}:${n}:ngoc`)
            .setLabel(`Nhận đủ TT, trừ ${fmt(ngocCost)} ngọc`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`pg:cancel:${userId}`)
            .setLabel('Huỷ').setStyle(ButtonStyle.Secondary)
    );
    return { content, components: [row] };
}

// ── Component interaction handler (doi:* / pg:*) ────────────────────────────
// Acknowledge with deferUpdate() FIRST (cheapest possible ack) and edit the
// message afterwards — doing the wallet work before the first response risks
// blowing Discord's 3s ack window on a busy event loop (error 10062).
async function handleComponent(interaction) {
    const [ns, action, ownerId, ...rest] = interaction.customId.split(':');
    if (interaction.user.id !== ownerId) {
        return interaction.reply({ content: 'Menu này không phải của bạn.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    const guildId = interaction.guildId;
    if (!guildId) return interaction.reply({ content: 'Chỉ dùng được trong máy chủ.', flags: MessageFlags.Ephemeral }).catch(() => {});

    try {
        await interaction.deferUpdate();
    } catch (e) {
        // Token already expired (slow gateway/event loop) — nothing we can edit.
        log.warn(`exchange: deferUpdate failed (${interaction.customId}): ${e.message}`);
        return;
    }
    const edit = (payload) => interaction.editReply(payload)
        .catch(e => log.warn(`exchange: editReply failed (${interaction.customId}): ${e.message}`));

    if (ns === 'doi') {
        if (action === 'item') {
            const key = interaction.values && interaction.values[0];
            return edit({ components: buildDoiComponents(guildId, ownerId, key) });
        }
        if (action === 'qty') {
            const [key, qtyStr] = rest;
            const qty = qtyStr === 'all' ? 'all' : parseInt(qtyStr, 10);
            const res = performExchange(guildId, ownerId, key, qty);
            const line = res.ok ? `✅ ${exchangeResultText(guildId, ownerId, res)}` : `⛔ ${res.error}`;
            return edit({
                content: `${DOI_HEADER}\n\n${line}`,
                components: buildDoiComponents(guildId, ownerId, key)
            });
        }
    }

    if (ns === 'pg') {
        if (action === 'item') {
            const key = interaction.values && interaction.values[0];
            return edit({ components: buildPhangiaiComponents(guildId, ownerId, key) || [] });
        }
        if (action === 'qty') {
            const [key, qtyStr] = rest;
            const qty = qtyStr === 'all' ? 'all' : parseInt(qtyStr, 10);
            const quote = dismantleQuote(guildId, ownerId, key, qty);
            if (!quote.ok) {
                return edit({
                    content: `${PG_HEADER}\n\n⛔ ${quote.error}`,
                    components: buildPhangiaiComponents(guildId, ownerId, key) || []
                });
            }
            if (quote.penalized) {
                return edit(buildPenaltyConfirm(ownerId, quote));
            }
            const res = performDismantle(guildId, ownerId, key, quote.n, 'plain');
            const line = res.ok ? `✅ ${dismantleResultText(guildId, ownerId, res)}` : `⛔ ${res.error}`;
            return edit({
                content: `${PG_HEADER}\n\n${line}`,
                components: buildPhangiaiComponents(guildId, ownerId, key) || []
            });
        }
        if (action === 'go') {
            const [key, nStr, mode] = rest;
            const res = performDismantle(guildId, ownerId, key, parseInt(nStr, 10), mode);
            const line = res.ok ? `✅ ${dismantleResultText(guildId, ownerId, res)}` : `⛔ ${res.error}`;
            return edit({
                content: `${PG_HEADER}\n\n${line}`,
                components: buildPhangiaiComponents(guildId, ownerId, key) || []
            });
        }
        if (action === 'cancel') {
            return edit({
                content: `${PG_HEADER}\n\n❌ Đã huỷ.`,
                components: buildPhangiaiComponents(guildId, ownerId, null) || []
            });
        }
    }

    return edit({ content: 'Hành động không hợp lệ.', components: [] });
}

module.exports = {
    PENALTY_MIN_VALUE,
    catalog,
    resolveAlias,
    costText,
    performExchange,
    exchangeResultText,
    dismantleQuote,
    performDismantle,
    dismantleResultText,
    buildDoiComponents,
    buildPhangiaiComponents,
    buildPenaltyConfirm,
    DOI_HEADER,
    PG_HEADER,
    handleComponent
};
