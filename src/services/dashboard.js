const http = require('http');
const url = require('url');
const log = require('../../logger');
const metrics = require('./metrics');
const economyConfig = require('./economyConfig');
const adminAuth = require('./adminAuth');
const sysStatus = require('./sysStatus');

const DEFAULT_PORT = 3000;
const SESSION_COOKIE = 'qtadmin';
const MAX_BODY_BYTES = 256 * 1024;

let _discordClient = null;

function uniqueCount(map) {
    return map ? Object.keys(map).length : 0;
}

// Strip raw player IDs from a flat store, keep aggregate uniquePlayers count.
function sanitizeFlatStore(store) {
    if (!store) return {};
    const out = {};
    for (const [game, m] of Object.entries(store)) {
        if (!m || typeof m !== 'object') { out[game] = m; continue; }
        const copy = { ...m };
        if (copy.playerIds) {
            copy.uniquePlayers = uniqueCount(copy.playerIds);
            delete copy.playerIds;
        }
        out[game] = copy;
    }
    return out;
}

function buildSeries(buckets, days, guildFilter) {
    const slice = buckets.slice(0, days);
    const series = [];
    for (const b of slice) {
        const s = metrics.loadBucket(b);
        const net = metrics.netFromStore(s, guildFilter);
        series.push({
            bucket: b,
            netEconomy: net.netEconomy,
            netGame: net.netGame,
            minted: net.minted,
            mintedWordchain: net.mintedWordchain,
            mintedGangoc: net.mintedGangoc,
            mintedDailyNganphieu: net.mintedDailyNganphieu,
            mintedVuaTiengViet: net.mintedVuaTiengViet,
            burned: net.burned
        });
    }
    return series.reverse();
}

function guildNameFor(id) {
    if (id === metrics.LEGACY_GUILD_KEY) return '(legacy / pre-split)';
    if (!_discordClient) return null;
    const g = _discordClient.guilds.cache.get(id);
    return g ? g.name : null;
}

function buildGuildList() {
    // Union of guild IDs across all buckets.
    const ids = new Set(metrics.listAllGuilds());
    // Surface 'all' as a pseudo-option at the top.
    const list = [{ id: 'all', name: 'Tất cả guild (aggregate)' }];
    for (const id of Array.from(ids).sort()) {
        list.push({ id, name: guildNameFor(id) || `(unknown ${id})` });
    }
    return list;
}

function buildSnapshot(date, guildFilter) {
    metrics.flush();
    const buckets = metrics.listBuckets();
    const target = date && buckets.includes(date) ? date : (buckets[0] || metrics.currentBucket());
    const rawStore = metrics.loadBucket(target);
    const flat = metrics.flattenStore(rawStore, guildFilter);
    const net = metrics.netFromStore(rawStore, guildFilter);
    const rolling = metrics.rollingNet(7, guildFilter);
    return {
        date: target,
        guild: guildFilter || 'all',
        guilds: buildGuildList(),
        generatedAt: new Date().toISOString(),
        buckets,
        store: sanitizeFlatStore(flat),
        net,
        rolling,
        series7: buildSeries(buckets, 7, guildFilter)
    };
}

function sendJson(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(json);
}

function sendHtml(res, html) {
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(html);
}

// --- Admin panel helpers -------------------------------------------------

