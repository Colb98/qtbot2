#!/usr/bin/env node
// Export player wallet/economy data to CSV.
// Usage: node scripts/export-wallets.js [guildId] [--format csv|json]
//
// Output columns: guildId, userId, ngoc, lockedNgoc, totalNgoc,
//   nganphieu, + one column per item key (non-locked then locked).

const fs = require('fs');
const path = require('path');

const ITEM_KEYS = ['nhuom', 'dieu', 'cao', 'cao5', 'cao9', 'kythuong', 'thienthuong', 'phuonghoang1', 'phuonghoang2', 'thantrang'];

const args = process.argv.slice(2);
const DATA_PATH = args.find(a => a.endsWith('.json')) || path.resolve(__dirname, '..', 'data.json');
const filterGuild = args.find(a => !a.startsWith('--') && !a.endsWith('.json'));
const formatArg = args.find(a => a.startsWith('--format='))?.split('=')[1]
    || (args.indexOf('--format') !== -1 ? args[args.indexOf('--format') + 1] : null)
    || 'csv';

if (!['csv', 'json'].includes(formatArg)) {
    console.error('--format must be csv or json');
    process.exit(1);
}

if (!fs.existsSync(DATA_PATH)) {
    console.error(`data.json not found at ${DATA_PATH}`);
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const wallets = data.wallet || {};

const rows = [];

for (const [guildId, guild] of Object.entries(wallets)) {
    if (filterGuild && guildId !== filterGuild) continue;
    for (const [userId, w] of Object.entries(guild)) {
        const items = w.items || {};
        const lockedItems = w.lockedItems || {};
        const row = {
            guildId,
            userId,
            ngoc: w.ngoc || 0,
            lockedNgoc: w.lockedNgoc || 0,
            totalNgoc: (w.ngoc || 0) + (w.lockedNgoc || 0),
            nganphieu: w.nganphieu || 0,
        };
        for (const k of ITEM_KEYS) {
            row[k] = items[k] || 0;
            row[`locked_${k}`] = lockedItems[k] || 0;
            row[`total_${k}`] = (items[k] || 0) + (lockedItems[k] || 0);
        }
        row.pity_kt = w.pity?.kt || 0;
        row.pity_tt = w.pity?.tt || 0;
        rows.push(row);
    }
}

if (rows.length === 0) {
    console.error('No wallet data found' + (filterGuild ? ` for guild ${filterGuild}` : '') + '.');
    process.exit(1);
}

if (formatArg === 'json') {
    console.log(JSON.stringify(rows, null, 2));
} else {
    // CSV
    const headers = Object.keys(rows[0]);
    const escape = v => (typeof v === 'string' && (v.includes(',') || v.includes('"')))
        ? `"${v.replace(/"/g, '""')}"` : String(v);
    console.log(headers.join(','));
    for (const row of rows) {
        console.log(headers.map(h => escape(row[h])).join(','));
    }
}
