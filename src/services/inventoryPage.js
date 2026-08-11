// Standalone HTML for the authenticated live inventory editor.
module.exports = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>qtbot — quản lý kho đồ</title>
<style>
  :root { --bg:#0f1419; --panel:#1a2027; --panel-2:#232b35; --border:#2f3a47;
    --text:#e6e6e6; --muted:#8a96a3; --accent:#4fc3f7; --good:#66bb6a; --bad:#ef5350; --warn:#ffb74d; }
  * { box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; margin:0; background:var(--bg); color:var(--text); padding:16px; }
  header { display:flex; align-items:center; gap:12px; margin-bottom:16px; flex-wrap:wrap; }
  h1 { margin:0; font-size:20px; } h2 { margin:0; font-size:15px; } h3 { margin:0 0 8px; color:var(--accent); font-size:13px; text-transform:uppercase; letter-spacing:.5px; }
  a { color:var(--accent); } .muted { color:var(--muted); font-size:13px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px; }
  .controls { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:14px; }
  input, select, button { background:var(--panel-2); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:8px 10px; font-size:13px; }
  input, select { min-width:180px; } button { cursor:pointer; } button:hover, input:focus, select:focus { border-color:var(--accent); outline:none; }
  button.primary { background:var(--accent); color:#0f1419; border:none; font-weight:600; }
  button.danger { color:var(--bad); border-color:var(--bad); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .layout { display:grid; grid-template-columns:minmax(250px,320px) minmax(0,1fr); gap:14px; align-items:start; }
  .players { max-height:calc(100vh - 180px); overflow:auto; padding:6px; }
  .player { display:block; width:100%; text-align:left; padding:9px; border:none; border-bottom:1px solid rgba(255,255,255,.05); border-radius:4px; }
  .player:hover, .player.active { background:#263442; }
  .player .name { display:block; font-weight:600; } .player .sub { display:block; color:var(--muted); font-size:11px; margin-top:2px; }
  .player .new { color:var(--warn); }
  .empty { color:var(--muted); font-size:13px; padding:12px; }
  .editor-head { display:flex; align-items:flex-start; gap:10px; flex-wrap:wrap; margin-bottom:12px; }
  .editor-head .actions { margin-left:auto; display:flex; gap:8px; }
  .summary { display:flex; gap:8px; flex-wrap:wrap; margin:8px 0 14px; }
  .pill { background:var(--panel-2); border:1px solid var(--border); border-radius:999px; padding:4px 9px; font-size:11px; color:var(--muted); }
  .sections { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:12px; }
  .section { background:rgba(0,0,0,.12); border:1px solid var(--border); border-radius:7px; padding:12px; }
  .field { display:grid; grid-template-columns:minmax(130px,1fr) minmax(110px,150px); align-items:center; gap:10px; padding:5px 0; border-bottom:1px solid rgba(255,255,255,.04); }
  .field:last-child { border-bottom:none; } .field label { font-size:12px; } .field small { display:block; color:var(--muted); font-family:ui-monospace,monospace; margin-top:2px; }
  .field input { width:100%; min-width:0; text-align:right; font-variant-numeric:tabular-nums; }
  .field.changed input { border-color:var(--warn); background:#332d22; }
  .change-badge { display:none; background:var(--warn); color:#0f1419; border-radius:999px; padding:2px 7px; font-size:10px; font-weight:700; }
  .err-banner { display:none; background:var(--bad); color:#fff; padding:12px; border-radius:8px; margin-bottom:14px; }
  .err-banner a { color:#fff; text-decoration:underline; }
  .toast { position:fixed; right:20px; bottom:20px; padding:12px 18px; border-radius:8px; font-size:13px; box-shadow:0 4px 14px rgba(0,0,0,.5); display:none; z-index:100; max-width:460px; }
  .toast.ok { background:var(--good); color:#0f1419; } .toast.err { background:var(--bad); color:#fff; }
  .hidden { display:none !important; }
  @media (max-width:780px) { .layout { grid-template-columns:1fr; } .players { max-height:260px; } .sections { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <h1>qtbot — quản lý kho đồ</h1>
  <span class="muted">· <a href="/">metrics</a> · <a href="/admin">kinh tế</a> · <a href="/ai">AI</a> · <a href="/status">VPS status</a> · <a href="/words">từ điển nối từ</a></span>
</header>

<div class="err-banner" id="errBanner">Chưa đăng nhập. Mở <a href="/admin">trang quản trị</a> để đăng nhập, rồi quay lại đây.</div>

<div id="app" class="hidden">
  <div class="controls">
    <label class="muted" for="guildSelect">Guild</label>
    <select id="guildSelect"></select>
    <input id="searchInput" placeholder="Tên, tag hoặc Discord ID">
    <button id="searchBtn">Tìm người chơi</button>
    <input id="directId" placeholder="Mở trực tiếp User ID">
    <button id="directBtn">Mở ID</button>
  </div>

  <div class="layout">
    <div class="card players" id="playerList"></div>
    <div class="card">
      <div id="noPlayer" class="empty">Chọn một người chơi để đọc và chỉnh toàn bộ kho đồ.</div>
      <div id="editor" class="hidden">
        <div class="editor-head">
          <div><h2 id="playerName">—</h2><div class="muted" id="playerMeta">—</div></div>
          <span class="change-badge" id="changeBadge"></span>
          <div class="actions">
            <button id="reloadBtn">↻ Tải lại</button>
            <button class="primary" id="saveBtn" disabled>Lưu thay đổi</button>
          </div>
        </div>
        <p class="muted">Các cột “khoá” được giữ riêng vì người chơi không thể tặng chúng. Chỉ những ô thực sự đổi mới được ghi vào bot.</p>
        <div class="summary" id="summary"></div>
        <div class="sections" id="fields"></div>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>
<script>
const $ = id => document.getElementById(id);
let META = null;
let CURRENT = null;
let CURRENT_PLAYER = null;

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
}
function fmt(value) { return Number(value || 0).toLocaleString('en-US'); }
function toast(message, ok) {
  const el = $('toast'); el.textContent = message; el.className = 'toast ' + (ok === false ? 'err' : 'ok'); el.style.display = 'block';
  clearTimeout(el._timer); el._timer = setTimeout(() => { el.style.display = 'none'; }, 4000);
}
async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers:{'Content-Type':'application/json'}, cache:'no-store' }, opts));
  let body = {}; try { body = await res.json(); } catch (e) {}
  if (!res.ok) { const err = new Error(body.error || ('HTTP ' + res.status)); err.status = res.status; throw err; }
  return body;
}
function selectedGuild() { return $('guildSelect').value; }

function renderPlayers(players) {
  if (!players.length) { $('playerList').innerHTML = '<div class="empty">Không tìm thấy người chơi. Có thể mở trực tiếp bằng User ID.</div>'; return; }
  $('playerList').innerHTML = players.map(p => '<button class="player' + (CURRENT && CURRENT.userId === p.userId ? ' active' : '') + '" data-id="' + escapeHtml(p.userId) + '">' +
    '<span class="name">' + escapeHtml(p.name) + '</span>' +
    '<span class="sub">' + escapeHtml(p.tag ? p.tag + ' · ' : '') + escapeHtml(p.userId) + (p.hasWallet ? '' : ' · <span class="new">chưa có kho</span>') + '</span></button>').join('');
  $('playerList').querySelectorAll('.player').forEach(btn => btn.addEventListener('click', () => openPlayer(btn.dataset.id)));
}

async function searchPlayers() {
  const gid = selectedGuild(); if (!gid) return renderPlayers([]);
  try {
    const result = await api('/api/admin/inventory/players?guildId=' + encodeURIComponent(gid) + '&q=' + encodeURIComponent($('searchInput').value.trim()));
    renderPlayers(result.players || []);
  } catch (e) { toast(e.message, false); }
}

function collectChanges() {
  const changes = {}, expected = {}, invalid = [];
  let dirty = 0;
  $('fields').querySelectorAll('input[data-path]').forEach(input => {
    if (input.value === input.dataset.orig) return;
    dirty++;
    const value = Number(input.value);
    if (input.value === '' || !input.validity.valid || !Number.isSafeInteger(value)) return invalid.push(input.dataset.path);
    changes[input.dataset.path] = value;
    expected[input.dataset.path] = Number(input.dataset.orig);
  });
  return { changes, expected, invalid, dirty };
}
function updateChanges() {
  const state = collectChanges();
  $('saveBtn').disabled = state.dirty === 0 || state.invalid.length > 0;
  $('changeBadge').style.display = state.dirty ? 'inline-block' : 'none';
  $('changeBadge').textContent = state.invalid.length ? state.invalid.length + ' giá trị không hợp lệ' : state.dirty + ' thay đổi';
  $('fields').querySelectorAll('input[data-path]').forEach(input => input.closest('.field').classList.toggle('changed', input.value !== input.dataset.orig));
}
function renderSummary() {
  const v = CURRENT.values;
  const walletNgoc = (v.ngoc || 0) + (v.lockedNgoc || 0);
  const bankNgoc = (v['bank.ngoc'] || 0) + (v['bank.locked'] || 0);
  const itemTotal = META.fields.filter(f => f.itemKey).reduce((sum, f) => sum + Number(v[f.path] || 0), 0);
  $('summary').innerHTML = '<span class="pill">Ví: ' + fmt(walletNgoc) + ' ngọc</span><span class="pill">Két: ' + fmt(bankNgoc) + ' ngọc</span><span class="pill">Ngân phiếu: ' + fmt(v.nganphieu) + '</span><span class="pill">Tổng vật phẩm: ' + fmt(itemTotal) + '</span>';
}
function renderEditor() {
  const groups = {};
  META.fields.forEach(field => (groups[field.group] = groups[field.group] || []).push(field));
  $('fields').innerHTML = Object.keys(groups).map(group => '<section class="section"><h3>' + escapeHtml(group) + '</h3>' + groups[group].map(field => {
    const value = CURRENT.values[field.path];
    return '<div class="field"><label>' + escapeHtml(field.label) + '<small>' + escapeHtml(field.path) + '</small></label>' +
      '<input type="number" step="1" ' + (field.allowNegative ? '' : 'min="0" ') + 'value="' + value + '" data-orig="' + value + '" data-path="' + escapeHtml(field.path) + '"></div>';
  }).join('') + '</section>').join('');
  $('fields').querySelectorAll('input').forEach(input => input.addEventListener('input', updateChanges));
  $('playerName').textContent = CURRENT_PLAYER.name;
  $('playerMeta').textContent = (CURRENT_PLAYER.tag ? CURRENT_PLAYER.tag + ' · ' : '') + CURRENT.userId + (CURRENT.existed ? '' : ' · kho mới');
  $('noPlayer').classList.add('hidden'); $('editor').classList.remove('hidden');
  renderSummary(); updateChanges();
}

async function openPlayer(userId) {
  if (!selectedGuild() || !userId) return;
  if (collectChanges().dirty && !confirm('Bỏ các thay đổi chưa lưu để mở người chơi khác?')) return;
  try {
    const result = await api('/api/admin/inventory/player?guildId=' + encodeURIComponent(selectedGuild()) + '&userId=' + encodeURIComponent(userId));
    CURRENT = result.inventory; CURRENT_PLAYER = result.player;
    renderEditor(); searchPlayers();
  } catch (e) { toast(e.message, false); }
}

async function saveInventory() {
  const payload = collectChanges();
  if (payload.invalid.length) return toast('Có giá trị trống, âm hoặc không phải số nguyên an toàn.', false);
  const paths = Object.keys(payload.changes);
  if (!paths.length) return;
  const preview = paths.slice(0, 8).map(path => path + ': ' + payload.expected[path] + ' → ' + payload.changes[path]).join('\\n');
  if (!confirm('Lưu ' + paths.length + ' thay đổi cho ' + CURRENT_PLAYER.name + '?\\n\\n' + preview + (paths.length > 8 ? '\\n…' : ''))) return;
  try {
    const result = await api('/api/admin/inventory/player', { method:'POST', body:JSON.stringify({ guildId:CURRENT.guildId, userId:CURRENT.userId, changes:payload.changes, expected:payload.expected }) });
    CURRENT = result.inventory; renderEditor(); searchPlayers();
    toast('Đã áp dụng ' + result.applied.length + ' thay đổi vào bot.');
  } catch (e) { toast(e.message, false); }
}

async function init() {
  try {
    META = await api('/api/admin/inventory/meta');
    $('guildSelect').innerHTML = META.guilds.map(g => '<option value="' + escapeHtml(g.id) + '">' + escapeHtml(g.name) + ' (' + escapeHtml(g.id) + ')</option>').join('');
    $('app').classList.remove('hidden');
    if (!META.guilds.length) $('playerList').innerHTML = '<div class="empty">Bot chưa có guild nào.</div>'; else await searchPlayers();
  } catch (e) {
    if (e.status === 401) $('errBanner').style.display = 'block'; else { $('errBanner').textContent = e.message; $('errBanner').style.display = 'block'; }
  }
}

$('searchBtn').addEventListener('click', searchPlayers);
$('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') searchPlayers(); });
$('guildSelect').addEventListener('change', () => {
  if (CURRENT && collectChanges().dirty && !confirm('Bỏ các thay đổi chưa lưu để đổi guild?')) { $('guildSelect').value = CURRENT.guildId; return; }
  CURRENT = null; CURRENT_PLAYER = null; $('editor').classList.add('hidden'); $('noPlayer').classList.remove('hidden'); searchPlayers();
});
$('directBtn').addEventListener('click', () => openPlayer($('directId').value.trim()));
$('directId').addEventListener('keydown', e => { if (e.key === 'Enter') $('directBtn').click(); });
$('reloadBtn').addEventListener('click', () => openPlayer(CURRENT && CURRENT.userId));
$('saveBtn').addEventListener('click', saveInventory);
window.addEventListener('beforeunload', e => { if (CURRENT && collectChanges().dirty) { e.preventDefault(); e.returnValue = ''; } });
init();
</script>
</body>
</html>`;