function parseCookies(req) {
    const out = {};
    const header = req.headers.cookie;
    if (!header) return out;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) out[k] = decodeURIComponent(v);
    }
    return out;
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('payload too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch (e) {
                reject(new Error('invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

function setSessionCookie(res, token) {
    const maxAge = Math.floor(adminAuth.SESSION_TTL_MS / 1000);
    res.setHeader('Set-Cookie',
        `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Strict`);
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`);
}

function currentSession(req) {
    const cookies = parseCookies(req);
    return adminAuth.getSession(cookies[SESSION_COOKIE]);
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>qtbot metrics</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0f1419;
    --panel: #1a2027;
    --panel-2: #232b35;
    --border: #2f3a47;
    --text: #e6e6e6;
    --muted: #8a96a3;
    --accent: #4fc3f7;
    --good: #66bb6a;
    --bad: #ef5350;
    --warn: #ffb74d;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0; background: var(--bg); color: var(--text);
    padding: 16px;
  }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; }
  .meta { color: var(--muted); font-size: 13px; }
  select, button {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 10px; font-size: 13px; cursor: pointer;
  }
  button:hover, select:hover { border-color: var(--accent); }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: 12px;
    margin-bottom: 12px;
  }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 14px;
  }
  .card h2 { margin: 0 0 8px 0; font-size: 15px; font-weight: 600; }
  .card .row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 13px; }
  .card .row .k { color: var(--muted); }
  .card .row .v { font-variant-numeric: tabular-nums; }
  .v.good { color: var(--good); }
  .v.bad { color: var(--bad); }
  .v.warn { color: var(--warn); }
  .v.accent { color: var(--accent); font-weight: 600; }
  .chart-card { grid-column: 1 / -1; height: 320px; }
  .chart-card canvas { width: 100% !important; height: 260px !important; }
  .chart-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
    gap: 12px; margin-bottom: 12px;
  }
  .chart-sm {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px;
  }
  .chart-sm h2 { margin: 0 0 8px 0; font-size: 14px; font-weight: 600; }
  .chart-sm canvas { width: 100% !important; height: 220px !important; }

  /* Floating refresh button (follows scroll, like back-to-top) */
  .fab {
    position: fixed; right: 20px; bottom: 20px;
    background: var(--accent); color: #0f1419; border: none;
    border-radius: 999px; padding: 12px 18px;
    font-size: 14px; font-weight: 600; cursor: pointer;
    box-shadow: 0 4px 14px rgba(0,0,0,0.5);
    display: flex; align-items: center; gap: 8px;
    z-index: 100;
  }
  .fab:hover { background: #81d4fa; }
  .fab.loading .spinner { display: inline-block; }
  .spinner {
    display: none; width: 12px; height: 12px; border-radius: 50%;
    border: 2px solid #0f1419; border-top-color: transparent;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .countdown { font-size: 11px; color: var(--muted); margin-left: 6px; }
  .net-banner {
    background: linear-gradient(135deg, #1e293b, #0f172a);
    border: 1px solid var(--border); border-radius: 8px;
    padding: 14px; margin-bottom: 12px;
  }
  .net-banner .big { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .net-banner .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .net-banner .sub { color: var(--muted); font-size: 13px; margin-top: 4px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--border); font-size: 11px; color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>qtbot metrics</h1>
  <label class="meta">Guild:</label>
  <select id="guildSelect"></select>
  <label class="meta">Ngày:</label>
  <select id="dateSelect"></select>
  <span class="meta">Last updated: <span id="updated">—</span></span>
  <span class="pill" id="bucketLabel">—</span>
  <span class="pill" id="guildLabel">—</span>
</header>

<div class="net-banner" id="netBanner"></div>

<div class="grid" id="grid"></div>

<div class="card chart-card">
  <h2>Net kinh tế — 7 ngày gần nhất</h2>
  <canvas id="chart7"></canvas>
</div>

<div class="chart-grid" id="chartGrid"></div>

<button class="fab" id="refreshBtn">
  <span class="spinner"></span>
  <span>↻ Refresh</span>
  <span class="countdown" id="countdown"></span>
</button>

<script>
const fmt = (n) => {
  if (n === null || n === undefined) return '—';
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US');
};
const sign = (n) => (n >= 0 ? '+' : '') + fmt(n);
const pct = (a, b) => !b ? '—' : ((a / b) * 100).toFixed(1) + '%';
const goodbad = (n) => n > 0 ? 'good' : (n < 0 ? 'bad' : '');

const PALETTE = [
  'rgba(79,195,247,0.85)','rgba(102,187,106,0.85)','rgba(239,83,80,0.85)',
  'rgba(255,183,77,0.85)','rgba(171,71,188,0.85)','rgba(38,198,218,0.85)',
  'rgba(255,138,101,0.85)','rgba(92,107,192,0.85)'
];

let chart;
let gameCharts = {};
let snapshot;
let nextRefreshAt = 0;
const REFRESH_MS = 60_000;

function row(k, v, cls = '') {
  return '<div class="row"><span class="k">' + k + '</span><span class="v ' + cls + '">' + v + '</span></div>';
}

function card(title, rows) {
  return '<div class="card"><h2>' + title + '</h2>' + rows.join('') + '</div>';
}

function renderNetBanner(snap) {
  const n = snap.net;
  const r = snap.rolling;
  const guildLabel = snap.guild === 'all' ? 'tất cả guild' : (guildNameOf(snap, snap.guild) || ('guild ' + snap.guild));
  const html =
    '<div class="label">Net kinh tế ngày ' + snap.date + ' — ' + guildLabel + '</div>' +
    '<div class="big ' + goodbad(n.netEconomy) + '">' + sign(n.netEconomy) + ' ngọc</div>' +
    '<div class="sub">' +
      '= net game (' + sign(n.netGame) + ') + minted faucets (' + sign(n.minted) + ') − gacha burned (' + fmt(n.burned) + ')' +
    '</div>' +
    '<div class="sub">' +
      'Faucet breakdown — wordchain: ' + fmt(n.mintedWordchain) + ' ngọc · gangoc: ' + fmt(n.mintedGangoc) + ' ngọc · daily: ' + fmt(n.mintedDailyNganphieu) + ' ngân phiếu (≈ ' + fmt(n.mintedDailyNganphieu / 100) + ' ngọc-eq)' +
    '</div>' +
    '<div class="sub">📈 7-day rolling avg: ' + sign(Math.round(r.avg)) + ' ngọc/ngày (' + r.days + ' ngày)</div>';
  document.getElementById('netBanner').innerHTML = html;
}

function renderGameCards(snap) {
  const s = snap.store;
  const cards = [];

  for (const g of ['slot', 'coinflip', 'tong', 'mat']) {
    const m = s[g];
    if (!m) continue;
    const edge = (m.wagered || 0) - (m.payout || 0);
    const titleMap = {
      slot: '🎰 SLOT', coinflip: '🪙 COINFLIP', tong: '🎲 TONG', mat: '🎲 MAT'
    };
    cards.push(card(titleMap[g] + ' — ' + fmt(m.spins || 0) + ' lượt', [
      row('Wagered', fmt(m.wagered || 0)),
      row('Payout', fmt(m.payout || 0)),
      row('Edge nhà', fmt(edge) + ' (' + pct(edge, m.wagered) + ')', edge >= 0 ? 'good' : 'bad'),
      row('Wins', fmt(m.wins || 0) + ' (' + pct(m.wins, m.spins) + ')'),
      row('Biggest win', fmt(m.biggestWin || 0) + ' (bet ' + fmt(m.biggestWinBet || 0) + ')'),
      row('Unique players', fmt(m.uniquePlayers || 0), 'accent'),
      row('Max bet', fmt(m.maxBet || 0))
    ]));
  }

  if (s.gacha) {
    const m = s.gacha;
    const ic = m.itemCounts || {};
    cards.push(card('🎁 GACHA (sink) — ' + fmt(m.rolls || 0) + ' lượt', [
      row('Burned', fmt(m.burned || 0) + ' ngọc', 'bad'),
      row('Unique rollers', fmt(m.uniquePlayers || 0), 'accent'),
      row('Hits', fmt(m.hits || 0) + ' (' + pct(m.hits, m.rolls) + ')'),
      row('KT pity rolls', fmt(m.ktPityRolls || 0) + ' (hits ' + fmt(m.hitsAtPityKt || 0) + ')'),
      row('TT pity rolls', fmt(m.ttPityRolls || 0) + ' (hits ' + fmt(m.hitsAtPityTt || 0) + ')'),
      row('Cao / TT / KT', fmt(ic.cao || 0) + ' / ' + fmt(ic.thienthuong || 0) + ' / ' + fmt(ic.kythuong || 0)),
      row('Diều / Nhuộm', fmt(ic.dieu || 0) + ' / ' + fmt(ic.nhuom || 0))
    ]));
  }

  if (s.wordchain_eng) {
    const m = s.wordchain_eng;
    const er = m.endReasons || {};
    cards.push(card('📝 WORDCHAIN_ENG (faucet) — ' + fmt(m.rounds || 0) + ' ván', [
      row('Minted', fmt(m.ngocAwarded || 0) + ' ngọc', 'good'),
      row('Unique players', fmt(m.uniquePlayers || 0), 'accent'),
      row('Total words', fmt(m.totalWords || 0)),
      row('Avg words/round', m.rounds ? (m.totalWords / m.rounds).toFixed(1) : '—'),
      row('Biggest round', fmt(m.biggestRound || 0)),
      row('Multiplayer rounds', fmt(m.multiplayerRounds || 0) + ' (' + pct(m.multiplayerRounds, m.rounds) + ')'),
      row('Rejected words', fmt(m.rejectedWords || 0)),
      row('End reasons', 'timeout:' + (er.timeout || 0) + ' · dead_end:' + (er.dead_end || 0) + ' · sur:' + (er.surrender || 0))
    ]));
  }

  if (s.vuatiengviet) {
    const m = s.vuatiengviet;
    const bd = m.byDifficulty || {};
    cards.push(card('🇻🇳 VUATIENGVIET (faucet) — ' + fmt(m.words || 0) + ' từ', [
      row('Minted', fmt(m.ngocAwarded || 0) + ' ngọc', 'good'),
      row('Unique players', fmt(m.uniquePlayers || 0), 'accent'),
      row('Dễ', fmt((bd.easy || {}).words || 0) + ' từ (' + fmt((bd.easy || {}).ngocAwarded || 0) + ' ngọc)'),
      row('Trung bình', fmt((bd.medium || {}).words || 0) + ' từ (' + fmt((bd.medium || {}).ngocAwarded || 0) + ' ngọc)'),
      row('Khó', fmt((bd.hard || {}).words || 0) + ' từ (' + fmt((bd.hard || {}).ngocAwarded || 0) + ' ngọc)')
    ]));
  }

  if (s.daily) {
    const m = s.daily;
    cards.push(card('🎁 DAILY (faucet) — ' + fmt(m.claims || 0) + ' lượt nhận', [
      row('Minted', fmt(m.nganphieuMinted || 0) + ' ngân phiếu', 'good'),
      row('≈ ngọc-equiv', fmt((m.nganphieuMinted || 0) / 100)),
      row('Unique claimers', fmt(m.uniquePlayers || 0), 'accent')
    ]));
  }

  if (s.gangoc) {
    const m = s.gangoc;
    const avgPerGa = m.giveaways ? Math.round(m.ngocPerClaimTotal / m.giveaways) : 0;
    cards.push(card('🎉 GANGOC (faucet) — ' + fmt(m.giveaways || 0) + ' GAs', [
      row('Minted', fmt(m.ngocMinted || 0) + ' ngọc', 'good'),
      row('Claims', fmt(m.claims || 0)),
      row('Unique claimers', fmt(m.uniquePlayers || 0), 'accent'),
      row('Avg ngọc/GA (per claim)', fmt(avgPerGa))
    ]));
  }

  document.getElementById('grid').innerHTML = cards.join('');
}

function renderChart(snap) {
  const series = snap.series7 || [];
  const labels = series.map(p => p.bucket.slice(5)); // MM-DD
  const netData = series.map(p => p.netEconomy);
  const mintedData = series.map(p => p.minted);
  const burnedData = series.map(p => -p.burned);
  const gameData = series.map(p => p.netGame);

  const ctx = document.getElementById('chart7').getContext('2d');
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Net kinh tế', data: netData, borderColor: '#4fc3f7', backgroundColor: 'rgba(79,195,247,0.15)', fill: true, tension: 0.25, borderWidth: 2 },
        { label: 'Minted (faucets)', data: mintedData, borderColor: '#66bb6a', borderWidth: 1.5, tension: 0.25 },
        { label: 'Burned (gacha)', data: burnedData, borderColor: '#ef5350', borderWidth: 1.5, tension: 0.25 },
        { label: 'Net game', data: gameData, borderColor: '#ffb74d', borderWidth: 1.5, tension: 0.25 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { color: '#8a96a3' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#8a96a3', callback: v => Number(v).toLocaleString('en-US') }, grid: { color: 'rgba(255,255,255,0.05)' } }
      },
      plugins: {
        legend: { labels: { color: '#e6e6e6', boxWidth: 12 } },
        tooltip: { callbacks: { label: c => c.dataset.label + ': ' + Number(c.parsed.y).toLocaleString('en-US') } }
      }
    }
  });
}

function gcCard(id, title) {
  const d = document.createElement('div');
  d.className = 'chart-sm';
  d.innerHTML = '<h2>' + title + '</h2><canvas id="' + id + '"></canvas>';
  return d;
}

function gcDonut(id, labels, data) {
  const total = data.reduce((a, b) => a + b, 0);
  gameCharts[id] = new Chart(document.getElementById(id).getContext('2d'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: PALETTE.slice(0, data.length), borderWidth: 1, borderColor: 'rgba(0,0,0,0.25)' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { color: '#e6e6e6', boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => c.label + ': ' + fmt(c.parsed) + ' (' + (total ? ((c.parsed/total)*100).toFixed(1) : 0) + '%)' } }
      }
    }
  });
}

function gcBar(id, labels, data, color, xLabel) {
  gameCharts[id] = new Chart(document.getElementById(id).getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ label: xLabel || '', data, backgroundColor: color || PALETTE[0], borderRadius: 3 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => fmt(c.parsed.y) } }
      },
      scales: {
        x: { ticks: { color: '#8a96a3', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#8a96a3', font: { size: 10 }, callback: v => fmt(v) }, grid: { color: 'rgba(255,255,255,0.05)' } }
      }
    }
  });
}

const TONG_SUMS = Array.from({length: 16}, (_, i) => i + 3);

function gcBetBuckets(id, title, m, color, container) {
  const entries = Object.entries(m.betBuckets || {}).filter(([,v]) => v > 0);
  if (!entries.length) return;
  container.appendChild(gcCard(id, title));
  gcBar(id, entries.map(([k]) => k), entries.map(([,v]) => v), color);
}

function renderGameCharts(snap) {
  for (const c of Object.values(gameCharts)) c.destroy();
  gameCharts = {};
  const container = document.getElementById('chartGrid');
  container.innerHTML = '';
  const s = snap.store;

  if (s.slot) {
    const m = s.slot;
    const ocEntries = Object.entries(m.outcomes || {}).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]);
    if (ocEntries.length > 0) {
      container.appendChild(gcCard('gc_slot_oc', '🎰 Slot — Phân phối kết quả'));
      gcDonut('gc_slot_oc', ocEntries.map(e => e[0]), ocEntries.map(e => e[1]));
    }
    gcBetBuckets('gc_slot_bet', '🎰 Slot — Phân phối mức cược', m, PALETTE[0], container);
  }

  if (s.coinflip && (s.coinflip.spins || 0) > 0) {
    const m = s.coinflip;
    container.appendChild(gcCard('gc_cf_wl', '🪙 CoinFlip — Thắng / Thua'));
    gcDonut('gc_cf_wl', ['Thắng','Thua'], [m.wins || 0, (m.spins || 0) - (m.wins || 0)]);
    const sg = m.sideGuess || {};
    if ((sg.sap||0) + (sg.ngua||0) + (sg.none||0) > 0) {
      container.appendChild(gcCard('gc_cf_side', '🪙 CoinFlip — Lựa chọn mặt'));
      gcDonut('gc_cf_side', ['Sấp','Ngửa','Random'], [sg.sap||0, sg.ngua||0, sg.none||0]);
    }
    gcBetBuckets('gc_cf_bet', '🪙 CoinFlip — Phân phối mức cược', m, PALETTE[3], container);
  }

  if (s.mat && (s.mat.spins || 0) > 0) {
    const m = s.mat;
    const fc = m.faceCounts || {};
    if (Object.values(fc).some(v => v > 0)) {
      container.appendChild(gcCard('gc_mat_face', '🎲 Mat — Mặt cược ưa thích'));
      gcBar('gc_mat_face', ['1','2','3','4','5','6'], [1,2,3,4,5,6].map(k => fc[k]||0), PALETTE[3]);
    }
    const mc = m.matchCounts || {};
    if (Object.values(mc).some(v => v > 0)) {
      container.appendChild(gcCard('gc_mat_match', '🎲 Mat — Số xúc xắc khớp'));
      gcBar('gc_mat_match', ['0','1','2','3','4','5','6'], [0,1,2,3,4,5,6].map(k => mc[k]||0), PALETTE[2]);
    }
  }

  if (s.tong && (s.tong.spins || 0) > 0) {
    const m = s.tong;
    const sc = m.sumCounts || {};
    if (Object.values(sc).some(v => v > 0)) {
      container.appendChild(gcCard('gc_tong_sum', '🎲 Tong — Tổng điểm được đặt'));
      gcBar('gc_tong_sum', TONG_SUMS.map(String), TONG_SUMS.map(k => sc[k]||0), PALETTE[4]);
    }
    gcBetBuckets('gc_tong_bet', '🎲 Tong — Phân phối mức cược', m, PALETTE[4], container);
  }

  if (s.vuatiengviet && (s.vuatiengviet.words || 0) > 0) {
    const bd = s.vuatiengviet.byDifficulty || {};
    const dWords = ['easy', 'medium', 'hard'].map(k => (bd[k] || {}).words || 0);
    if (dWords.some(v => v > 0)) {
      container.appendChild(gcCard('gc_vtv_diff', '🇻🇳 VuaTiếngViệt — Từ theo độ khó'));
      gcDonut('gc_vtv_diff', ['Dễ', 'Trung bình', 'Khó'], dWords);
    }
  }

  if (s.gacha && (s.gacha.rolls || 0) > 0) {
    const ic = s.gacha.itemCounts || {};
    const gLabels = ['Cáo','Thiên Thưởng','Kỳ Thưởng','Diều','Nhuộm'];
    const gVals = ['cao','thienthuong','kythuong','dieu','nhuom'].map(k => ic[k]||0);
    if (gVals.some(v => v > 0)) {
      container.appendChild(gcCard('gc_gacha_items', '🎁 Gacha — Phân phối vật phẩm'));
      gcDonut('gc_gacha_items', gLabels, gVals);
    }
  }
}

function renderAll() {
  if (!snapshot) return;
  document.getElementById('updated').textContent = new Date(snapshot.generatedAt).toLocaleTimeString();
  document.getElementById('bucketLabel').textContent = snapshot.date;
  renderNetBanner(snapshot);
  renderGameCards(snapshot);
  renderChart(snapshot);
  renderGameCharts(snapshot);
}

function setDates(buckets, selected) {
  const sel = document.getElementById('dateSelect');
  sel.innerHTML = buckets.map(b => '<option value="' + b + '"' + (b === selected ? ' selected' : '') + '>' + b + '</option>').join('');
}

function setGuilds(guilds, selected) {
  const sel = document.getElementById('guildSelect');
  sel.innerHTML = guilds.map(g => '<option value="' + g.id + '"' + (g.id === selected ? ' selected' : '') + '>' + escapeHtml(g.name || g.id) + ' [' + g.id + ']</option>').join('');
}

function guildNameOf(snap, id) {
  if (!snap || !snap.guilds) return null;
  const g = snap.guilds.find(x => x.id === id);
  return g ? g.name : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const GUILD_STORAGE_KEY = 'qtbot.dashboard.guild';
function loadStoredGuild() {
  try { return localStorage.getItem(GUILD_STORAGE_KEY); } catch (e) { return null; }
}
function saveStoredGuild(g) {
  try { if (g) localStorage.setItem(GUILD_STORAGE_KEY, g); } catch (e) { /* private mode */ }
}

let currentDate = null;
let currentGuild = loadStoredGuild() || 'all';

async function load(date, guild) {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('loading');
  try {
    const params = [];
    if (date) params.push('date=' + encodeURIComponent(date));
    if (guild) params.push('guild=' + encodeURIComponent(guild));
    const qs = params.length ? ('?' + params.join('&')) : '';
    const res = await fetch('/api/snapshot' + qs);
    snapshot = await res.json();
    currentDate = snapshot.date;
    currentGuild = snapshot.guild;
    saveStoredGuild(currentGuild);
    setDates(snapshot.buckets, snapshot.date);
    setGuilds(snapshot.guilds, snapshot.guild);
    document.getElementById('guildLabel').textContent = (guildNameOf(snapshot, snapshot.guild) || snapshot.guild);
    renderAll();
    nextRefreshAt = Date.now() + REFRESH_MS;
  } catch (e) {
    console.error('load failed', e);
  } finally {
    btn.classList.remove('loading');
  }
}

document.getElementById('refreshBtn').addEventListener('click', () => load(currentDate, currentGuild));
document.getElementById('dateSelect').addEventListener('change', (e) => load(e.target.value, currentGuild));
document.getElementById('guildSelect').addEventListener('change', (e) => load(currentDate, e.target.value));

setInterval(() => {
  const remain = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
  document.getElementById('countdown').textContent = remain ? '(' + remain + 's)' : '';
  if (Date.now() >= nextRefreshAt) load(currentDate, currentGuild);
}, 1000);

load(null, currentGuild);
</script>
</body>
</html>`;

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>qtbot — quản trị kinh tế</title>
<style>
  :root {
    --bg:#0f1419; --panel:#1a2027; --panel-2:#232b35; --border:#2f3a47;
    --text:#e6e6e6; --muted:#8a96a3; --accent:#4fc3f7; --good:#66bb6a; --bad:#ef5350; --warn:#ffb74d;
  }
  * { box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; margin:0; background:var(--bg); color:var(--text); padding:16px; }
  h1 { margin:0; font-size:20px; }
  h2 { font-size:15px; margin:0 0 10px; }
  a { color:var(--accent); }
  header { display:flex; align-items:center; gap:12px; margin-bottom:16px; flex-wrap:wrap; }
  .muted { color:var(--muted); font-size:13px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px; margin-bottom:14px; }
  input { background:var(--panel-2); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:7px 9px; font-size:13px; }
  input[type=number]{ width:140px; font-variant-numeric:tabular-nums; }
  button { background:var(--panel-2); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:7px 12px; font-size:13px; cursor:pointer; }
  button:hover { border-color:var(--accent); }
  button.primary { background:var(--accent); color:#0f1419; border:none; font-weight:600; }
  button.danger { color:var(--bad); border-color:var(--bad); }
  button.link { background:none; border:none; color:var(--muted); padding:2px 6px; }
  button.link:hover { color:var(--accent); }
  .row { display:flex; align-items:center; gap:10px; padding:5px 0; border-bottom:1px solid rgba(255,255,255,0.04); }
  .row .label { flex:1; font-size:13px; }
  .row .def { color:var(--muted); font-size:11px; min-width:130px; }
  .badge { font-size:10px; padding:1px 6px; border-radius:999px; background:var(--warn); color:#0f1419; font-weight:600; }
  .section { margin-bottom:6px; }
  .section h3 { font-size:13px; color:var(--accent); margin:14px 0 4px; text-transform:uppercase; letter-spacing:.5px; }
  .changed input { border-color:var(--warn); }
  .toolbar { display:flex; gap:10px; align-items:center; margin:10px 0; position:sticky; top:0; background:var(--bg); padding:8px 0; z-index:5; }
  .toast { position:fixed; right:20px; bottom:20px; padding:12px 18px; border-radius:8px; font-size:13px; box-shadow:0 4px 14px rgba(0,0,0,.5); display:none; z-index:100; }
  .toast.ok { background:var(--good); color:#0f1419; }
  .toast.err { background:var(--bad); color:#fff; }
  .login { max-width:340px; margin:60px auto; }
  .login input { width:100%; margin-bottom:10px; }
  .acct-row { display:flex; align-items:center; gap:10px; padding:5px 0; }
  .grid2 { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .hidden { display:none; }
</style>
</head>
<body>

<div id="loginView" class="hidden">
  <div class="login card">
    <h1>qtbot quản trị</h1>
    <p class="muted">Đăng nhập để chỉnh giá trị kinh tế.</p>
    <input id="lgUser" placeholder="Tên đăng nhập" autocomplete="username">
    <input id="lgPass" type="password" placeholder="Mật khẩu" autocomplete="current-password">
    <button class="primary" id="lgBtn" style="width:100%">Đăng nhập</button>
    <p class="muted" id="lgMsg" style="color:var(--bad)"></p>
    <p class="muted" id="lgRootWarn"></p>
  </div>
</div>

<div id="appView" class="hidden">
  <header>
    <h1>qtbot — kinh tế</h1>
    <span class="muted">· <a href="/">metrics dashboard</a> · <a href="/status">VPS status</a></span>
    <span style="flex:1"></span>
    <span class="muted">Đăng nhập: <b id="meUser">—</b> (<span id="meRole">—</span>)</span>
    <button id="logoutBtn">Đăng xuất</button>
  </header>

  <div class="card">
    <div class="toolbar">
      <h2 style="margin:0">Giá trị kinh tế</h2>
      <span class="badge" id="changeCount" style="display:none"></span>
      <span style="flex:1"></span>
      <input id="filter" placeholder="Lọc theo tên…" style="width:200px">
      <button id="resetAllBtn" class="danger">Khôi phục mặc định tất cả</button>
      <button id="saveBtn" class="primary">Lưu thay đổi</button>
    </div>
    <p class="muted">Thay đổi áp dụng <b>ngay lập tức</b> vào bot và được lưu lại (không cần khởi động lại). Chỉ sửa được giá trị số.</p>
    <div id="fields"></div>
  </div>

  <div class="card" id="acctCard">
    <h2>Tài khoản quản trị</h2>
    <p class="muted">Tài khoản gốc có thể tạo thêm tài khoản (chỉ chỉnh kinh tế, không quản lý tài khoản).</p>
    <div id="acctList"></div>
    <div class="grid2" style="margin-top:12px">
      <input id="acUser" placeholder="Tên đăng nhập mới">
      <input id="acPass" type="password" placeholder="Mật khẩu (≥6 ký tự)">
      <button class="primary" id="acCreate">Tạo tài khoản</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let ME = null;
let FIELDS = [];

function toast(msg, ok = true) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + (ok ? 'ok' : 'err');
  t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.display = 'none'; }, 3200);
}

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  let body = {};
  try { body = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
}

function fmtNum(n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 }); }

function renderFields() {
  const q = $('filter').value.trim().toLowerCase();
  const sections = {};
  for (const f of FIELDS) {
    if (q && !f.path.toLowerCase().includes(q)) continue;
    (sections[f.section] = sections[f.section] || []).push(f);
  }
  const html = Object.keys(sections).sort().map(sec => {
    const rows = sections[sec].map(f => {
      const sub = f.path.slice(f.section.length + 1) || f.path;
      return '<div class="row" data-path="' + f.path + '">' +
        '<span class="label">' + escapeHtml(sub) +
          (f.overridden ? ' <span class="badge">đã sửa</span>' : '') + '</span>' +
        '<span class="def">mặc định: ' + fmtNum(f.default) + '</span>' +
        '<input type="number" step="any" value="' + f.value + '" data-orig="' + f.value + '">' +
        '<button class="link reset-btn" title="Khôi phục mặc định">↺</button>' +
      '</div>';
    }).join('');
    return '<div class="section"><h3>' + escapeHtml(sec) + '</h3>' + rows + '</div>';
  }).join('');
  $('fields').innerHTML = html || '<p class="muted">Không có trường nào khớp.</p>';
  bindFieldEvents();
  updateChangeCount();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

function bindFieldEvents() {
  $('fields').querySelectorAll('input[type=number]').forEach(inp => {
    inp.addEventListener('input', () => {
      const row = inp.closest('.row');
      row.classList.toggle('changed', inp.value !== inp.dataset.orig);
      updateChangeCount();
    });
  });
  $('fields').querySelectorAll('.reset-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const path = btn.closest('.row').dataset.path;
      try {
        const r = await api('/api/admin/economy/reset', { method: 'POST', body: JSON.stringify({ path }) });
        FIELDS = r.fields;
        renderFields();
        toast('Đã khôi phục ' + path);
      } catch (e) { toast(e.message, false); }
    });
  });
}

function collectChanges() {
  const changes = {};
  $('fields').querySelectorAll('.row').forEach(row => {
    const inp = row.querySelector('input[type=number]');
    if (inp && inp.value !== inp.dataset.orig && inp.value !== '') {
      changes[row.dataset.path] = Number(inp.value);
    }
  });
  return changes;
}

function updateChangeCount() {
  const n = Object.keys(collectChanges()).length;
  const badge = $('changeCount');
  badge.style.display = n ? 'inline-block' : 'none';
  badge.textContent = n + ' thay đổi';
}

async function saveChanges() {
  const changes = collectChanges();
  if (!Object.keys(changes).length) return toast('Không có thay đổi.', false);
  try {
    const r = await api('/api/admin/economy', { method: 'POST', body: JSON.stringify({ changes }) });
    FIELDS = r.fields;
    renderFields();
    toast('Đã áp dụng ' + r.applied.length + ' thay đổi vào bot.');
  } catch (e) { toast(e.message, false); }
}

async function resetAll() {
  if (!confirm('Khôi phục TẤT CẢ giá trị kinh tế về mặc định?')) return;
  try {
    const r = await api('/api/admin/economy/reset', { method: 'POST', body: JSON.stringify({ all: true }) });
    FIELDS = r.fields;
    renderFields();
    toast('Đã khôi phục tất cả về mặc định.');
  } catch (e) { toast(e.message, false); }
}

async function loadEconomy() {
  const r = await api('/api/admin/economy');
  FIELDS = r.fields;
  renderFields();
}

async function loadAccounts() {
  if (ME.role !== 'root') { $('acctCard').style.display = 'none'; return; }
  const r = await api('/api/admin/accounts');
  $('acctList').innerHTML = r.accounts.length
    ? r.accounts.map(a => '<div class="acct-row"><span class="label">' + escapeHtml(a.username) +
        '</span><span class="muted">tạo bởi ' + escapeHtml(a.createdBy || '?') + '</span>' +
        '<button class="link danger del-btn" data-u="' + escapeHtml(a.username) + '">Xoá</button></div>').join('')
    : '<p class="muted">Chưa có tài khoản phụ nào.</p>';
  $('acctList').querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = btn.dataset.u;
      if (!confirm('Xoá tài khoản ' + u + '?')) return;
      try {
        await api('/api/admin/accounts', { method: 'DELETE', body: JSON.stringify({ username: u }) });
        toast('Đã xoá ' + u);
        loadAccounts();
      } catch (e) { toast(e.message, false); }
    });
  });
}

