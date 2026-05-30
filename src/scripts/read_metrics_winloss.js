// Report + backfill: pull win/loss-per-mode + gacha figures out of the
// historical metrics buckets in /metrics/YYYY-MM-DD.json, and (optionally)
// write them into data.profile[guild][user] — the NEW achievement fields:
//   gameStats[mode].totalWon / totalLost   and   gachaStats.{rolls,cao,thienthuong,kythuong}
//
// What it prints
// ──────────────
//   • Tổng thắng / Tổng thua từng mode  (slot · coinflip · tong · mat)
//   • Số lượt gacha
//   • Gacha ra cáo / thiên thưởng (+ kỳ thưởng cho đầy đủ)
//
// Why won/lost are approximate
// ────────────────────────────
// Metrics buckets only store per-game AGGREGATES — `wagered`, `payout`,
// `wins`, `spins` — plus a per-user PLAY COUNT (`playerIds`). There is no
// per-user (or per-play) win/loss history. So we attribute the bucket
// averages to each user in proportion to their play count:
//
//   avgBet = wagered/spins · avgPayout = payout/spins · winRate = wins/spins
//   user estPayout      ≈ avgPayout × n
//   user winningBets    ≈ avgBet × winRate × n
//   user Tổng thắng     ≈ estPayout − winningBets      (lãi trên ván thắng)
//   user Tổng thua      ≈ avgBet × (1 − winRate) × n   (cược mất trên ván thua)
//
// Consistent with the exact aggregate net (Σ won − Σ lost = payout − wagered).
// Gacha rolls per user are EXACT (stored in playerIds); cáo/tt/kt per user are
// attributed by each user's share of that bucket's rolls.
//
// Idempotency / safety (mirrors import_metrics_to_gamestats.js)
// ─────────────────────────────────────────────────────────────
//   --write             apply the backfill (mutates data.json)
//   --reset             set the new fields = imported value (else additive).
//                       Recommended, so re-running doesn't double-count.
//   --include-today     include today's bucket (default skips it so the live
//                       recordGame/recordGacha counters aren't double-counted)
//   --guild <id>        only attribute this guildId
//   --legacy-guild <id> attribute the pre-split `_legacy` bucket to this guild
//                       (otherwise legacy buckets are skipped — can't write to
//                        a fake guild key)
//   --since / --until <YYYY-MM-DD>   bucket date window
//   --bucket <YYYY-MM-DD>            only this one bucket
//   --per-bucket        also print a per-day breakdown (report only)
//   --json              machine-readable aggregate output (no write)
//
// Usage
// ─────
//   node src/scripts/read_metrics_winloss.js                  # dry-run report
//   node src/scripts/read_metrics_winloss.js --reset --write  # commit backfill
//
// IMPORTANT: stop the bot before --write, otherwise its in-memory state will
// overwrite this script's changes on the next save.

const metrics = require('../services/metrics');
const profile = require('../services/profile');
const { saveData, flushSync } = require('../state');

const GAMES = ['slot', 'coinflip', 'tong', 'mat'];
const GAME_LABEL = { slot: 'SLOT', coinflip: 'COINFLIP', tong: 'TONG', mat: 'MAT' };

function parseArgs(argv) {
    const out = {
        write: false, reset: false, includeToday: false,
        guild: null, legacyGuild: null, since: null, until: null,
        bucket: null, perBucket: false, json: false
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--write') out.write = true;
        else if (a === '--reset') out.reset = true;
        else if (a === '--include-today') out.includeToday = true;
        else if (a === '--per-bucket') out.perBucket = true;
        else if (a === '--json') out.json = true;
        else if (a === '--guild') out.guild = argv[++i];
        else if (a === '--legacy-guild') out.legacyGuild = argv[++i];
        else if (a === '--since') out.since = argv[++i];
        else if (a === '--until') out.until = argv[++i];
        else if (a === '--bucket') out.bucket = argv[++i];
        else { console.error(`Unknown arg: ${a}`); process.exit(2); }
    }
    return out;
}

