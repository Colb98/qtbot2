const http = require('http');
const url = require('url');
const log = require('../../logger');
const metrics = require('./metrics');

const DEFAULT_PORT = 3000;

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

let chart;
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

function renderAll() {
  if (!snapshot) return;
  document.getElementById('updated').textContent = new Date(snapshot.generatedAt).toLocaleTimeString();
  document.getElementById('bucketLabel').textContent = snapshot.date;
  renderNetBanner(snapshot);
  renderGameCards(snapshot);
  renderChart(snapshot);
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

let currentDate = null;
let currentGuild = 'all';

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

load();
</script>
</body>
</html>`;

function handle(req, res) {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';
    try {
        if (pathname === '/' || pathname === '/index.html') {
            return sendHtml(res, HTML_PAGE);
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
    const server = http.createServer(handle);
    server.on('error', (e) => log.error('dashboard server error', e));
    server.listen(p, '0.0.0.0', () => {
        log.info(`Dashboard listening on http://0.0.0.0:${p}`);
    });
    return server;
}

module.exports = { start, buildSnapshot };
