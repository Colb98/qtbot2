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
  td.model input { width:100%; min-width:160px; font-family:ui-monospace,monospace; font-size:12px; }
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
  h2 { font-size:15px; margin:0 0 10px; }
  .mono { font-family:ui-monospace,monospace; font-size:12px; }
  .tiles { display:flex; flex-wrap:wrap; gap:10px; }
  .tile { background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:10px 14px; min-width:104px; }
  .tile .v { font-size:20px; font-weight:700; }
  .tile .k { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.5px; margin-top:2px; }
  tr[data-tid] { cursor:pointer; }
  tr[data-tid]:hover td { background:rgba(79,195,247,.05); }
  td.steps-cell { max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  td.trace-detail { background:var(--panel-2); }
  .trace-head { display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding-bottom:4px; }
  button.tiny { padding:3px 9px; font-size:11px; }
  .stepline { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; padding:7px 0; border-bottom:1px solid rgba(255,255,255,.05); }
  .stepline:last-child { border-bottom:none; }
  .stepline b { text-transform:uppercase; font-size:12px; letter-spacing:.5px; }
  .pill { display:inline-block; border-radius:999px; padding:2px 9px; font-size:11px; font-weight:600; white-space:nowrap; cursor:default; }
  .pill.perr { background:rgba(239,83,80,.15); color:var(--bad); }
  .pill.pok { background:rgba(102,187,106,.15); color:var(--good); }
  .stepline pre { white-space:pre-wrap; word-break:break-word; background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:8px; margin:6px 0 0; max-height:260px; overflow:auto; font-size:12px; width:100%; }
  .mem-group { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.5px; margin:12px 0 4px; }
  .mem-row { display:flex; gap:10px; align-items:baseline; padding:7px 6px; border-bottom:1px solid rgba(255,255,255,.05); cursor:pointer; }
  .mem-row:hover { background:rgba(79,195,247,.05); }
  .mem-row .file { font-family:ui-monospace,monospace; font-size:12px; white-space:nowrap; }
  .mem-row .preview { color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
  .mem-row .size { color:var(--muted); font-size:11px; white-space:nowrap; }
  #memEditor textarea { width:100%; min-height:220px; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:10px; font-family:ui-monospace,monospace; font-size:12px; resize:vertical; }
  #memEditor .actions { margin-top:8px; }
  button.danger { background:rgba(239,83,80,.15); color:var(--bad); border-color:var(--bad); }
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
    Ô model trống = dùng mặc định (hiện trong placeholder). "Model nhanh" phục vụ bước phân loại/kiểm tra
    (nên chọn bản instruct không suy nghĩ); trống = dùng model chính. Thay đổi áp dụng ngay, không cần restart.</p>
    <table>
      <thead><tr><th></th><th>Dùng</th><th>Provider</th><th>Model chính</th><th>Model nhanh</th><th>Trạng thái</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="actions">
      <button class="primary" id="saveBtn" disabled>Lưu thay đổi</button>
      <button id="reloadBtn">↻ Tải lại</button>
      <span class="muted" id="dirtyNote"></span>
    </div>
  </div>

  <div class="card">
    <h2>Tạo ảnh <span class="badge" id="imgUsableBadge"></span></h2>
    <p class="muted" style="margin-top:6px">Bot vẽ hình khi thành viên nhờ (tool <span class="mono">[[image]]</span>).
    Ô model trống = mặc định của provider (hiện trong placeholder). Giới hạn/ngày tính chung cả server,
    đếm theo thống kê nên restart không reset. Thay đổi áp dụng ngay.</p>
    <table>
      <thead><tr><th>Provider</th><th>Model ảnh</th><th>Giới hạn/ngày</th><th>Hôm nay</th></tr></thead>
      <tbody><tr>
        <td><select id="imgProvider"></select></td>
        <td class="model"><input id="imgModel" list="models-image"><datalist id="models-image"></datalist></td>
        <td><input id="imgLimit" type="number" min="0" max="10000" style="width:90px"></td>
        <td class="muted" id="imgUsed">—</td>
      </tr></tbody>
    </table>
    <div class="actions">
      <button class="primary" id="imgSaveBtn">Lưu tạo ảnh</button>
      <span class="muted" id="imgNote"></span>
    </div>
  </div>

  <div class="card">
    <h2>Thống kê hôm nay</h2>
    <div class="tiles" id="tiles"></div>
    <table style="margin-top:12px">
      <thead><tr><th>Provider</th><th>Requests</th><th>Lỗi</th><th>429</th><th>Fallback</th><th>Latency TB</th><th>Tokens in / out</th></tr></thead>
      <tbody id="provRows"></tbody>
    </table>
  </div>

  <div class="card">
    <h2>Yêu cầu gần đây <span class="muted" style="font-weight:400">— bấm vào dòng để xem từng bước (nghĩ / tìm / đọc / trả lời); mất khi service restart</span></h2>
    <table>
      <thead><tr><th>Lúc</th><th>Người dùng</th><th>Kênh</th><th>Các bước</th><th>Tổng</th><th>Tokens in / out</th><th>Kết quả</th></tr></thead>
      <tbody id="traceRows"></tbody>
    </table>
    <p class="muted" id="traceEmpty" style="display:none;margin-bottom:0">Chưa có yêu cầu nào từ khi service khởi động.</p>
  </div>

  <div class="card">
    <h2>Trí nhớ dài hạn <span class="muted" style="font-weight:400">— bấm vào file để xem/sửa; file là markdown thuần</span>
      <button id="memReloadBtn" style="float:right">↻</button></h2>
    <div id="memList"></div>
    <p class="muted" id="memEmpty" style="display:none;margin-bottom:0">Bot chưa ghi nhớ gì.</p>
    <div id="memEditor" class="hidden">
      <p class="mono" id="memFileName" style="margin:12px 0 6px"></p>
      <textarea id="memText"></textarea>
      <div class="actions">
        <button class="primary" id="memSaveBtn">Lưu</button>
        <button class="danger" id="memDeleteBtn">Xoá file</button>
        <button id="memCloseBtn">Đóng</button>
        <span class="muted" id="memNote"></span>
      </div>
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
      '<td class="model"><input data-model="' + i + '" list="models-' + p.name + '" value="' + p.modelInput.replace(/"/g, '&quot;') + '" placeholder="' + p.fallbackModel + '">' +
      '<datalist id="models-' + p.name + '"></datalist></td>' +
      '<td class="model"><input data-fastmodel="' + i + '" list="models-' + p.name + '" value="' + p.fastInput.replace(/"/g, '&quot;') + '" placeholder="' + p.fallbackFastModel + '"></td>' +
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
  const fm = e.target.dataset && e.target.dataset.fastmodel;
  if (fm !== undefined && fm !== '') { rows[+fm].fastInput = e.target.value; setDirty(true); }
});

// Model combo-box: on first focus of a model input, fetch the provider's real
// model list (service proxies GET {base}/models) into its datalist. Free text
// still works — the list is a helper, not a constraint. Failure = plain input.
const modelLists = {}; // provider -> [ids]
document.addEventListener('focusin', async (e) => {
  const m = (e.target.dataset && e.target.dataset.model) ?? (e.target.dataset && e.target.dataset.fastmodel);
  if (m === undefined || m === '') return;
  const name = rows[+m] && rows[+m].name;
  const dl = name && document.getElementById('models-' + name);
  if (!dl || dl.children.length) return;
  try {
    if (!modelLists[name]) {
      const res = await fetch('/api/admin/ai/models?provider=' + encodeURIComponent(name));
      if (!res.ok) return;
      modelLists[name] = (await res.json()).models || [];
    }
    modelLists[name].forEach((id) => {
      const o = document.createElement('option');
      o.value = id;
      dl.appendChild(o);
    });
  } catch (_) { /* keep free-text input */ }
});

function applySnapshot(snap) {
  // Enabled providers first, in effective order; the rest follow.
  const byName = Object.fromEntries(snap.providers.map((p) => [p.name, p]));
  const ordered = snap.order.filter((n) => byName[n]).concat(snap.providers.map((p) => p.name).filter((n) => !snap.order.includes(n)));
  rows = ordered.map((n) => {
    const p = byName[n];
    return { name: n, enabled: snap.order.includes(n) && p.configured, modelInput: p.override || '',
             fastInput: p.fastOverride || '', fallbackFastModel: p.fallbackFastModel || p.fallbackModel,
             configured: p.configured, health: p.health, fallbackModel: p.fallbackModel };
  });
  setDirty(false);
  render();
  renderImage(snap.image);
}

// ---- Tạo ảnh: provider select + model combo (kind=image) + daily limit ----
let imgSnap = null;
function renderImage(img) {
  imgSnap = img || null;
  const badge = $('imgUsableBadge');
  if (!img || !img.providers || !img.providers.length) {
    badge.textContent = 'không có provider hỗ trợ'; badge.className = 'badge nocreds';
    $('imgProvider').innerHTML = ''; $('imgUsed').textContent = '—';
    return;
  }
  badge.textContent = img.usable ? 'đang bật' : 'tắt (AI_IMAGE_ENABLED)';
  badge.className = img.usable ? 'badge on' : 'badge off';
  const sel = $('imgProvider');
  sel.innerHTML = '';
  img.providers.forEach((n) => {
    const o = document.createElement('option');
    o.value = n; o.textContent = n + (n === img.fallbackProvider && !img.providerOverride ? ' (mặc định)' : '');
    if (n === img.provider) o.selected = true;
    sel.appendChild(o);
  });
  $('imgModel').value = img.modelOverride || '';
  $('imgModel').placeholder = img.fallbackModel || '';
  $('imgLimit').value = img.dailyLimit;
  $('imgUsed').textContent = img.usedToday + ' / ' + img.dailyLimit;
}

// Model list depends on BOTH the chosen provider and kind=image — refill the
// datalist when the provider changes, fetch lazily on focus like the chat combos.
$('imgProvider').addEventListener('change', () => {
  document.getElementById('models-image').innerHTML = '';
  $('imgModel').placeholder = ''; // real fallback returns on save/reload
});
$('imgModel').addEventListener('focus', async () => {
  const dl = document.getElementById('models-image');
  if (dl.children.length) return;
  try {
    const res = await fetch('/api/admin/ai/models?provider=' + encodeURIComponent($('imgProvider').value) + '&kind=image');
    if (!res.ok) return;
    ((await res.json()).models || []).forEach((id) => {
      const o = document.createElement('option');
      o.value = id;
      dl.appendChild(o);
    });
  } catch (_) { /* keep free-text input */ }
});

$('imgSaveBtn').addEventListener('click', async () => {
  const limit = $('imgLimit').value.trim();
  const res = await fetch('/api/admin/ai/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: {
      provider: $('imgProvider').value || '',
      model: $('imgModel').value.trim(),
      dailyLimit: limit === '' ? null : +limit,
    } }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return toast(body.error || 'Lưu thất bại.', false);
  applySnapshot(body);
  toast('Đã lưu cài đặt tạo ảnh.', true);
});

// ---- Thống kê + nhật ký yêu cầu (chỉ đọc, làm mới cùng nhịp 5s) ----
// Mọi text từ service (thinking, kết quả tool, tên người dùng) đi qua
// textContent — tuyệt đối không innerHTML với dữ liệu LLM/web.
let expandedTraceId = null;

function makeEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function fmtMs(ms) {
  if (ms == null) return '—';
  return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
}
function fmtTime(ts) {
  return new Date(ts).toLocaleString('vi-VN', { hour12: false });
}

function renderMetrics(m) {
  const d = m.today || {};
  const tiles = $('tiles');
  tiles.innerHTML = '';
  const add = (k, v) => {
    const t = makeEl('div', 'tile');
    t.appendChild(makeEl('div', 'v', v == null ? '—' : String(v)));
    t.appendChild(makeEl('div', 'k', k));
    tiles.appendChild(t);
  };
  add('Tin nhắn', d.messages || 0);
  add('Lỗi', d.errors || 0);
  add('Latency TB', d.latencyCount ? fmtMs(Math.round(d.latencyMs / d.latencyCount)) : null);
  add('Tìm web', d.searches || 0);
  add('Trang đã đọc', d.pagesRead || 0);
  add('Trả lời ngay', d.classifyImmediate || 0);
  add('Social', d.classifySocial || 0);
  add('Phân tích', d.classifyThink || 0);
  add('Tra cứu sâu', d.classifyResearch || 0);
  add('Bước nghĩ', d.thinkSteps || 0);
  add('Tra từ điển', d.docInjections || 0);
  add('Ảnh đã vẽ', d.imagesGenerated || 0);
  add('Verifier chặn', d.verifyFails || 0);
  add('Nén hội thoại', d.compactions || 0);
  add('Ghi nhớ', d.memoryWrites || 0);
  const tb = $('provRows');
  tb.innerHTML = '';
  Object.keys(d.providers || {}).forEach((name) => {
    const p = d.providers[name];
    const r = makeEl('tr');
    r.appendChild(makeEl('td', 'name', name));
    r.appendChild(makeEl('td', null, String(p.requests)));
    r.appendChild(makeEl('td', null, String(p.errors)));
    r.appendChild(makeEl('td', null, String(p.rateLimited)));
    r.appendChild(makeEl('td', null, String(p.fallbacks)));
    r.appendChild(makeEl('td', null, p.latencyCount ? fmtMs(Math.round(p.latencyMs / p.latencyCount)) : '—'));
    r.appendChild(makeEl('td', 'mono', (p.tokensIn || 0) + ' / ' + (p.tokensOut || 0)));
    tb.appendChild(r);
  });
}

function statusBadgeCls(status) {
  return status === 'ok' ? 'badge on' : status === 'running' ? 'badge cool' : 'badge off';
}

function renderTraceList(list) {
  if (expandedTraceId) return; // never snap an open detail shut mid-read
  $('traceEmpty').style.display = list.length ? 'none' : 'block';
  const tb = $('traceRows');
  tb.innerHTML = '';
  list.forEach((t) => {
    const row = makeEl('tr');
    row.dataset.tid = t.id;
    row.appendChild(makeEl('td', 'muted', fmtTime(t.startedAt)));
    row.appendChild(makeEl('td', null, t.name || t.userId));
    row.appendChild(makeEl('td', 'muted mono', t.sessionKey));
    row.appendChild(makeEl('td', 'mono steps-cell', t.steps || '—'));
    row.appendChild(makeEl('td', null, fmtMs(t.totalMs)));
    // Total LLM tokens this request across ALL steps (classify + analyze +
    // generations + craft...), summed service-side by trace.list().
    row.appendChild(makeEl('td', 'mono', (t.tokensIn || t.tokensOut) ? (t.tokensIn || 0) + ' / ' + (t.tokensOut || 0) : '—'));
    const st = makeEl('td');
    st.appendChild(makeEl('span', statusBadgeCls(t.status), t.status));
    row.appendChild(st);
    tb.appendChild(row);
  });
}

function stepMeta(s) {
  // Provider chain is rendered as pills (see providerPills) — not here.
  const bits = [];
  if (s.model) bits.push(s.model);
  if (s.result) bits.push('→ ' + s.result);
  if (s.reason && s.reason !== 'classified') bits.push(s.reason);
  if (s.query) bits.push('"' + s.query + '"');
  if (s.backends && s.backends.length) bits.push(s.backends.join(', '));
  if (s.results != null) bits.push(s.results + ' kết quả' + (s.fresh != null ? ' (' + s.fresh + ' mới)' : ''));
  if (s.stale) bits.push('⚠ trùng nguồn cũ');
  if (s.planned != null) bits.push('kế hoạch ' + s.planned + ' truy vấn');
  if (s.pages) bits.push('trang ' + s.pages.join(','));
  if (s.fetched != null) bits.push('đọc được ' + s.fetched + '/' + s.total);
  if (s.style) bits.push('style: ' + s.style);
  if (s.note) bits.push('ghi nhớ: "' + s.note + '"');
  if (s.tokensIn != null) bits.push('tokens ' + s.tokensIn + ' → ' + s.tokensOut);
  if (s.chars != null) bits.push(s.chars + ' ký tự');
  return bits.join(' · ');
}

function shortErr(msg) {
  const m = /HTTP \\d+/.exec(msg || '');
  if (m) return m[0];
  if (/timeout/i.test(msg || '')) return 'timeout';
  if (/empty completion/.test(msg || '')) return 'empty';
  return String(msg || '?').slice(0, 24);
}

// The failover chain of one step: red pill per failed attempt (full error in
// the tooltip), green pill for the provider that finally served it.
function providerPills(s) {
  const pills = [];
  (s.attempts || []).forEach((a) => {
    const provider = a && a.provider ? a.provider : '?';
    const error = a && a.error ? a.error : String(a);
    const p = makeEl('span', 'pill perr', '✗ ' + provider + ' · ' + shortErr(error));
    p.title = error;
    pills.push(p);
  });
  if (s.provider) pills.push(makeEl('span', 'pill pok', '✓ ' + s.provider));
  return pills;
}

// One trace as a minified JSON debug dump: everything the detail view shows
// (including step detail text — that IS the debugging meat), minus what nobody
// reads back (absolute per-step timestamps, null/empty fields, the routing ids).
// Minified on purpose: this gets pasted into a chat or an issue, where pretty
// whitespace is dead weight.
const TRACE_DROP_KEYS = ['startedAt'];

function compactSteps(steps) {
  return (steps || []).map((s) => {
    const o = {};
    Object.keys(s).forEach((k) => {
      const v = s[k];
      if (TRACE_DROP_KEYS.indexOf(k) >= 0) return;
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
      o[k] = v;
    });
    return o;
  });
}

function traceDebugJson(t) {
  const payload = {
    id: t.id,
    at: new Date(t.startedAt).toISOString(),
    session: t.sessionKey,
    user: t.name || t.userId,
    status: t.status,
    totalMs: t.totalMs,
    userChars: t.userChars,
    replyChars: t.replyChars,
    error: t.error,
    steps: compactSteps(t.steps),
  };
  Object.keys(payload).forEach((k) => { if (payload[k] == null) delete payload[k]; });
  return JSON.stringify(payload);
}

// Clipboard API needs a secure context; this panel is often served over plain
// http on the VPS, so fall back to the execCommand trick rather than failing.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

function buildTraceDetail(t) {
  const box = makeEl('div');
  const head = makeEl('div', 'trace-head');
  head.appendChild(makeEl('span', 'muted',
    t.sessionKey + ' · ' + (t.name || t.userId) + ' · hỏi ' + t.userChars + ' ký tự' +
    (t.replyChars != null ? ' · trả lời ' + t.replyChars + ' ký tự' : '') +
    (t.error ? ' · lỗi: ' + t.error : '')));
  const copyBtn = makeEl('button', 'tiny', '📋 Copy JSON');
  copyBtn.title = 'Copy toàn bộ trace (JSON nén 1 dòng) để dán đi debug';
  copyBtn.addEventListener('click', async () => {
    const json = traceDebugJson(t);
    const ok = await copyText(json);
    copyBtn.textContent = ok ? '✓ Đã copy' : '✗ Copy lỗi';
    setTimeout(() => { copyBtn.textContent = '📋 Copy JSON'; }, 1800);
    toast(ok ? 'Đã copy trace ' + t.id + ' (' + json.length + ' ký tự JSON).'
             : 'Trình duyệt chặn clipboard — thử lại trên https hoặc copy tay.', ok);
  });
  head.appendChild(copyBtn);
  box.appendChild(head);
  (t.steps || []).forEach((s) => {
    const line = makeEl('div', 'stepline');
    line.appendChild(makeEl('span', s.ok === false ? 'badge off' : 'badge on', s.ok === false ? '✗' : '✓'));
    line.appendChild(makeEl('b', null, s.type));
    line.appendChild(makeEl('span', 'muted', fmtMs(s.ms)));
    providerPills(s).forEach((p) => line.appendChild(p));
    const meta = stepMeta(s);
    if (meta) line.appendChild(makeEl('span', 'muted', meta));
    if (s.detail) line.appendChild(makeEl('pre', null, s.detail));
    box.appendChild(line);
  });
  return box;
}

document.addEventListener('click', async (e) => {
  const row = e.target.closest ? e.target.closest('tr[data-tid]') : null;
  if (!row) return;
  const tid = row.dataset.tid;
  const open = document.getElementById('traceDetailRow');
  if (open) open.remove();
  if (expandedTraceId === tid) { expandedTraceId = null; refreshExtras(); return; }
  expandedTraceId = tid;
  try {
    const res = await fetch('/api/admin/ai/traces?id=' + encodeURIComponent(tid));
    if (!res.ok) { expandedTraceId = null; return toast('Không tải được chi tiết (trace đã bị đẩy khỏi bộ nhớ?).', false); }
    const detail = makeEl('tr');
    detail.id = 'traceDetailRow';
    const td = makeEl('td', 'trace-detail');
    td.colSpan = 7; // trace table now includes the Tokens column
    td.appendChild(buildTraceDetail(await res.json()));
    detail.appendChild(td);
    row.after(detail);
  } catch (_) {
    expandedTraceId = null;
  }
});

// ---- Trí nhớ dài hạn: tải khi mở trang / bấm ↻, KHÔNG nằm trong poll 5s
// (đang sửa mà bị vẽ lại là mất nội dung). Text là dữ liệu LLM → textContent.
let memOpenFile = null;

function renderMemList(files) {
  const box = $('memList');
  box.innerHTML = '';
  $('memEmpty').style.display = files.length ? 'none' : 'block';
  [['server', 'Server'], ['channel', 'Kênh'], ['user', 'Thành viên']].forEach((g) => {
    const items = files.filter((f) => f.scope === g[0]);
    if (!items.length) return;
    box.appendChild(makeEl('div', 'mem-group', g[1]));
    items.forEach((f) => {
      const row = makeEl('div', 'mem-row');
      row.dataset.mfile = f.file;
      row.appendChild(makeEl('span', 'file', f.file));
      row.appendChild(makeEl('span', 'preview', f.preview || '(trống)'));
      row.appendChild(makeEl('span', 'size', f.size + ' ký tự'));
      box.appendChild(row);
    });
  });
}

async function loadMemList() {
  try {
    const res = await fetch('/api/admin/ai/memory');
    if (res.ok) renderMemList((await res.json()).files || []);
  } catch (_) { /* transient */ }
}

document.addEventListener('click', async (e) => {
  const row = e.target.closest ? e.target.closest('.mem-row') : null;
  if (!row) return;
  try {
    const res = await fetch('/api/admin/ai/memory?file=' + encodeURIComponent(row.dataset.mfile));
    if (!res.ok) return toast('Không đọc được file.', false);
    const body = await res.json();
    memOpenFile = body.file;
    $('memFileName').textContent = body.file;
    $('memText').value = body.content;
    $('memEditor').classList.remove('hidden');
  } catch (_) { toast('Không đọc được file.', false); }
});

$('memSaveBtn').addEventListener('click', async () => {
  if (!memOpenFile) return;
  const res = await fetch('/api/admin/ai/memory', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: memOpenFile, content: $('memText').value }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return toast(body.error || 'Lưu thất bại.', false);
  renderMemList(body.files || []);
  toast('Đã lưu trí nhớ.', true);
});

$('memDeleteBtn').addEventListener('click', async () => {
  if (!memOpenFile) return;
  if (!confirm('Xoá hẳn ' + memOpenFile + '? Bot sẽ quên nội dung này.')) return;
  const res = await fetch('/api/admin/ai/memory', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: memOpenFile }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return toast(body.error || 'Xoá thất bại.', false);
  memOpenFile = null;
  $('memEditor').classList.add('hidden');
  renderMemList(body.files || []);
  toast('Đã xoá.', true);
});

$('memCloseBtn').addEventListener('click', () => {
  memOpenFile = null;
  $('memEditor').classList.add('hidden');
});
$('memReloadBtn').addEventListener('click', loadMemList);

async function refreshExtras() {
  try {
    const both = await Promise.all([fetch('/api/admin/ai/metrics'), fetch('/api/admin/ai/traces')]);
    if (both[0].ok) renderMetrics(await both[0].json());
    if (both[1].ok) renderTraceList((await both[1].json()).traces || []);
  } catch (_) { /* transient — nhịp sau thử lại */ }
}

async function load() {
  const res = await fetch('/api/admin/ai/config');
  if (res.status === 401) { $('errBanner').style.display = 'block'; return; }
  if (!res.ok) { $('offBanner').style.display = 'block'; $('svcBadge').textContent = 'qtbot-ai OFFLINE'; $('svcBadge').className = 'badge off'; return; }
  $('offBanner').style.display = 'none';
  $('svcBadge').textContent = 'qtbot-ai OK'; $('svcBadge').className = 'badge on';
  $('app').classList.remove('hidden');
  applySnapshot(await res.json());
  refreshExtras();
  loadMemList();
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
    // Status-only for the image card too: quota ticker, never the inputs.
    if (snap.image) $('imgUsed').textContent = snap.image.usedToday + ' / ' + snap.image.dailyLimit;
    refreshExtras();
  } catch (_) {
    $('svcBadge').textContent = 'qtbot-ai OFFLINE'; $('svcBadge').className = 'badge off';
  }
}

$('saveBtn').addEventListener('click', async () => {
  const order = rows.filter((r) => r.enabled).map((r) => r.name);
  if (!order.length) return toast('Phải bật ít nhất một provider.', false);
  const models = {};
  const fastModels = {};
  for (const r of rows) { models[r.name] = r.modelInput.trim(); fastModels[r.name] = r.fastInput.trim(); }
  const res = await fetch('/api/admin/ai/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerOrder: order, models, fastModels }),
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