function fmt(n) { return Number(Math.round(n)).toLocaleString('en-US'); }
function sign(n) { return n >= 0 ? `+${fmt(n)}` : `${fmt(n)}`; }
function pct(a, b) { return b ? (a / b * 100).toFixed(1) + '%' : '—'; }

// Aggregate accumulator (exact, for the report).
function emptyAcc() {
    const games = {};
    for (const g of GAMES) games[g] = { spins: 0, wins: 0, wagered: 0, payout: 0 };
    return { games, gacha: { rolls: 0, cao: 0, thienthuong: 0, kythuong: 0, hits: 0 } };
}

// Per-user accumulator node (won/lost per game + gacha), created on demand.
function getUserNode(perUser, guildId, uid) {
    if (!perUser[guildId]) perUser[guildId] = {};
    if (!perUser[guildId][uid]) {
        const games = {};
        for (const g of GAMES) games[g] = { won: 0, lost: 0 };
        perUser[guildId][uid] = { games, gacha: { rolls: 0, cao: 0, thienthuong: 0, kythuong: 0 } };
    }
    return perUser[guildId][uid];
}

// Fold one bucket into the aggregate + per-user accumulators. Legacy buckets
// are skipped unless remapped via --legacy-guild (we can't write to a fake
// guild key). Returns nothing; mutates accumulators + counters.
function foldBucket(total, perUser, raw, args, counters) {
    for (const [guildKey, perGame] of Object.entries(raw)) {
        let guildId = guildKey;
        if (guildKey === metrics.LEGACY_GUILD_KEY) {
            if (!args.legacyGuild) { counters.skippedLegacy++; continue; }
            guildId = args.legacyGuild;
        }
        if (args.guild && guildId !== args.guild) continue;

        for (const g of GAMES) {
            const m = perGame[g];
            if (!m || !m.spins) continue;
            const a = total.games[g];
            a.spins += m.spins;
            a.wins += m.wins || 0;
            a.wagered += m.wagered || 0;
            a.payout += m.payout || 0;

            if (!m.playerIds) continue;
            const avgBet = m.wagered / m.spins;
            const avgPayout = m.payout / m.spins;
            const winRate = (m.wins || 0) / m.spins;
            for (const [uid, plays] of Object.entries(m.playerIds)) {
                const n = Number(plays) || 0;
                if (n <= 0) continue;
                if (metrics.isExcluded && metrics.isExcluded(uid)) continue;
                const node = getUserNode(perUser, guildId, uid).games[g];
                const estPayout = avgPayout * n;
                const winningBets = avgBet * winRate * n;
                node.won += Math.max(0, estPayout - winningBets);
                node.lost += avgBet * (1 - winRate) * n;
            }
        }

        const gm = perGame.gacha;
        if (gm && gm.rolls) {
            const ic = gm.itemCounts || {};
            total.gacha.rolls += gm.rolls;
            total.gacha.hits += gm.hits || 0;
            total.gacha.cao += ic.cao || 0;
            total.gacha.thienthuong += ic.thienthuong || 0;
            total.gacha.kythuong += ic.kythuong || 0;

            if (gm.playerIds) {
                for (const [uid, urolls] of Object.entries(gm.playerIds)) {
                    const n = Number(urolls) || 0;
                    if (n <= 0) continue;
                    if (metrics.isExcluded && metrics.isExcluded(uid)) continue;
                    const node = getUserNode(perUser, guildId, uid).gacha;
                    const share = gm.rolls ? n / gm.rolls : 0;
                    node.rolls += n;
                    node.cao += (ic.cao || 0) * share;
                    node.thienthuong += (ic.thienthuong || 0) * share;
                    node.kythuong += (ic.kythuong || 0) * share;
                }
            }
        }
    }
}

