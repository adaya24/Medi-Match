/* app.js — shared utilities */
const API = '';

function getToken() { return localStorage.getItem('mm_token'); }
function getUser()  { return JSON.parse(localStorage.getItem('mm_user') || 'null'); }
function isAdmin()  { return getUser()?.role === 'admin'; }

function requireAuth(adminOnly = false) {
  const token = getToken(), user = getUser();
  if (!token || !user) { window.location.href = 'login.html'; return false; }
  if (adminOnly && !isAdmin()) { window.location.href = 'emergency.html'; return false; }
  return true;
}

function logout() {
  localStorage.removeItem('mm_token');
  localStorage.removeItem('mm_user');
  window.location.href = 'login.html';
}

async function apiFetch(url, options = {}) {
  const token = getToken();
  const res = await fetch(API + url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) { logout(); return null; }
  return res.json();
}

const http = {
  get:   url        => apiFetch(url),
  post:  (url, body) => apiFetch(url, { method: 'POST',  body }),
  patch: (url, body) => apiFetch(url, { method: 'PATCH', body }),
};

function renderSidebar() {
  const user = getUser(); if (!user) return;
  const badge = document.getElementById('userBadge');
  if (badge) badge.innerHTML = `<strong>${user.full_name || user.username}</strong><span class="role-pill ${user.role}">${user.role}</span>`;
  document.querySelectorAll('[data-role="admin"]').forEach(el => { el.style.display = isAdmin() ? '' : 'none'; });
  const cur = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-link').forEach(a => a.classList.toggle('active', a.getAttribute('href') === cur));
}

let socket = null;
function initSocket(handlers = {}) {
  if (typeof io === 'undefined') return;
  socket = io(window.location.origin, { auth: { token: getToken() } });
  socket.on('connect',    () => setLive(true));
  socket.on('disconnect', () => setLive(false));
  Object.entries(handlers).forEach(([e, fn]) => socket.on(e, fn));
  return socket;
}
function setLive(on) {
  const dot  = document.getElementById('liveIndicator');
  const text = document.getElementById('liveText');
  if (dot)  dot.style.background = on ? '#4ade80' : '#f59e0b';
  if (text) text.textContent      = on ? 'Live' : 'Reconnecting…';
}

function startClock() {
  const tick = () => { const el = document.getElementById('clockDisplay'); if (el) el.textContent = new Date().toLocaleTimeString(); };
  tick(); setInterval(tick, 1000);
}

const logLines = [];
function addLog(msg) {
  logLines.unshift(`[${new Date().toTimeString().slice(0,8)}] ${msg}`);
  if (logLines.length > 60) logLines.pop();
  const el = document.getElementById('algoLog');
  if (el) el.innerHTML = logLines.slice(0, 14).map(l => `<div class="algo-log-line">${l}</div>`).join('');
}

function triageBadge(cat) {
  const cls = { red:'badge-red', yellow:'badge-amber', green:'badge-green' }[cat] || 'badge-muted';
  const label = cat ? cat.charAt(0).toUpperCase() + cat.slice(1) : '—';
  return `<span class="badge ${cls}">${label}</span>`;
}

function statusBadge(status) {
  const map = { available:'badge-green', 'en-route':'badge-blue', dispatched:'badge-amber', 'at-hospital':'badge-purple', waiting:'badge-amber', admitted:'badge-green', 'in-transit':'badge-blue', assigned:'badge-blue', critical:'badge-red', operational:'badge-green', pending:'badge-amber', fulfilled:'badge-green', cancelled:'badge-muted', planned:'badge-blue', };
  return `<span class="badge ${map[status]||'badge-muted'}">${status||'—'}</span>`;
}

function bedBar(label, used, total, color) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  return `<div class="progress-wrap">
    <div class="progress-header"><span>${label}</span><span>${used}/${total} (${pct}%)</span></div>
    <div class="progress-bar"><div class="progress-fill" style="width:${pct}%;background:${color}"></div></div>
  </div>`;
}

function toast(msg, type = 'info') {
  const colors = { info:'#2563eb', success:'#16a34a', error:'#dc2626', warn:'#d97706' };
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;bottom:20px;right:20px;background:#fff;border-left:4px solid ${colors[type]};
    color:#1a1a2e;padding:11px 16px;border-radius:6px;font-size:13px;font-family:inherit;
    z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.12);max-width:320px;animation:slideUp 0.2s ease-out`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function openModal(id)  { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
document.addEventListener('click', e => { if (e.target.classList.contains('modal-overlay')) e.target.style.display = 'none'; });

let map = null, mapMarkers = {};
function initMap(lat = 28.6139, lng = 77.2090, zoom = 12) {
  if (!window.L) return;
  map = L.map('map', { zoomControl: true, attributionControl: false }).setView([lat, lng], zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
  return map;
}
function makeIcon(color, emoji) {
  return L.divIcon({
    html: `<div style="background:${color};color:#fff;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 6px rgba(0,0,0,0.25)">${emoji}</div>`,
    className: '', iconSize: [30, 30], iconAnchor: [15, 15],
  });
}
function placeMarker(id, lat, lng, icon, popup) {
  if (!map) return;
  if (mapMarkers[id]) { mapMarkers[id].setLatLng([lat, lng]); return; }
  mapMarkers[id] = L.marker([lat, lng], { icon }).bindPopup(popup || id).addTo(map);
}

document.addEventListener('DOMContentLoaded', () => {
  renderSidebar();
  startClock();
  addLog('System initialized');
});
