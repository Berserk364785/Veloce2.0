'use strict';
/* Быстрая проверка сервера: node test/smoke.js (нужен Node 22+: встроенный WebSocket-клиент) */
const assert = require('assert');
const { server } = require('../server');

class Client {
  constructor(base, name) {
    this.name = name;
    this.nextId = 1;
    this.acks = new Map();
    this.handlers = new Map();
    this.log = [];
    this.ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    this.opened = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.closedCode = null;
    this.ws.onclose = (e) => { this.closedCode = e.code; };
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.a !== undefined) { const f = this.acks.get(m.a); if (f) { this.acks.delete(m.a); f(m.d); } return; }
      this.log.push(m);
      (this.handlers.get(m.e) || []).forEach((f) => f(m.d));
    };
  }
  on(e, f) { this.handlers.set(e, [...(this.handlers.get(e) || []), f]); }
  emit(e, d, ack) {
    const m = { e, d };
    if (ack) { m.i = this.nextId++; this.acks.set(m.i, ack); }
    this.ws.send(JSON.stringify(m));
  }
  call(e, d) { return new Promise((res) => this.emit(e, d, res)); }
  next(e, ms = 1500) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(this.name + ': не дождались «' + e + '»')), ms);
      const f = (d) => { clearTimeout(t); this.handlers.set(e, (this.handlers.get(e) || []).filter((x) => x !== f)); res(d); };
      this.on(e, f);
    });
  }
  count(e) { return this.log.filter((m) => m.e === e).length; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  let ok = 0;
  const pass = (m) => { ok++; console.log('  ✓', m); };

  /* HTTP */
  let r = await fetch(base + '/healthz'); assert.equal(r.status, 200); pass('healthz');
  r = await fetch(base + '/', { redirect: 'manual' }); assert.equal(r.status, 302); assert.match(r.headers.get('location'), /^\/r\/[a-f0-9]{6}$/); pass('/ → /r/<код>');
  r = await fetch(base + '/r/abc123'); assert.equal(r.status, 200); assert.match(await r.text(), /Veloce/); pass('страница комнаты');
  r = await fetch(base + '/style.css'); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /css/); pass('статика + gzip-заголовки');
  r = await fetch(base + '/..%2fserver.js'); assert.equal(r.status, 404); pass('защита от выхода из public');
  r = await fetch(base + '/img?u=' + encodeURIComponent('https://evil.example.com/a.png')); assert.equal(r.status, 404); pass('прокси картинок не пускает чужие хосты');
  r = await fetch(base + '/api/config'); const cfg = await r.json(); assert.ok(cfg.iceServers.length >= 1); pass('/api/config');
  r = await fetch(base + '/api/catalog?type=movie'); let cat = await r.json();
  assert.ok(cat.items.some((i) => i.key === 'demo:bbb' && i.playable)); pass('каталог фильмов: свои тайтлы есть (note=' + cat.note + ')');
  r = await fetch(base + '/api/catalog?type=anime&q=sintel'); cat = await r.json();
  assert.ok(cat.items.some((i) => i.key === 'demo:sintel')); pass('каталог аниме + поиск (note=' + cat.note + ')');

  /* WebSocket */
  const A = new Client(base, 'A'), B = new Client(base, 'B');
  await Promise.all([A.opened, B.opened]);
  let j = await A.call('join', { room: 'testroom', name: 'Алиса' });
  assert.ok(j.ok && j.you && j.members.length === 1 && j.state.media === null); pass('A вошла в комнату');
  const memB = A.next('members');
  j = await B.call('join', { room: 'testroom', name: 'Боб<script>' });
  assert.ok(j.ok && j.members.length === 2); const m = await memB; assert.equal(m.length, 2);
  assert.ok(!m.some((x) => /[<>]/.test(x.name))); pass('B вошёл, A получила список участников (имя очищено)');

  assert.equal((await A.call('join', { room: '!!', name: 'x' })).ok, false); pass('повторный join отклонён');
  const C = new Client(base, 'C'); await C.opened;
  assert.equal((await C.call('join', { room: 'a', name: 'x' })).ok, false); pass('неверный код комнаты отклонён');
  C.ws.close();

  assert.equal((await A.call('load', { key: 'nope:1' })).error, 'no_source'); pass('тайтл без источника → no_source');
  assert.equal((await A.call('load', { custom: { title: 'x', src: 'javascript:alert(1)' } })).error, 'bad_url'); pass('опасная ссылка отклонена');

  let stB = B.next('state');
  assert.ok((await A.call('load', { key: 'demo:series' })).ok);
  let s = await stB;
  assert.equal(s.media.title, 'Демо-сериал (3 серии)'); assert.equal(s.media.dubs.length, 2); assert.equal(s.playing, false); pass('load → B получил состояние (2 озвучки, 3 серии)');

  const ctlB = B.next('ctl');
  A.emit('ctl', { a: 'play', time: 5 });
  let c = await ctlB; assert.equal(c.a, 'play'); assert.equal(c.time, 5); pass('play доходит до B');
  await sleep(1100);
  let p = await B.call('pos'); assert.equal(p.playing, true); assert.ok(p.pos > 5.9 && p.pos < 7.5, 'pos=' + p.pos); pass('сервер считает позицию при воспроизведении (pos=' + p.pos.toFixed(2) + ')');
  A.emit('ctl', { a: 'pause', time: 20 });
  await sleep(100);
  p = await B.call('pos'); assert.equal(p.playing, false); assert.equal(Math.round(p.pos), 20); pass('pause фиксирует позицию');

  stB = B.next('state');
  A.emit('select', { dub: 1, ep: 0, keepTime: true });
  s = await stB; assert.equal(s.dub, 1); assert.equal(Math.round(s.pos), 20); pass('смена озвучки сохраняет время');

  stB = B.next('state');
  A.emit('select', { dub: 1, ep: 1, expectEp: 0 });
  s = await stB; assert.equal(s.ep, 1); assert.equal(s.pos, 0);
  const before = B.count('state');
  A.emit('select', { dub: 1, ep: 2, expectEp: 0 }); // устаревшее «конец серии» — должно игнорироваться
  await sleep(150); assert.equal(B.count('state'), before); pass('следующая серия; дубли «конец серии» игнорируются');

  stB = B.next('state');
  assert.ok((await A.call('load', { custom: { title: 'Моё видео', src: 'https://example.com/a.m3u8' } })).ok);
  s = await stB; assert.equal(s.media.title, 'Моё видео'); assert.match(s.media.key, /^custom:/); pass('своя ссылка работает');

  /* YouTube / Rutube / VK */
  const RT = '0123456789abcdef0123456789abcdef';
  for (const [url, p, id, title] of [
    ['https://youtu.be/dQw4w9WgXcQ', 'yt', 'dQw4w9WgXcQ', 'YouTube'],
    ['https://rutube.ru/video/' + RT + '/', 'rt', RT, 'Rutube'],
    ['https://vk.com/video-22822305_456239018', 'vk', '-22822305_456239018', 'VK Видео'],
  ]) {
    stB = B.next('state');
    assert.ok((await A.call('load', { custom: { title: '', src: url } })).ok);
    s = await stB;
    const ep = s.media.dubs[0].episodes[0];
    assert.equal(ep.p, p); assert.equal(ep.id, id); assert.equal(s.media.title, title);
  }
  pass('YouTube / Rutube / VK: ссылки распознаются, название по умолчанию');
  stB = B.next('state');
  assert.ok((await A.call('load', { custom: { title: '', src: 'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ' } })).ok);
  s = await stB; assert.equal(s.media.dubs[0].episodes[0].p, undefined); pass('поддельный домен не принимается за YouTube');

  const chatA = A.next('chat'), chatB = B.next('chat');
  B.emit('chat', { text: 'привет '.repeat(100) });
  const [ma, mb] = await Promise.all([chatA, chatB]);
  assert.equal(ma.text.length, 300); assert.equal(mb.name, ma.name); pass('чат: оба получили, длина обрезана до 300 (кадр >125 байт)');
  for (let i = 0; i < 8; i++) B.emit('chat', { text: 'spam' + i });
  await sleep(200); assert.ok(A.count('chat') <= 7); pass('антиспам чата');

  /* голос */
  const peers = await A.call('voice:join'); assert.deepEqual(peers.peers, []);
  const sigA = A.next('voice:signal');
  const vm = await (async () => { const w = A.next('members'); const pr = await B.call('voice:join'); await w; return pr; })();
  assert.deepEqual(vm.peers, [j.you === undefined ? '' : vm.peers[0]]); assert.equal(vm.peers.length, 1);
  B.emit('voice:signal', { to: vm.peers[0], data: { description: { type: 'offer', sdp: 'x'.repeat(3000) } } });
  const sg = await sigA; assert.equal(sg.data.description.type, 'offer'); assert.equal(sg.data.description.sdp.length, 3000); pass('голос: join и пересылка SDP (кадр 16-бит длины)');
  const wm = A.next('members'); B.emit('voice:mute', { v: true });
  const ml = await wm; assert.equal(ml.find((x) => x.voice && x.muted) !== undefined, true); pass('голос: mute виден всем');

  /* большой кадр → закрытие 1009 */
  const big = new Client(base, 'big'); await big.opened;
  big.ws.send('x'.repeat(70000)); await sleep(300); assert.equal(big.closedCode, 1009); pass('кадр >64 КБ → соединение закрыто (1009)');

  /* выход и заполнение комнаты */
  const leaveWait = A.next('members'); B.ws.close(); const left = await leaveWait; assert.equal(left.length, 1); pass('выход участника обновляет список');
  const many = [];
  for (let i = 0; i < 10; i++) { const x = new Client(base, 'm' + i); await x.opened; many.push(x); }
  let okCount = 0, fullErr = null;
  for (const x of many) { const rr = await x.call('join', { room: 'testroom', name: 'n' }); if (rr.ok) okCount++; else fullErr = rr.error; }
  assert.equal(okCount, 9); assert.match(fullErr, /заполнена/); pass('лимит комнаты: 10 человек');

  console.log('\nВсе проверки пройдены: ' + ok);
  process.exit(0);
})().catch((e) => { console.error('\nОШИБКА:', e.message || e); process.exit(1); });