// Derive won/lost (approx) + net from a folded aggregate game metric.
function deriveGame(m) {
    const avgBet = m.spins ? m.wagered / m.spins : 0;
    const totalWon = Math.max(0, m.payout - avgBet * m.wins);
    const totalLost = avgBet * (m.spins - m.wins);
    return { ...m, totalWon, totalLost, net: m.payout - m.wagered };
}

function reportLines(acc, header) {
    const lines = [header, '─'.repeat(header.length)];
    for (const g of GAMES) {
        const d = deriveGame(acc.games[g]);
        if (d.spins === 0) { lines.push(`${GAME_LABEL[g].padEnd(9)} (chưa có dữ liệu)`); continue; }
        lines.push(`${GAME_LABEL[g].padEnd(9)} ${fmt(d.spins)} lượt · thắng ${fmt(d.wins)} (${pct(d.wins, d.spins)})`);
        lines.push(`          Tổng thắng ≈ ${fmt(d.totalWon)}  |  Tổng thua ≈ ${fmt(d.totalLost)}  |  Net ${sign(d.net)}`);
        lines.push(`          (wagered ${fmt(d.wagered)} · payout ${fmt(d.payout)})`);
    }
    const gc = acc.gacha;
    lines.push('');
    lines.push(`GACHA     ${fmt(gc.rolls)} lượt quay`);
    lines.push(`          Cáo ${fmt(gc.cao)}  |  Thiên Thưởng ${fmt(gc.thienthuong)}  |  Kỳ Thưởng ${fmt(gc.kythuong)}  |  Tổng hit ${fmt(gc.hits)} (${pct(gc.hits, gc.rolls)})`);
    return lines;
}

function toJSON(acc) {
    const games = {};
    for (const g of GAMES) {
        const d = deriveGame(acc.games[g]);
        games[g] = {
            spins: d.spins, wins: d.wins, wagered: d.wagered, payout: d.payout,
            totalWon: Math.round(d.totalWon), totalLost: Math.round(d.totalLost), net: d.net
        };
    }
    return { games, gacha: acc.gacha };
}

// Apply the per-user accumulator into data.profile. Touches ONLY the new
// fields (totalWon/totalLost + gachaStats); plays/totalBet/totalPayout are left
// to import_metrics_to_gamestats.js / live tracking.
function applyWrite(perUser, args) {
    let users = 0, guilds = 0;
    for (const guildId of Object.keys(perUser)) {
        guilds++;
        for (const uid of Object.keys(perUser[guildId])) {
            users++;
            const node = perUser[guildId][uid];
            const gs = profile.getGameStats(guildId, uid);   // ensured ref → p.gameStats
            const gc = profile.getGachaStats(guildId, uid);  // ensured ref → p.gachaStats
            for (const g of GAMES) {
                const inc = node.games[g];
                const won = Math.round(inc.won), lost = Math.round(inc.lost);
                if (args.reset) { gs[g].totalWon = won; gs[g].totalLost = lost; }
                else { gs[g].totalWon += won; gs[g].totalLost += lost; }
            }
            const ga = node.gacha;
            const r = Math.round(ga.rolls), c = Math.round(ga.cao), t = Math.round(ga.thienthuong), k = Math.round(ga.kythuong);
            if (args.reset) { gc.rolls = r; gc.cao = c; gc.thienthuong = t; gc.kythuong = k; }
            else { gc.rolls += r; gc.cao += c; gc.thienthuong += t; gc.kythuong += k; }
        }
    }
    saveData();
    flushSync();
    return { users, guilds };
}