async function showApp() {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('meUser').textContent = ME.user;
  $('meRole').textContent = ME.role;
  await loadEconomy();
  await loadAccounts();
}

function showLogin(rootEnabled) {
  $('appView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
  $('lgRootWarn').textContent = rootEnabled ? '' :
    'Cảnh báo: ADMIN_USER / ADMIN_PASS chưa được cấu hình trên server — tài khoản gốc bị vô hiệu hoá.';
}

async function init() {
  try {
    const me = await api('/api/admin/me');
    if (me.authenticated) {
      ME = { user: me.user, role: me.role };
      await showApp();
    } else {
      showLogin(me.rootEnabled);
    }
  } catch (e) {
    showLogin(true);
  }
}

$('lgBtn').addEventListener('click', async () => {
  $('lgMsg').textContent = '';
  try {
    const r = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('lgUser').value, password: $('lgPass').value })
    });
    ME = { user: r.user, role: r.role };
    await showApp();
  } catch (e) { $('lgMsg').textContent = e.message; }
});
$('lgPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lgBtn').click(); });

$('logoutBtn').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch (e) {}
  location.reload();
});

$('saveBtn').addEventListener('click', saveChanges);
$('resetAllBtn').addEventListener('click', resetAll);
$('filter').addEventListener('input', renderFields);
$('acCreate').addEventListener('click', async () => {
  try {
    await api('/api/admin/accounts', {
      method: 'POST',
      body: JSON.stringify({ username: $('acUser').value, password: $('acPass').value })
    });
    $('acUser').value = ''; $('acPass').value = '';
    toast('Đã tạo tài khoản.');
    loadAccounts();
  } catch (e) { toast(e.message, false); }
});

