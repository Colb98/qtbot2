// Standalone HTML for the authenticated AI provider control panel.
// Talks to /api/admin/ai/config, which the dashboard proxies to qtbot-ai.
module.exports = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>qtbot — AI providers</title>
<style>
  :root { --bg:#0f1419; --panel:#1a2027; --panel-2:#232b35; --border:#2f3a47;
    --text:#e6e6e6; --muted:#8a96a3; --accent:#4fc3f7; --good:#66bb6a; --bad:#ef5350; --warn:#ffb74d; }
  * { box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; margin:0; background:var(--bg); color:var(--text); padding:16px; max-width:900px; margin:0 auto; }
  header { display:flex; align-items:center; gap:12px; margin-bottom:16px; flex-wrap:wrap; }
  h1 { margin:0; font-size:20px; }
  a { color:var(--accent); } .muted { color:var(--muted); font-size:13px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px; margin-bottom:14px; }
  input, button { background:var(--panel-2); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:8px 10px; font-size:13px; }
  button { cursor:pointer; } button:hover, input:focus { border-color:var(--accent); outline:none; }
  button.primary { background:var(--accent); color:#0f1419; border:none; font-weight:600; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.5px; padding:6px 8px; border-bottom:1px solid var(--border); }
  td { padding:9px 8px; border-bottom:1px solid rgba(255,255,255,.05); vertical-align:middle; }
  tr:last-child td { border-bottom:none; }
  td.name { font-weight:600; }
  td.model input { width:100%; min-width:220px; font-family:ui-monospace,monospace; font-size:12px; }
  .ordbtn { padding:3px 8px; margin-right:2px; }
  .badge { border-radius:999px; padding:3px 9px; font-size:11px; font-weight:600; white-space:nowrap; }
  .badge.on { background:rgba(102,187,106,.15); color:var(--good); }
  .badge.off { background:rgba(239,83,80,.15); color:var(--bad); }
  .badge.cool { background:rgba(255,183,77,.15); color:var(--warn); }
  .badge.nocreds { background:var(--panel-2); color:var(--muted); }
  .row-disabled td.name, .row-disabled td.model { opacity:.45; }
  .actions { display:flex; gap:8px; align-items:center; margin-top:12px; }
  .err-banner { display:none; background:var(--bad); color:#fff; padding:12px; border-radius:8px; margin-bottom:14px; }
  .err-banner a { color:#fff; text-decoration:underline; }
  .toast { position:fixed; right:20px; bottom:20px; padding:12px 18px; border-radius:8px; font-size:13px; box-shadow:0 4px 14px rgba(0,0,0,.5); display:none; z-index:100; max-width:460px; }
  .toast.ok { background:var(--good); color:#0f1419; } .toast.err { background:var(--bad); color:#fff; }
  .hidden { display:none !important; }
</style>
</head>
<body>
<header>
  <h1>qtbot — AI providers</h1>
  <span class="muted">· <a href="/">metrics</a> · <a href="/admin">kinh tế</a> · <a href="/inventory">kho đồ</a> · <a href="/status">VPS status</a></span>
  <span id="svcBadge" class="badge nocreds" style="margin-left:auto">…</span>
</header>

<div class="err-banner" id="errBanner">Chưa đăng nhập. Mở <a href="/admin">trang quản trị</a> để đăng nhập, rồi quay lại đây.</div>
<div class="err-banner" id="offBanner">Không kết nối được <b>qtbot-ai</b> — service đang tắt hoặc chưa chạy (<code>pm2 start qtbot-ai</code>).</div>

<div id="app" class="hidden">
  <div class="card">
    <p class="muted" style="margin-top:0">Thứ tự trên–dưới = thứ tự ưu tiên (failover). Bỏ tick để loại provider khỏi chuỗi.
    Ô model trống = dùng mặc định (hiện trong placeholder). Thay đổi áp dụng ngay, không cần restart.</p>
    <table>
      <thead><tr><th></th><th>Dùng</th><th>Provider</th><th>Model</th><th>Trạng thái</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="actions">
      <button class="primary" id="saveBtn" disabled>Lưu thay đổi</button>
      <button id="reloadBtn">↻ Tải lại</button>
      <span class="muted" id="dirtyNote"></span>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let rows = [];        // [{name, enabled, modelInput, configured, health, fallbackModel}]
let dirty = false;
let statusTimer = null;

const $ = (id) => document.getElementById(id);

function toast(msg, ok) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast ' + (ok ? 'ok' : 'err'); t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 3500);
}

function setDirty(d) {
  dirty = d;
  $('saveBtn').disabled = !d;
  $('dirtyNote').textContent = d ? 'Có thay đổi chưa lưu' : '';
}

function healthBadge(p) {
  if (!p.configured) return '<span class="badge nocreds">chưa có API key</span>';
  if (!p.health.healthy) {
    const secs = p.health.cooldownUntil ? Math.max(0, Math.round((p.health.cooldownUntil - Date.now()) / 1000)) : 0;
    return '<span class="badge cool">nghỉ ' + secs + 's — ' + (p.health.lastFailure || '?') + '</span>';
  }
  return '<span class="badge on">sẵn sàng</span>';
}

function render() {
  const tb = $('rows');
  tb.innerHTML = '';
  rows.forEach((p, i) => {
    const tr = document.createElement('tr');
    if (!p.enabled) tr.className = 'row-disabled';
    tr.innerHTML =
      '<td><button class="ordbtn" data-up="' + i + '" ' + (i === 0 ? 'disabled' : '') + '>↑</button>' +
      '<button class="ordbtn" data-down="' + i + '" ' + (i === rows.length - 1 ? 'disabled' : '') + '>↓</button></td>' +
      '<td><input type="checkbox" data-en="' + i + '" ' + (p.enabled ? 'checked' : '') + ' ' + (p.configured ? '' : 'disabled') + '></td>' +
      '<td class="name">' + p.name + '</td>' +
      '<td class="model"><input data-model="' + i + '" value="' + p.modelInput.replace(/"/g, '&quot;') + '" placeholder="' + p.fallbackModel + '"></td>' +
      '<td data-status="' + p.name + '">' + healthBadge(p) + '</td>';
    tb.appendChild(tr);
  });
}

document.addEventListener('click', (e) => {
  const up = e.target.dataset && e.target.dataset.up, down = e.target.dataset && e.target.dataset.down;
  if (up !== undefined && up !== '') { const i = +up; [rows[i-1], rows[i]] = [rows[i], rows[i-1]]; setDirty(true); render(); }
  if (down !== undefined && down !== '') { const i = +down; [rows[i], rows[i+1]] = [rows[i+1], rows[i]]; setDirty(true); render(); }
});
document.addEventListener('change', (e) => {
  const en = e.target.dataset && e.target.dataset.en;
  if (en !== undefined && en !== '') { rows[+en].enabled = e.target.checked; setDirty(true); render(); }
});
document.addEventListener('input', (e) => {
  const m = e.target.dataset && e.target.dataset.model;
  if (m !== undefined && m !== '') { rows[+m].modelInput = e.target.value; setDirty(true); }
});

function applySnapshot(snap) {
  // Enabled providers first, in effective order; the rest follow.
  const byName = Object.fromEntries(snap.providers.map((p) => [p.name, p]));
  const ordered = snap.order.filter((n) => byName[n]).concat(snap.providers.map((p) => p.name).filter((n) => !snap.order.includes(n)));
  rows = ordered.map((n) => {
    const p = byName[n];
    return { name: n, enabled: snap.order.includes(n) && p.configured, modelInput: p.override || '',
             configured: p.configured, health: p.health, fallbackModel: p.fallbackModel };
  });
  setDirty(false);
  render();
}

async function load() {
  const res = await fetch('/api/admin/ai/config');
  if (res.status === 401) { $('errBanner').style.display = 'block'; return; }
  if (!res.ok) { $('offBanner').style.display = 'block'; $('svcBadge').textContent = 'qtbot-ai OFFLINE'; $('svcBadge').className = 'badge off'; return; }
  $('offBanner').style.display = 'none';
  $('svcBadge').textContent = 'qtbot-ai OK'; $('svcBadge').className = 'badge on';
  $('app').classList.remove('hidden');
  applySnapshot(await res.json());
  if (!statusTimer) statusTimer = setInterval(refreshStatus, 5000);
}

// Status-only refresh: never clobbers unsaved order/model edits.
async function refreshStatus() {
  try {
    const res = await fetch('/api/admin/ai/config');
    if (!res.ok) throw new Error();
    const snap = await res.json();
    $('svcBadge').textContent = 'qtbot-ai OK'; $('svcBadge').className = 'badge on';
    const byName = Object.fromEntries(snap.providers.map((p) => [p.name, p]));
    for (const r of rows) {
      if (!byName[r.name]) continue;
      r.health = byName[r.name].health; r.configured = byName[r.name].configured;
      const cell = document.querySelector('[data-status="' + r.name + '"]');
      if (cell) cell.innerHTML = healthBadge(r);
    }
  } catch (_) {
    $('svcBadge').textContent = 'qtbot-ai OFFLINE'; $('svcBadge').className = 'badge off';
  }
}

$('saveBtn').addEventListener('click', async () => {
  const order = rows.filter((r) => r.enabled).map((r) => r.name);
  if (!order.length) return toast('Phải bật ít nhất một provider.', false);
  const models = {};
  for (const r of rows) models[r.name] = r.modelInput.trim();
  const res = await fetch('/api/admin/ai/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerOrder: order, models }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return toast(body.error || 'Lưu thất bại.', false);
  applySnapshot(body);
  toast('Đã lưu — áp dụng ngay.', true);
});
$('reloadBtn').addEventListener('click', load);

load();
</script>
</body>
</html>`;
