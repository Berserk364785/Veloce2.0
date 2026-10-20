'use strict';
/* Veloce — сервер комнат совместного просмотра.
   Без внешних зависимостей: только встроенные модули Node.js (>=20).
   Отдаёт сайт, API каталога, прокси постеров и WebSocket для комнат. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const ws = require('./ws');
const catalog = require('./catalog');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const SOURCES_FILE = path.join(__dirname, 'data', 'sources.json');
const MAX_ROOM = 10; // голос — mesh, больше ~8–10 человек уже тяжело
const MAX_ROOMS = 500;
const ROOM_IDLE_MS = 30 * 60 * 1000;

/* ---------- Источники видео (data/sources.json) ---------- */
const isHttp = (u) => typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u) && u.length < 2000;

function normEntry(key, e) {
  const dubs = (Array.isArray(e.dubs) ? e.dubs : []).map((d) => {
    const eps = Array.isArray(d.episodes) ? d.episodes : d.src ? [{ title: e.title, src: d.src }] : [];
    const episodes = eps.map((x, i) => {
      if (!isHttp(x.src)) throw new Error('некорректная ссылка у «' + (d.name || '?') + '»');
      return { title: String(x.title || 'Серия ' + (i + 1)).slice(0, 80), src: x.src };
    });
    if (!episodes.length) throw new Error('у озвучки «' + (d.name || '?') + '» нет серий');
    return { name: String(d.name || 'Озвучка').slice(0, 40), episodes };
  });
  if (!dubs.length) throw new Error('нет озвучек');
  return {
    key,
    title: String(e.title || key).slice(0, 100),
    type: e.type === 'anime' ? 'anime' : 'movie',
    year: String(e.year || ''),
    kind: String(e.kind || ''),
    poster: e.poster || null,
    dubs,
  };
}

let SOURCES = {};
let sourcesMtime = 0;
function loadSources() {
  try {
    const st = fs.statSync(SOURCES_FILE);
    if (st.mtimeMs === sourcesMtime) return;
    const raw = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
    const out = {};
    for (const [key, e] of Object.entries(raw)) {
      if (key.startsWith('_')) continue;
      try { out[key] = normEntry(key, e); } catch (err) { console.warn('[sources.json]', key + ':', err.message); }
    }
    SOURCES = out;
    sourcesMtime = st.mtimeMs;
    console.log('[sources.json] загружено тайтлов:', Object.keys(out).length);
  } catch (err) {
    console.warn('[sources.json] не удалось прочитать:', err.message);
  }
}
loadSources();

const mediaOf = (e) => ({ key: e.key, title: e.title, dubs: e.dubs });

/* ---------- Комнаты ---------- */
const rooms = new Map();

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) return null;
    r = { id, members: new Map(), chat: [], idleTimer: null, state: { media: null, dub: 0, ep: 0, playing: false, time: 0, ts: Date.now() } };
    rooms.set(id, r);
  }
  return r;
}
const posOf = (s) => s.time + (s.playing ? (Date.now() - s.ts) / 1000 : 0);
const publicState = (r) => ({ media: r.state.media, dub: r.state.dub, ep: r.state.ep, playing: r.state.playing, pos: posOf(r.state) });
const membersList = (r) => [...r.members.values()].map((m) => ({ id: m.id, name: m.name, voice: m.voice, muted: m.muted, cam: m.cam }));

function send(c, obj) { try { c.conn.send(JSON.stringify(obj)); } catch { /* закрыто */ } }
function emit(c, e, d) { send(c, { e, d }); }
function broadcast(room, e, d, exceptId) {
  const msg = JSON.stringify({ e, d });
  for (const m of room.members.values()) if (m.id !== exceptId) { try { m.conn.send(msg); } catch { /* закрыто */ } }
}

const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20) || 'Гость' + Math.floor(100 + Math.random() * 900);
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? Math.floor(+v) : lo));

function setMedia(room, media) {
  const s = room.state;
  s.media = media; s.dub = 0; s.ep = 0; s.time = 0; s.ts = Date.now(); s.playing = false;
}

function leaveRoom(c) {
  const room = c.room;
  if (!room) return;
  c.room = null;
  room.members.delete(c.id);
  if (room.members.size === 0) {
    const s = room.state;
    s.time = posOf(s); s.ts = Date.now(); s.playing = false;
    room.idleTimer = setTimeout(() => { if (room.members.size === 0) rooms.delete(room.id); }, ROOM_IDLE_MS);
  } else {
    broadcast(room, 'members', membersList(room));
    broadcast(room, 'sys', c.name + ' вышел');
  }
}