init();
</script>
</body>
</html>`;

const STATUS_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>qtbot — VPS status</title>
<style>
  :root { --bg:#0f1419; --panel:#1a2027; --panel-2:#232b35; --border:#2f3a47;
    --text:#e6e6e6; --muted:#8a96a3; --accent:#4fc3f7; --good:#66bb6a; --bad:#ef5350; --warn:#ffb74d; }
  * { box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; margin:0; background:var(--bg); color:var(--text); padding:16px; }
  header { display:flex; align-items:center; gap:12px; margin-bottom:16px; flex-wrap:wrap; }
  h1 { margin:0; font-size:20px; }
  a { color:var(--accent); }
  .muted { color:var(--muted); font-size:13px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px; }
  .card h2 { margin:0 0 10px; font-size:14px; font-weight:600; }
  .row { display:flex; justify-content:space-between; padding:3px 0; font-size:13px; }
  .row .k { color:var(--muted); } .row .v { font-variant-numeric:tabular-nums; }
  .v.good { color:var(--good); } .v.bad { color:var(--bad); } .v.warn { color:var(--warn); } .v.accent { color:var(--accent); }
  .bar { height:8px; background:var(--panel-2); border-radius:999px; overflow:hidden; margin:6px 0 10px; }
  .bar > span { display:block; height:100%; background:var(--accent); width:0; transition:width .4s; }
  .bar.warn > span { background:var(--warn); } .bar.bad > span { background:var(--bad); }
  canvas { width:100%; height:60px; display:block; margin-top:6px; }
  .big { font-size:22px; font-weight:700; font-variant-numeric:tabular-nums; }
  .err { background:var(--bad); color:#fff; padding:12px; border-radius:8px; display:none; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; background:var(--panel-2); border:1px solid var(--border); font-size:11px; color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>qtbot — VPS status</h1>
  <span class="muted">· <a href="/">metrics</a> · <a href="/admin">kinh tế</a></span>
  <span style="flex:1"></span>
  <span class="pill" id="host">—</span>
  <span class="muted">cập nhật: <span id="updated">—</span></span>
</header>

<div class="err" id="err">Chưa đăng nhập. Mở <a href="/admin" style="color:#fff;text-decoration:underline">/admin</a> để đăng nhập, rồi tải lại trang này.</div>

<div class="grid" id="grid"></div>

<script>
const $ = (id) => document.getElementById(id);
const REFRESH_MS = 2000;
const HIST = 60;
const cpuHist = [], loopHist = [];

function bytes(n) {
  if (n == null) return '—';
  const u = ['B','KB','MB','GB','TB']; let i = 0; n = Number(n);
  while (n >= 1024 && i < u.length-1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
}
function dur(s) {
  s = Math.floor(Number(s) || 0);
  const d = Math.floor(s/86400); s %= 86400;
  const h = Math.floor(s/3600); s %= 3600;
  const m = Math.floor(s/60);
  return (d ? d+'d ' : '') + (h ? h+'h ' : '') + m + 'm';
}
function cls(pct, warn, bad) { return pct >= bad ? 'bad' : (pct >= warn ? 'warn' : ''); }
function row(k, v, c) { return '<div class="row"><span class="k">'+k+'</span><span class="v '+(c||'')+'">'+v+'</span></div>'; }
function bar(pct, warn, bad) {
  const c = cls(pct, warn, bad);
  return '<div class="bar '+c+'"><span style="width:'+Math.min(100,Math.max(0,pct)).toFixed(1)+'%"></span></div>';
}
function card(title, inner) { return '<div class="card"><h2>'+title+'</h2>'+inner+'</div>'; }

function spark(id, data, color, label, max) {
  const cv = $(id); if (!cv) return;
  const ctx = cv.getContext('2d');
  const w = cv.width = cv.clientWidth, h = cv.height = 60;
  ctx.clearRect(0,0,w,h);
  if (data.length < 2) return;
  const mx = max || Math.max(1, ...data);
  ctx.beginPath();
  data.forEach((v,i) => {
    const x = (i/(HIST-1))*w, y = h - (Math.min(v,mx)/mx)*(h-6) - 3;
    i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
  });
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.lineTo(w,h); ctx.lineTo(0,h); ctx.closePath(); ctx.fill();
}

function render(s) {
  $('host').textContent = s.host + ' · ' + s.platform;
  $('updated').textContent = new Date(s.now).toLocaleTimeString();

  const cards = [];

  // CPU
  cpuHist.push(s.cpu.usagePct); if (cpuHist.length > HIST) cpuHist.shift();
  const la = s.cpu.loadavg.map(x => x.toFixed(2)).join(' / ');
  cards.push(card('CPU — ' + s.cpu.cores + ' core',
    '<div class="big '+cls(s.cpu.usagePct,70,90)+'">'+s.cpu.usagePct.toFixed(1)+'%</div>'+
    bar(s.cpu.usagePct,70,90)+
    row('Load avg (1/5/15m)', la)+
    row('Model', '<span class="muted">'+(s.cpu.model||'?').slice(0,28)+'</span>')+
    '<canvas id="cpuSpark"></canvas>'));

  // Event loop lag — the bot-responsiveness signal
  const el = s.eventLoop;
  if (el) {
    loopHist.push(el.p99Ms); if (loopHist.length > HIST) loopHist.shift();
    const c = el.p99Ms >= 100 ? 'bad' : (el.p99Ms >= 30 ? 'warn' : 'good');
    cards.push(card('Event-loop lag (độ trễ bot)',
      '<div class="big '+c+'">'+el.p99Ms.toFixed(1)+' ms <span class="muted" style="font-size:12px">p99</span></div>'+
      row('Mean', el.meanMs.toFixed(1)+' ms')+
      row('Max', el.maxMs.toFixed(1)+' ms', el.maxMs>=200?'bad':'')+
      '<canvas id="loopSpark"></canvas>'+
      '<div class="muted" style="font-size:11px;margin-top:4px">&lt;30ms tốt · 30–100ms tải nặng · &gt;100ms nghẽn</div>'));
  }

  // Memory
  cards.push(card('Bộ nhớ (RAM)',
    '<div class="big '+cls(s.mem.usedPct,75,90)+'">'+s.mem.usedPct.toFixed(1)+'%</div>'+
    bar(s.mem.usedPct,75,90)+
    row('Đã dùng', bytes(s.mem.used))+
    row('Trống', bytes(s.mem.free))+
    row('Tổng', bytes(s.mem.total))));

  // Swap
  if (s.swap) cards.push(card('Swap',
    bar(s.swap.usedPct,40,75)+
    row('Đã dùng', bytes(s.swap.used)+' / '+bytes(s.swap.total), cls(s.swap.usedPct,40,75))));

  // Disk space
  if (s.disk) cards.push(card('Đĩa (thư mục bot)',
    '<div class="big '+cls(s.disk.usedPct,80,92)+'">'+s.disk.usedPct.toFixed(1)+'%</div>'+
    bar(s.disk.usedPct,80,92)+
    row('Đã dùng', bytes(s.disk.used))+
    row('Trống', bytes(s.disk.free))+
    row('Tổng', bytes(s.disk.total))));

  // Disk IO
  if (s.io && s.io.available) cards.push(card('Disk I/O',
    row('Đọc', bytes(s.io.readBps)+'/s', 'accent')+
    row('Ghi', bytes(s.io.writeBps)+'/s', 'accent')));

  // Process
  cards.push(card('Tiến trình bot',
    row('PID', s.proc.pid)+
    row('Node', s.proc.node)+
    row('Uptime bot', dur(s.uptimeProcSec))+
    row('Uptime máy', dur(s.uptimeHostSec))+
    row('RSS', bytes(s.proc.rss), cls(s.proc.rss/1e9*100,60,85))+
    row('Heap', bytes(s.proc.heapUsed)+' / '+bytes(s.proc.heapTotal))));

  $('grid').innerHTML = cards.join('');
  spark('cpuSpark', cpuHist, '#4fc3f7', 'cpu', 100);
  if (el) spark('loopSpark', loopHist, el.p99Ms>=100?'#ef5350':'#ffb74d', 'loop');
}

async function tick() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (res.status === 401) { $('err').style.display = 'block'; $('grid').innerHTML = ''; return; }
    $('err').style.display = 'none';
    render(await res.json());
  } catch (e) { /* transient */ }
}
tick();
setInterval(tick, REFRESH_MS);
</script>
</body>
</html>`;

