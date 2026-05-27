// Backfill `data.profile[guild][user].gameStats` from historical metrics
// bucket files in /metrics/YYYY-MM-DD.json.
//
// Why this is approximate
// ───────────────────────
// Metrics buckets store per-game aggregates (`wagered`, `payout`, `spins`)
// alongside a `playerIds: { userId: playCount }` map. There is no per-user
// wagered/payout history — only the aggregate and the per-user play count.
//
// So this script estimates per-user totals by attributing
//   avg_bet    = wagered / spins
//   avg_payout = payout  / spins
// to each user in proportion to their play count for that bucket. The play
// COUNT is exact; the bet/payout columns are bucket-averaged approximations.
//
// Idempotency
// ───────────
//   --write             apply the import (mutates data.json)
//   --reset             zero each user's gameStats before importing
//                       (recommended; otherwise we double-count if re-run)
//   --guild <id>        only attribute this guildId
//   --legacy-guild <id> attribute the `_legacy` bucket to this guildId
//                       (pre-split metrics had no guild key)
//   --since <YYYY-MM-DD>  ignore buckets dated before this
//   --until <YYYY-MM-DD>  ignore buckets dated after this
//   --include-today     include today's bucket (default skips it so the
//                       live `profile.recordGame` counter isn't doubled)
//
// Usage
// ─────
//   node src/scripts/import_metrics_to_gamestats.js                 # dry-run
//   node src/scripts/import_metrics_to_gamestats.js --reset --write # commit
//
// Exits non-zero on validation errors, 0 otherwise.

const fs = require('fs');
const path = require('path');
const metrics = require('../services/metrics');
const profile = require('../services/profile');
const { data, flushSync } = require('../state');

const GAMES = ['slot', 'coinflip', 'tong', 'mat'];

function parseArgs(argv) {
    const out = {
        write: false, reset: false, includeToday: false,
        guild: null, legacyGuild: null, since: null, until: null
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--write') out.write = true;
        else if (a === '--reset') out.reset = true;
        else if (a === '--include-today') out.includeToday = true;
        else if (a === '--guild')        out.guild = argv[++i];
        else if (a === '--legacy-guild') out.legacyGuild = argv[++i];
        else if (a === '--since')        out.since = argv[++i];
        else if (a === '--until')        out.until = argv[++i];
        else {
            console.error(`Unknown arg: ${a}`);
            process.exit(2);
        }
    }
    return out;
}

function fmt(n) { return Number(n).toLocaleString('en-US'); }

function summarizeStats(stats) {
    let plays = 0, bet = 0, payout = 0;
    for (const g of GAMES) {
        const s = stats[g] || { plays: 0, totalBet: 0, totalPayout: 0 };
        plays += s.plays || 0;
        bet += s.totalBet || 0;
        payout += s.totalPayout || 0;
    }
    return { plays, bet, payout, net: payout - bet };
}