function handle(c, e, d, ack) {
  d = d && typeof d === 'object' ? d : {};

  if (e === 'join') {
    if (c.room) return ack({ ok: false, error: 'Вы уже в комнате' });
    const id = String(d.room || '').toLowerCase();
    if (!/^[a-z0-9_-]{3,32}$/.test(id)) return ack({ ok: false, error: 'Неверный код комнаты' });
    const room = getRoom(id);
    if (!room) return ack({ ok: false, error: 'Сервер переполнен, попробуйте позже' });
    if (room.members.size >= MAX_ROOM) return ack({ ok: false, error: 'Комната заполнена (максимум ' + MAX_ROOM + ')' });
    clearTimeout(room.idleTimer);
    c.name = cleanName(d.name);
    c.room = room;
    Object.assign(c, { voice: false, muted: false, cam: false });
    room.members.set(c.id, c);
    ack({ ok: true, you: c.id, state: publicState(room), members: membersList(room), chat: room.chat.slice(-50) });
    broadcast(room, 'members', membersList(room), c.id);
    broadcast(room, 'sys', c.name + ' зашёл в комнату', c.id);
    return;
  }

  const room = c.room;
  if (!room) return;
  const s = room.state;

  switch (e) {
    case 'ctl': {
      const t = Number(d.time);
      if (!s.media || !['play', 'pause', 'seek'].includes(d.a) || !Number.isFinite(t) || t < 0) return;
      s.time = t; s.ts = Date.now();
      if (d.a === 'play') s.playing = true;
      if (d.a === 'pause') s.playing = false;
      broadcast(room, 'ctl', { a: d.a, time: t, by: c.id }, c.id);
      return;
    }
    case 'pos':
      return ack({ pos: posOf(s), playing: s.playing });

    case 'load': {
      loadSources();
      let media = null;
      if (typeof d.key === 'string') {
        const entry = SOURCES[d.key];
        if (!entry) return ack({ ok: false, error: 'no_source' });
        media = mediaOf(entry);
      } else if (d.custom && isHttp(d.custom.src)) {
        const title = String(d.custom.title || 'Своя ссылка').replace(/[\u0000-\u001f<>]/g, '').slice(0, 80);
        media = { key: 'custom:' + crypto.randomBytes(4).toString('hex'), title, dubs: [{ name: 'Своя ссылка', episodes: [{ title, src: d.custom.src }] }] };
      } else {
        return ack({ ok: false, error: 'bad_url' });
      }
      setMedia(room, media);
      broadcast(room, 'state', publicState(room));
      broadcast(room, 'sys', c.name + ' включил «' + media.title + '»');
      return ack({ ok: true });
    }

    case 'select': {
      if (!s.media) return;
      if (d.expectEp !== undefined && d.expectEp !== s.ep) return; // защита от дублей при «конец серии»
      const dub = clampInt(d.dub, 0, s.media.dubs.length - 1);
      const ep = clampInt(d.ep, 0, s.media.dubs[dub].episodes.length - 1);
      if (dub === s.dub && ep === s.ep) return;
      const keep = d.keepTime ? posOf(s) : 0;
      s.dub = dub; s.ep = ep; s.time = keep; s.ts = Date.now();
      broadcast(room, 'state', publicState(room));
      return;
    }

    case 'chat': {
      const text = String(d.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
      if (!text) return;
      const now = Date.now();
      c.chatTimes = (c.chatTimes || []).filter((t) => now - t < 5000);
      if (c.chatTimes.length >= 6) return ack({ ok: false, error: 'Слишком часто' });
      c.chatTimes.push(now);
      const msg = { id: c.id, name: c.name, text, ts: now };
      room.chat.push(msg);
      if (room.chat.length > 100) room.chat.shift();
      broadcast(room, 'chat', msg);
      return;
    }

    /* ----- голос (WebRTC): сервер только пересылает сигналы ----- */
    case 'voice:join':
      c.voice = true; c.muted = false; c.cam = false;
      ack({ peers: [...room.members.values()].filter((m) => m.voice && m.id !== c.id).map((m) => m.id) });
      broadcast(room, 'members', membersList(room));
      return;
    case 'voice:leave':
      c.voice = false; c.muted = false; c.cam = false;
      broadcast(room, 'members', membersList(room));
      return;
    case 'voice:mute':
      if (!c.voice) return;
      c.muted = !!d.v;
      broadcast(room, 'members', membersList(room));
      return;
    case 'voice:cam':
      if (!c.voice) return;
      c.cam = !!d.v;
      broadcast(room, 'members', membersList(room));
      return;
    case 'voice:signal': {
      const to = room.members.get(String(d.to));
      if (!to || !d.data || typeof d.data !== 'object') return;
      emit(to, 'voice:signal', { from: c.id, data: d.data });
      return;
    }
  }
}

function onConnect(conn) {
  const c = { id: crypto.randomBytes(5).toString('hex'), conn, room: null, name: '', voice: false, muted: false, cam: false, tokens: 60, refill: Date.now() };
  conn.onmessage = (txt) => {
    const now = Date.now();
    c.tokens = Math.min(60, c.tokens + ((now - c.refill) / 1000) * 30);
    c.refill = now;
    if (c.tokens < 1) return; // флуд
    c.tokens -= 1;
    let m;
    try { m = JSON.parse(txt); } catch { return; }
    if (!m || typeof m.e !== 'string') return;
    const ack = (data) => { if (m.i !== undefined) send(c, { a: m.i, d: data }); };
    try { handle(c, m.e, m.d, ack); } catch (err) { console.error('[ws]', m.e, err); }
  };
  conn.onclose = () => leaveRoom(c);
}

/* ---------- HTTP ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt; charset=utf-8',
};
const RANGE_TYPES = /^(video|audio)\//;
const fileCache = new Map();
const COMMON_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'microphone=(self), camera=(self)' };

function sendStatic(req, res, rel) {
  const full = path.join(PUBLIC, path.normalize(rel));
  if (!full.startsWith(PUBLIC + path.sep)) return notFound(res);
  let st;
  try { st = fs.statSync(full); } catch { return notFound(res); }
  if (!st.isFile()) return notFound(res);
  const mime = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  if (RANGE_TYPES.test(mime)) return sendRanged(req, res, full, st, mime); // свои видеофайлы: с перемоткой
  let f = fileCache.get(full);
  if (!f || f.mtime !== st.mtimeMs) {
    const buf = fs.readFileSync(full);
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    const gz = /^(text|application\/(javascript|json)|image\/svg)/.test(type) ? zlib.gzipSync(buf) : null;
    f = { mtime: st.mtimeMs, buf, gz, type, etag: '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"' };
    fileCache.set(full, f);
  }
  const headers = { ...COMMON_HEADERS, 'Content-Type': f.type, 'Cache-Control': 'no-cache', ETag: f.etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, headers); return res.end(); }
  const useGz = f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = useGz ? f.gz : f.buf;
  if (useGz) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendRanged(req, res, full, st, mime) {
  const size = st.size;
  const h = { ...COMMON_HEADERS, 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = size - 1, code = 200;
  if (m && (m[1] || m[2])) {
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); }
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
    if (start > end || start >= size) { res.writeHead(416, { ...h, 'Content-Range': 'bytes */' + size }); return res.end(); }
    code = 206;
    h['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  h['Content-Length'] = end - start + 1;
  res.writeHead(code, h);
  if (req.method === 'HEAD') return res.end();
  const rs = fs.createReadStream(full, { start, end });
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}

function notFound(res) { res.writeHead(404, { ...COMMON_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Не найдено'); }
function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { ...COMMON_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  // Для мобильных сетей и строгих NAT добавьте TURN (см. README): TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL
  if (process.env.TURN_URLS) {
    list.push({ urls: process.env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean), username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
  }
  return list;
}

function localItems(type, q) {
  const ql = q.toLowerCase();
  return Object.values(SOURCES)
    .filter((e) => e.type === type && (!ql || e.title.toLowerCase().includes(ql)))
    .map((e) => ({ key: e.key, title: e.title, year: e.year, poster: catalog.proxied(e.poster), rating: null, kind: e.kind, type: e.type, playable: true }));
}

async function apiCatalog(u, res) {
  loadSources();
  const type = u.searchParams.get('type') === 'anime' ? 'anime' : 'movie';
  const q = (u.searchParams.get('q') || '').trim().slice(0, 80);
  const page = clampInt(u.searchParams.get('page') || 1, 1, 50);
  const local = page === 1 ? localItems(type, q) : [];
  let note = null;
  let remote = [];
  try {
    const r = type === 'anime' ? await catalog.shikimori({ q, page }) : await catalog.tmdb({ q, page });
    if (r.disabled) note = 'tmdb_off';
    remote = r.items;
  } catch (err) {
    console.warn('[catalog]', type, err.message);
    note = 'remote_error';
  }
  const have = new Set(local.map((i) => i.key));
  const items = [
    ...local,
    ...remote.filter((i) => !have.has(i.key)).map((i) => ({ ...i, poster: catalog.proxied(i.poster), playable: !!SOURCES[i.key] })),
  ];
  sendJson(res, { items, page, note, more: remote.length >= 20 });
}

async function apiImg(u, res) {
  const target = u.searchParams.get('u') || '';
  if (!catalog.imgAllowed(target)) return notFound(res);
  try {
    const { type, buf } = await catalog.fetchImage(target);
    res.writeHead(200, { ...COMMON_HEADERS, 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'Content-Length': buf.length });
    res.end(buf);
  } catch {
    res.writeHead(502, COMMON_HEADERS);
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (p === '/api/config') return sendJson(res, { iceServers: iceServers(), tmdb: !!process.env.TMDB_API_KEY });
    if (p === '/api/catalog') return await apiCatalog(u, res);
    if (p === '/img') return await apiImg(u, res);
    if (p === '/') {
      res.writeHead(302, { Location: '/r/' + crypto.randomBytes(3).toString('hex') });
      return res.end();
    }
    if (/^\/r\/[A-Za-z0-9_-]{3,32}\/?$/.test(p)) return sendStatic(req, res, 'index.html');
    return sendStatic(req, res, decodeURIComponent(p.slice(1)));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

ws.attach(server, '/ws', onConnect);

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log('Veloce запущен: http://localhost:' + PORT));
}
module.exports = { server };