// Async router for /api/admin/* and /admin. Returns nothing; writes the response
// itself. All routes that mutate require a valid session; account-management
// routes additionally require the root role.
async function handleAdmin(req, res, pathname) {
    try {
        const method = req.method || 'GET';
        const session = currentSession(req);

        // Public: login + status.
        if (pathname === '/api/admin/login' && method === 'POST') {
            const body = await readJsonBody(req);
            const token = adminAuth.login(body.username, body.password);
            if (!token) return sendJson(res, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu.' });
            setSessionCookie(res, token);
            const s = adminAuth.getSession(token);
            return sendJson(res, 200, { ok: true, user: s.username, role: s.role });
        }
        if (pathname === '/api/admin/me') {
            return sendJson(res, 200, {
                authenticated: !!session,
                user: session ? session.username : null,
                role: session ? session.role : null,
                rootEnabled: adminAuth.rootEnabled()
            });
        }
        if (pathname === '/api/admin/logout' && method === 'POST') {
            const cookies = parseCookies(req);
            adminAuth.destroySession(cookies[SESSION_COOKIE]);
            clearSessionCookie(res);
            return sendJson(res, 200, { ok: true });
        }

        // Everything below needs auth.
        if (!session) return sendJson(res, 401, { error: 'Chưa đăng nhập.' });

        if (pathname === '/api/admin/economy' && method === 'GET') {
            return sendJson(res, 200, {
                fields: economyConfig.listFields(),
                overrides: economyConfig.getOverrides()
            });
        }
        if (pathname === '/api/admin/economy' && method === 'POST') {
            const body = await readJsonBody(req);
            const applied = economyConfig.applyChanges(body.changes || {});
            return sendJson(res, 200, {
                ok: true,
                applied,
                fields: economyConfig.listFields(),
                overrides: economyConfig.getOverrides()
            });
        }
        if (pathname === '/api/admin/economy/reset' && method === 'POST') {
            const body = await readJsonBody(req);
            if (body.all) economyConfig.resetAll();
            else if (body.path) economyConfig.resetField(body.path);
            else return sendJson(res, 400, { error: 'Cần "path" hoặc "all".' });
            return sendJson(res, 200, {
                ok: true,
                fields: economyConfig.listFields(),
                overrides: economyConfig.getOverrides()
            });
        }

        // Account management: root only.
        if (pathname === '/api/admin/accounts') {
            if (session.role !== 'root') return sendJson(res, 403, { error: 'Chỉ tài khoản gốc mới quản lý tài khoản.' });
            if (method === 'GET') {
                return sendJson(res, 200, { accounts: adminAuth.listAccounts() });
            }
            if (method === 'POST') {
                const body = await readJsonBody(req);
                adminAuth.createAccount(body.username, body.password, session.username);
                return sendJson(res, 200, { ok: true, accounts: adminAuth.listAccounts() });
            }
            if (method === 'DELETE') {
                const body = await readJsonBody(req);
                adminAuth.deleteAccount(body.username);
                return sendJson(res, 200, { ok: true, accounts: adminAuth.listAccounts() });
            }
        }
        if (pathname === '/api/admin/accounts/password' && method === 'POST') {
            if (session.role !== 'root') return sendJson(res, 403, { error: 'Chỉ tài khoản gốc mới đổi mật khẩu tài khoản khác.' });
            const body = await readJsonBody(req);
            adminAuth.changePassword(body.username, body.password);
            return sendJson(res, 200, { ok: true });
        }

        return sendJson(res, 404, { error: 'not found' });
    } catch (e) {
        if (e && /payload too large|invalid JSON/.test(e.message)) {
            return sendJson(res, 400, { error: e.message });
        }
        // Validation errors from the services carry user-friendly messages.
        if (e && e.message) return sendJson(res, 400, { error: e.message });
        log.error('dashboard admin handler error', e);
        return sendJson(res, 500, { error: 'internal' });
    }
}

function handle(req, res) {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';
    if (pathname === '/admin' || pathname === '/admin.html') {
        return sendHtml(res, ADMIN_HTML);
    }
    if (pathname.startsWith('/api/admin/')) {
        handleAdmin(req, res, pathname);
        return;
    }
    try {
        if (pathname === '/' || pathname === '/index.html') {
            return sendHtml(res, HTML_PAGE);
        }
        if (pathname === '/status' || pathname === '/status.html') {
            return sendHtml(res, STATUS_HTML);
        }
        if (pathname === '/api/status') {
            // VPS internals — gate behind an admin session.
            if (!currentSession(req)) return sendJson(res, 401, { error: 'Chưa đăng nhập.' });
            return sendJson(res, 200, sysStatus.snapshot());
        }
        if (pathname === '/api/snapshot') {
            const date = parsed.query.date;
            const guild = parsed.query.guild || 'all';
            return sendJson(res, 200, buildSnapshot(date, guild));
        }
        if (pathname === '/api/buckets') {
            return sendJson(res, 200, { buckets: metrics.listBuckets() });
        }
        if (pathname === '/api/guilds') {
            return sendJson(res, 200, { guilds: buildGuildList() });
        }
        if (pathname === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end('ok');
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    } catch (e) {
        log.error('dashboard handler error', e);
        sendJson(res, 500, { error: 'internal' });
    }
}

function start(client, port) {
    if (client && typeof client === 'object' && client.guilds) {
        _discordClient = client;
    } else if (typeof client === 'number') {
        // back-compat: dashboard.start(port)
        port = client;
        _discordClient = null;
    }
    const p = Number(port || process.env.DASHBOARD_PORT || DEFAULT_PORT);
    sysStatus.start();
    const server = http.createServer(handle);
    server.on('error', (e) => log.error('dashboard server error', e));
    server.listen(p, '0.0.0.0', () => {
        log.info(`Dashboard listening on http://0.0.0.0:${p}`);
    });
    return server;
}

module.exports = { start, buildSnapshot };