(function main() {
    const args = parseArgs(process.argv);
    if (args.write) {
        console.log('⚠️  STOP THE BOT before --write — its in-memory state will overwrite this file on the next save.\n');
    }

    let buckets = metrics.listBuckets();          // newest-first
    if (buckets.length === 0) {
        console.error('No metrics buckets found in metrics/ — nothing to read.');
        process.exit(1);
    }
    buckets = buckets.slice().sort();              // oldest-first
    const today = metrics.currentBucket();
    if (args.bucket) buckets = buckets.filter(b => b === args.bucket);
    if (!args.includeToday) buckets = buckets.filter(b => b !== today);
    if (args.since) buckets = buckets.filter(b => b >= args.since);
    if (args.until) buckets = buckets.filter(b => b <= args.until);

    if (buckets.length === 0) {
        console.error('No buckets match the given filters (today is excluded unless --include-today).');
        process.exit(1);
    }

    const total = emptyAcc();
    const perUser = {};
    const counters = { skippedLegacy: 0 };
    const perBucket = [];
    for (const b of buckets) {
        const raw = metrics.loadBucket(b);
        if (args.perBucket) {
            const one = emptyAcc();
            foldBucket(one, {}, raw, args, { skippedLegacy: 0 });
            perBucket.push({ bucket: b, acc: one });
        }
        foldBucket(total, perUser, raw, args, counters);
    }

    const scope = args.guild ? `guild ${args.guild}` : 'tất cả guild';
    const range = `${buckets[0]} → ${buckets[buckets.length - 1]} (${buckets.length} ngày)`;

    if (args.json) {
        const payload = { scope, buckets: buckets.length, range, total: toJSON(total) };
        if (args.perBucket) payload.perBucket = perBucket.map(p => ({ bucket: p.bucket, ...toJSON(p.acc) }));
        console.log(JSON.stringify(payload, null, 2));
        return;
    }

    console.log(`📊 Metrics win/loss + gacha — ${scope}`);
    console.log(`   Khoảng: ${range}`);
    console.log(`   (Tổng thắng/thua là ƯỚC LƯỢNG theo avg-bet; gacha rolls chính xác)\n`);

    if (args.perBucket) {
        for (const p of perBucket) {
            for (const ln of reportLines(p.acc, `📅 ${p.bucket}`)) console.log(ln);
            console.log('');
        }
    }

    for (const ln of reportLines(total, '🧮 TỔNG CỘNG')) console.log(ln);

    if (counters.skippedLegacy > 0) {
        console.log(`\n⚠️  Bỏ qua ${counters.skippedLegacy} mục bucket legacy (không có guildId). Dùng --legacy-guild <id> để gán.`);
    }

    // Per-user preview (top 25 by activity).
    const flatUsers = [];
    for (const guildId of Object.keys(perUser)) {
        for (const uid of Object.keys(perUser[guildId])) {
            const node = perUser[guildId][uid];
            let won = 0, lost = 0;
            for (const g of GAMES) { won += node.games[g].won; lost += node.games[g].lost; }
            flatUsers.push({ guildId, uid, won, lost, rolls: node.gacha.rolls });
        }
    }
    flatUsers.sort((a, b) => (b.won + b.lost + b.rolls) - (a.won + a.lost + a.rolls));
    if (flatUsers.length > 0) {
        console.log(`\n👤 Mẫu per-user (top ${Math.min(25, flatUsers.length)} / ${flatUsers.length}):`);
        for (const u of flatUsers.slice(0, 25)) {
            console.log(`  ${u.guildId}/${u.uid}: thắng ≈ ${fmt(u.won)} · thua ≈ ${fmt(u.lost)} · gacha ${fmt(u.rolls)} lượt`);
        }
    }

    if (args.write) {
        const { users, guilds } = applyWrite(perUser, args);
        console.log(`\n✅ Đã ghi gameStats.totalWon/totalLost + gachaStats cho ${users} người chơi / ${guilds} guild (${args.reset ? 'reset+set' : 'cộng dồn'}).`);
        console.log('⚠️  Nếu bot đang chạy lúc chạy script này, hãy restart bot ngay (state trong RAM sẽ ghi đè file).');
    } else {
        console.log(`\nDry run — thêm --write để áp dụng. Khuyến nghị: --reset --write (idempotent).`);
        if (!args.includeToday) console.log(`Bucket hôm nay (${today}) bị loại trừ. Dùng --include-today nếu live counters CHƯA chạy.`);
    }
})();