(function main() {
    const args = parseArgs(process.argv);
    const buckets = metrics.listBuckets();
    if (buckets.length === 0) {
        console.error('No metrics buckets found in metrics/ — nothing to import.');
        process.exit(1);
    }

    // listBuckets() returns newest-first; we want oldest-first to apply in
    // chronological order (doesn't matter mathematically since we sum, but
    // is friendlier for any verbose logging).
    const ordered = buckets.slice().sort();
    const today = metrics.currentBucket();
    const filtered = ordered.filter(b => {
        if (!args.includeToday && b === today) return false;
        if (args.since && b < args.since) return false;
        if (args.until && b > args.until) return false;
        return true;
    });

    console.log(`Found ${buckets.length} bucket(s); processing ${filtered.length} after filters.`);
    if (filtered.length === 0) {
        console.log('Nothing to do.');
        process.exit(0);
    }

    // Aggregator: { guildId: { userId: { game: { plays, totalBet, totalPayout } } } }
    const acc = {};
    function getNode(guildId, userId, game) {
        if (!acc[guildId]) acc[guildId] = {};
        if (!acc[guildId][userId]) acc[guildId][userId] = {};
        if (!acc[guildId][userId][game]) acc[guildId][userId][game] = { plays: 0, totalBet: 0, totalPayout: 0 };
        return acc[guildId][userId][game];
    }

    let skippedLegacy = 0;
    for (const b of filtered) {
        const raw = metrics.loadBucket(b);
        for (const [guildKey, perGame] of Object.entries(raw)) {
            let guildId = guildKey;
            if (guildKey === metrics.LEGACY_GUILD_KEY) {
                if (!args.legacyGuild) { skippedLegacy++; continue; }
                guildId = args.legacyGuild;
            }
            if (args.guild && guildId !== args.guild) continue;

            for (const game of GAMES) {
                const m = perGame[game];
                if (!m || !m.spins || !m.playerIds) continue;
                const avgBet = m.wagered / m.spins;
                const avgPayout = m.payout / m.spins;
                for (const [uid, plays] of Object.entries(m.playerIds)) {
                    const n = Number(plays) || 0;
                    if (n <= 0) continue;
                    if (metrics.isExcluded && metrics.isExcluded(uid)) continue;
                    const node = getNode(guildId, uid, game);
                    node.plays += n;
                    node.totalBet    += Math.round(avgBet * n);
                    node.totalPayout += Math.round(avgPayout * n);
                }
            }
        }
    }

    if (skippedLegacy > 0) {
        console.log(`⚠️  Skipped ${skippedLegacy} legacy bucket entries (no guildId). Pass --legacy-guild <id> to attribute.`);
    }

    // ── Diff & apply ────────────────────────────────────────────────────────
    let usersTouched = 0, guildsTouched = 0;
    const previewLines = [];
    for (const guildId of Object.keys(acc)) {
        guildsTouched++;
        for (const uid of Object.keys(acc[guildId])) {
            usersTouched++;
            const imported = acc[guildId][uid];

            if (args.write) {
                const p = profile.getProfile(guildId, uid);
                if (args.reset) {
                    p.gameStats = {};
                }
                if (!p.gameStats || typeof p.gameStats !== 'object') p.gameStats = {};
                for (const g of GAMES) {
                    const incoming = imported[g] || { plays: 0, totalBet: 0, totalPayout: 0 };
                    if (!p.gameStats[g]) p.gameStats[g] = { plays: 0, totalBet: 0, totalPayout: 0 };
                    const cur = p.gameStats[g];
                    if (args.reset) {
                        cur.plays = incoming.plays;
                        cur.totalBet = incoming.totalBet;
                        cur.totalPayout = incoming.totalPayout;
                    } else {
                        cur.plays += incoming.plays;
                        cur.totalBet += incoming.totalBet;
                        cur.totalPayout += incoming.totalPayout;
                    }
                }
            }

            const sumImp = summarizeStats(imported);
            if (sumImp.plays > 0 && previewLines.length < 25) {
                previewLines.push(`  ${guildId}/${uid}: ${fmt(sumImp.plays)} plays · bet ${fmt(sumImp.bet)} · payout ${fmt(sumImp.payout)} · net ${sumImp.net >= 0 ? '+' : ''}${fmt(sumImp.net)}`);
            }
        }
    }

    console.log(`\nAggregated ${usersTouched} user record(s) across ${guildsTouched} guild(s).`);
    if (previewLines.length > 0) {
        console.log(`\nSample (up to 25 users):`);
        for (const ln of previewLines) console.log(ln);
        if (usersTouched > previewLines.length) {
            console.log(`  … ${usersTouched - previewLines.length} more`);
        }
    }

    if (args.write) {
        flushSync();
        console.log(`\n✅ Wrote backfilled gameStats to data.json (${args.reset ? 'reset+set' : 'additive'} mode).`);
    } else {
        console.log(`\nDry run — pass --write to apply.`);
        console.log(`Recommended: --reset --write (so re-running is idempotent).`);
        if (!args.includeToday) {
            console.log(`Today's bucket (${today}) was excluded. Pass --include-today to include — but only do so if live recordGame counters are NOT also in use.`);
        }
    }
})();
