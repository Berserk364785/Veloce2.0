/* ============================================================
   Veloce — клиент комнаты совместного просмотра
   Сервер хранит «правду» о том, что играет и на какой секунде;
   клиенты отправляют действия (play/pause/seek/выбор) и применяют чужие.
   ============================================================ */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const roomId = (location.pathname.match(/^\/r\/([A-Za-z0-9_-]{3,32})/) || [])[1];
  if (!roomId) { location.replace('/'); return; }

  const ICON = {
    play: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M7 4l13 8-13 8z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
    micOn: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V22h2v-3.1A7 7 0 0 0 19 12z"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l16 16"/><path d="M9 9v3a3 3 0 0 0 5 2M15 10V6a3 3 0 0 0-5.5-1.7M5 12a7 7 0 0 0 11 5.7M19 12a7 7 0 0 1-.6 2.8M12 19v3"/></svg>',
    cam: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2l5-3v12l-5-3v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>',
    hangup: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>',
  };

  const fmt = (s) => {
    if (!isFinite(s)) return '00:00';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
    return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  };
  const hueOf = (str) => { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const colorFor = (name) => `hsl(${hueOf(name)} 55% 45%)`;
  const setFill = (el) => el.style.setProperty('--p', (el.value / el.max) * 100 + '%');

  let toastTimer = 0;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }

  /* ---------- Связь с сервером (WebSocket с автопереподключением) ---------- */
  const net = (() => {
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    const handlers = new Map();
    const acks = new Map();
    let ws = null, nextId = 1, retry = 0;
    const api = {
      connected: false,
      on(e, fn) { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(fn); },
      emit(e, d, ack) {
        if (!api.connected) { if (ack) ack(undefined); return; }
        const m = { e, d };
        if (ack) { m.i = nextId++; acks.set(m.i, ack); }
        ws.send(JSON.stringify(m));
      },
      connect() { open(); },
    };
    const fire = (e, d) => (handlers.get(e) || []).forEach((fn) => { try { fn(d); } catch (err) { console.error(e, err); } });
    function open() {
      ws = new WebSocket(url);
      ws.onopen = () => { retry = 0; api.connected = true; fire('connect'); };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.a !== undefined) { const f = acks.get(m.a); if (f) { acks.delete(m.a); f(m.d); } return; }
        fire(m.e, m.d);
      };
      ws.onclose = () => {
        const was = api.connected;
        api.connected = false;
        acks.forEach((f) => f(undefined));
        acks.clear();
        if (was) fire('disconnect');
        setTimeout(open, Math.min(5000, 500 * 2 ** Math.min(retry++, 4)));
      };
      ws.onerror = () => {};
    }
    return api;
  })();

  let myId = null, myName = '', joined = false;
  let members = [];

  /* ============================================================
     Плеер и синхронизация
     ============================================================ */
  const video = $('#video');
  const btnPlay = $('#btnPlay');
  const seek = $('#seek');
  const vol = $('#vol');
  let hls = null, loadedSrc = '';
  let st = { media: null, dub: 0, ep: 0, playing: false };
  let quietUntil = 0, dragging = false;

  /* Действия, вызванные чужой командой, не отправляем обратно («эхо») */
  const quiet = (ms = 700) => { quietUntil = Math.max(quietUntil, Date.now() + ms); };
  const isQuiet = () => Date.now() < quietUntil;
  const userAct = () => { quietUntil = 0; }; // действие самого пользователя всегда уходит в комнату
  const curEp = () => (st.media ? st.media.dubs[st.dub].episodes[st.ep] : null);

  function setTime(t) { if (Math.abs(video.currentTime - t) > 0.3) video.currentTime = t; }
  function tryPlay() {
    const p = video.play();
    if (p && p.catch) p.catch(() => toast('Нажмите ▶, чтобы начать воспроизведение'));
  }
  const updatePlayIcon = () => { btnPlay.innerHTML = video.paused ? ICON.play : ICON.pause; };

  function stopVideo() {
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    video.load();
    loadedSrc = '';
    updatePlayIcon();
  }

  function setSource(src, pos, play) {
    loadedSrc = src;
    quiet(1500);
    if (hls) { hls.destroy(); hls = null; }
    const isHls = /\.m3u8(\?|$)/i.test(src);
    if (isHls && !video.canPlayType('application/vnd.apple.mpegurl') && window.Hls && Hls.isSupported()) {
      hls = new Hls({ startPosition: pos > 0.5 ? pos : -1 });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { quiet(800); if (play) tryPlay(); });
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) toast('Не удалось загрузить видео (ссылка недоступна или нет CORS)'); });
    } else {
      video.src = src;
      video.addEventListener('loadedmetadata', () => {
        quiet(800);
        if (pos > 0.5) video.currentTime = pos;
        if (play) tryPlay();
      }, { once: true });
    }
    updatePlayIcon();
  }

  function renderMedia() {
    const m = st.media;
    $('#emptyMsg').hidden = !!m;
    const dubSel = $('#dubSelect'), epSel = $('#epSelect');
    dubSel.innerHTML = ''; epSel.innerHTML = '';
    if (!m) { $('#nowTitle').textContent = '—'; $('#dubWrap').hidden = true; $('#epWrap').hidden = true; }
    else {
      const eps = m.dubs[st.dub].episodes;
      $('#nowTitle').textContent = m.title + (eps.length > 1 ? ' · ' + eps[st.ep].title : '');
      m.dubs.forEach((d, i) => dubSel.add(new Option(d.name, i)));
      eps.forEach((e, i) => epSel.add(new Option(e.title, i)));
      dubSel.value = st.dub; epSel.value = st.ep;
      $('#dubWrap').hidden = m.dubs.length < 2;
      $('#epWrap').hidden = eps.length < 2;
    }
    document.querySelectorAll('.poster').forEach((p) => p.classList.toggle('active', !!m && p.dataset.key === m.key));
  }

  function applyState(s) {
    st = { media: s.media, dub: s.dub, ep: s.ep, playing: s.playing };
    renderMedia();
    if (!st.media) { stopVideo(); return; }
    const src = curEp().src;
    if (src !== loadedSrc) setSource(src, s.pos, s.playing);
    else { quiet(); setTime(s.pos); if (s.playing) tryPlay(); else video.pause(); }
  }

  /* Локальные действия → всем в комнате */
  video.addEventListener('play', () => {
    updatePlayIcon();
    if (isQuiet() || !st.media) return;
    // Если комната уже играет (например, мы опоздали и автозапуск не сработал) — просто подстраиваемся
    net.emit('pos', null, (r) => {
      if (r && r.playing) { quiet(); setTime(r.pos); }
      else net.emit('ctl', { a: 'play', time: video.currentTime });
    });
  });
  video.addEventListener('pause', () => {
    updatePlayIcon();
    if (isQuiet() || video.ended || !st.media) return;
    net.emit('ctl', { a: 'pause', time: video.currentTime });
  });
  video.addEventListener('seeked', () => {
    if (isQuiet() || !st.media) return;
    net.emit('ctl', { a: 'seek', time: video.currentTime });
  });
  video.addEventListener('ended', () => {
    updatePlayIcon();
    if (!st.media) return;
    const eps = st.media.dubs[st.dub].episodes;
    if (st.ep + 1 < eps.length) net.emit('select', { dub: st.dub, ep: st.ep + 1, expectEp: st.ep });
    else net.emit('ctl', { a: 'pause', time: video.currentTime });
  });
  video.addEventListener('error', () => { if (st.media && loadedSrc) toast('Видео не загружается: проверьте ссылку и формат'); });

  /* Чужие действия */
  net.on('ctl', (d) => {
    if (!st.media) return;
    quiet();
    if (d.a === 'play') { st.playing = true; setTime(d.time); tryPlay(); }
    else if (d.a === 'pause') { st.playing = false; video.pause(); setTime(d.time); }
    else if (d.a === 'seek') { setTime(d.time); }
  });
  net.on('state', applyState);

  /* Раз в 5 секунд сверяемся с сервером: подтягиваем отстающих */
  setInterval(() => {
    if (!joined || !st.media || video.paused || video.seeking) return;
    net.emit('pos', null, (r) => {
      if (r && r.playing && Math.abs(r.pos - video.currentTime) > 1.5) { quiet(); video.currentTime = r.pos; }
    });
  }, 5000);

  /* Управление */
  btnPlay.addEventListener('click', () => { if (!st.media) return; userAct(); video.paused ? tryPlay() : video.pause(); });
  $('#btnBack').addEventListener('click', () => { if (st.media) { userAct(); video.currentTime = Math.max(0, video.currentTime - 10); } });
  $('#btnVol').addEventListener('click', (e) => { video.muted = !video.muted; e.currentTarget.classList.toggle('dim', video.muted); });
  vol.addEventListener('input', () => { video.volume = vol.value / 100; video.muted = false; $('#btnVol').classList.remove('dim'); setFill(vol); });
  video.volume = vol.value / 100; setFill(vol);

  seek.addEventListener('input', () => {
    dragging = true; setFill(seek);
    if (video.duration) $('#time').textContent = fmt((seek.value / seek.max) * video.duration);
  });
  seek.addEventListener('change', () => {
    dragging = false;
    userAct();
    if (video.duration) video.currentTime = (seek.value / seek.max) * video.duration;
  });
  video.addEventListener('timeupdate', () => {
    if (dragging) return;
    if (video.duration) seek.value = (video.currentTime / video.duration) * seek.max;
    setFill(seek);
    $('#time').textContent = fmt(video.currentTime);
  });

  $('#btnFull').addEventListener('click', () => {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    if (video.requestFullscreen) video.requestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  });
  document.addEventListener('fullscreenchange', () => { video.controls = !!document.fullscreenElement; });

  $('#dubSelect').addEventListener('change', (e) => net.emit('select', { dub: +e.target.value, ep: st.ep, keepTime: true }));
  $('#epSelect').addEventListener('change', (e) => net.emit('select', { dub: st.dub, ep: +e.target.value }));

  function loadCustom(title, src) {
    net.emit('load', { custom: { title, src } }, (res) => {
      if (!res) return toast('Нет связи с сервером');
      if (!res.ok) toast('Нужна ссылка вида https://…');
    });
  }
  $('#btnUrl').addEventListener('click', () => {
    const src = (prompt('Ссылка на видео (mp4 или m3u8, https):') || '').trim();
    if (!src) return;
    let title = 'Своя ссылка';
    try { const u = new URL(src); title = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname); } catch { /* оставим по умолчанию */ }
    loadCustom(title, src);
  });

  /* ============================================================
     Каталог
     ============================================================ */
  const grid = $('#catGrid');
  let tab = 'anime', query = '', page = 1, reqId = 0, searchTimer = 0;

  function addCard(item) {
    const b = document.createElement('button');
    b.className = 'poster' + (item.playable ? '' : ' nosrc');
    b.dataset.key = item.key;
    b.title = item.key;
    const h = hueOf(item.key);
    b.style.background = `linear-gradient(160deg, hsl(${h} 70% 45%), hsl(${(h + 60) % 360} 60% 20%))`;
    if (item.poster) {
      const img = document.createElement('img');
      img.loading = 'lazy'; img.alt = ''; img.src = item.poster;
      img.onerror = () => img.remove();
      b.appendChild(img);
    }
    const shade = document.createElement('div'); shade.className = 'shade'; b.appendChild(shade);
    const t = document.createElement('b'); t.textContent = item.title; b.appendChild(t);
    const s = document.createElement('span');
    s.textContent = [item.year, item.kind, item.rating ? '★ ' + item.rating : ''].filter(Boolean).join(' · ');
    b.appendChild(s);
    const tag = document.createElement('i'); tag.className = 'tag';
    tag.textContent = item.playable ? '▶' : 'нет видео';
    b.appendChild(tag);
    if (st.media && st.media.key === item.key) b.classList.add('active');
    b.addEventListener('click', () => pick(item));
    grid.appendChild(b);
  }

  async function loadCatalog(reset) {
    const my = ++reqId;
    if (reset) { page = 1; grid.innerHTML = ''; $('#catMore').hidden = true; $('#catNote').textContent = 'Загрузка…'; }
    try {
      const r = await fetch(`/api/catalog?type=${tab}&q=${encodeURIComponent(query)}&page=${page}`);
      const j = await r.json();
      if (my !== reqId) return;
      j.items.forEach(addCard);
      let note = '';
      if (!grid.children.length) note = 'Ничего не найдено.';
      if (j.note === 'tmdb_off') note = 'Каталог TMDB не подключён — показаны только тайтлы из data/sources.json (см. README).';
      if (j.note === 'remote_error') note = 'Внешний каталог сейчас недоступен — показаны только свои тайтлы.';
      $('#catNote').textContent = note;
      $('#catMore').hidden = !j.more;
    } catch {
      if (my === reqId) $('#catNote').textContent = 'Не удалось загрузить каталог.';
    }
  }

  function pick(item) {
    net.emit('load', { key: item.key }, (res) => {
      if (!res) return toast('Нет связи с сервером');
      if (res.ok) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      if (res.error === 'no_source') {
        const src = (prompt(
          'Для «' + item.title + '» пока нет видео.\n\n' +
          'Вставьте прямую ссылку на видео (mp4 или m3u8, https) — включится для всех в этой комнате.\n\n' +
          'Чтобы тайтл играл всегда, добавьте его в data/sources.json под ключом:\n' + item.key
        ) || '').trim();
        if (src) loadCustom(item.title, src);
      }
    });
  }

  document.querySelectorAll('.seg-btn').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    tab = btn.dataset.type;
    loadCatalog(true);
  }));
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = e.target.value.trim(); loadCatalog(true); }, 400);
  });
  $('#catMore').addEventListener('click', () => { page++; loadCatalog(false); });
  $('#navRooms').addEventListener('click', (e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

  /* ============================================================
     Чат (пузырь внизу справа)
     ============================================================ */
  const panel = $('#chatPanel'), bubble = $('#chatBubble'), badge = $('#chatBadge'), log = $('#chatLog');
  let unread = 0;

  function setChat(open) {
    panel.classList.toggle('open', open);
    panel.setAttribute('aria-hidden', String(!open));
    bubble.setAttribute('aria-expanded', String(open));
    if (open) { unread = 0; badge.hidden = true; log.scrollTop = log.scrollHeight; $('#chatInput').focus({ preventScroll: true }); }
  }
  bubble.addEventListener('click', () => setChat(!panel.classList.contains('open')));
  $('#chatClose').addEventListener('click', () => setChat(false));

  function addMessage(msg, silent) {
    const mine = msg.id === myId;
    const row = document.createElement('div');
    row.className = 'msg' + (mine ? ' mine' : '');
    const ava = document.createElement('div');
    ava.className = 'ava'; ava.style.background = colorFor(msg.name); ava.textContent = msg.name[0].toUpperCase();
    const body = document.createElement('div'); body.className = 'body';
    const n = document.createElement('div'); n.className = 'name'; n.textContent = msg.name;
    const t = document.createElement('div'); t.className = 'text'; t.textContent = msg.text;
    body.append(n, t);
    row.append(ava, body);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    if (!mine && !silent && !panel.classList.contains('open')) { unread++; badge.textContent = unread; badge.hidden = false; }
  }
  function addSystem(text) {
    const d = document.createElement('div'); d.className = 'sys'; d.textContent = text;
    log.appendChild(d); log.scrollTop = log.scrollHeight;
  }
  net.on('chat', (m) => addMessage(m, false));
  net.on('sys', addSystem);

  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text) return;
    net.emit('chat', { text }, (res) => { if (res && res.ok === false) toast(res.error || 'Не отправлено'); });
    input.value = '';
  });

  /* ============================================================
     Участники и голос
     ============================================================ */
  const voice = window.createVoice({
    net,
    getMyId: () => myId,
    toast,
    onChange: () => { renderMembers(); renderVoiceButtons(); },
  });

  const tiles = new Map();
  function makeTile(m) {
    const wrap = document.createElement('div'); wrap.className = 'vwrap';
    const item = document.createElement('div'); item.className = 'voice-item';
    const letter = document.createElement('span'); letter.className = 'letter';
    const dot = document.createElement('span'); dot.className = 'on';
    const mic = document.createElement('span'); mic.className = 'mic';
    item.append(letter, dot, mic);
    const name = document.createElement('div'); name.className = 'vname';
    wrap.append(item, name);
    $('#voiceList').appendChild(wrap);
    return { wrap, item, letter, mic, name, video: null };
  }

  function renderMembers() {
    const ids = new Set(members.map((m) => m.id));
    tiles.forEach((t, id) => { if (!ids.has(id)) { t.wrap.remove(); tiles.delete(id); } });
    members.forEach((m) => {
      let t = tiles.get(m.id);
      if (!t) { t = makeTile(m); tiles.set(m.id, t); }
      t.item.style.background = colorFor(m.name);
      t.letter.textContent = m.name[0].toUpperCase();
      t.name.textContent = m.name + (m.id === myId ? ' (вы)' : '');
      t.item.classList.toggle('novoice', !m.voice);
      t.item.classList.toggle('speaking', m.voice && !m.muted && voice.isSpeaking(m.id));
      t.mic.hidden = !m.voice;
      t.mic.innerHTML = m.muted ? ICON.micOff : ICON.micOn;
      if (m.cam) {
        const stream = voice.streamFor(m.id);
        if (stream && !t.video) {
          t.video = document.createElement('video');
          t.video.autoplay = true; t.video.muted = true; t.video.playsInline = true;
          t.item.prepend(t.video);
        }
        if (t.video && stream && t.video.srcObject !== stream) { t.video.srcObject = stream; t.video.play().catch(() => {}); }
      } else if (t.video) { t.video.srcObject = null; t.video.remove(); t.video = null; }
    });
  }

  function renderVoiceButtons() {
    const on = voice.isOn();
    $('#joinIco').innerHTML = on ? ICON.hangup : ICON.phone;
    $('#joinLbl').textContent = on ? 'Leave' : 'Join';
    $('#btnJoin').classList.toggle('off', on);
    $('#btnMic').disabled = !on || voice.isListenOnly();
    $('#btnCam').disabled = !on;
    $('#micIco').innerHTML = voice.isMuted() ? ICON.micOff : ICON.micOn;
    $('#micLbl').textContent = voice.isMuted() ? 'Unmute' : 'Mute';
    $('#btnMic').classList.toggle('off', voice.isMuted());
    $('#btnCam').classList.toggle('off', !voice.isCam());
  }
  $('#camIco').innerHTML = ICON.cam;
  renderVoiceButtons();

  $('#btnJoin').addEventListener('click', async () => {
    if (!joined) return;
    if (voice.isOn()) voice.leave(); else await voice.join();
  });
  $('#btnMic').addEventListener('click', () => voice.toggleMute());
  $('#btnCam').addEventListener('click', () => voice.toggleCam());

  net.on('members', (list) => { members = list; voice.sync(list); renderMembers(); });

  /* ============================================================
     Вход в комнату и связь
     ============================================================ */
  const gate = $('#gate'), gateErr = $('#gateErr'), liveState = $('#liveState');
  $('#gateRoom').textContent = '#' + roomId;
  $('#gateName').value = (() => { try { return localStorage.getItem('veloce:name') || ''; } catch { return ''; } })();

  const setLive = (on) => { liveState.classList.toggle('off', !on); $('b', liveState).textContent = on ? 'On' : 'Off'; };

  function doJoin() {
    net.emit('join', { room: roomId, name: myName }, (res) => {
      if (!res) return; // связь пропала — повторим при следующем подключении
      if (!res.ok) { gateErr.textContent = res.error || 'Не удалось войти'; gateErr.hidden = false; $('#gateBtn').disabled = false; gate.hidden = false; return; }
      const rejoin = joined;
      joined = true; myId = res.you; members = res.members;
      gate.hidden = true;
      $('#meAvatar').dataset.letter = myName[0].toUpperCase();
      $('#meAvatar').style.background = colorFor(myName);
      log.innerHTML = '';
      res.chat.forEach((m) => addMessage(m, true));
      addSystem(rejoin ? 'Связь восстановлена' : 'Вы в комнате #' + roomId + '. Скопируйте ссылку (🔗 вверху) и отправьте друзьям.');
      applyState(res.state);
      renderMembers();
      setLive(true);
    });
  }

  net.on('connect', () => { if (myName) doJoin(); });
  net.on('disconnect', () => {
    setLive(false);
    if (voice.isOn()) { voice.teardown(); toast('Связь прервалась — голос отключён, нажмите Join'); }
  });

  $('#gateForm').addEventListener('submit', (e) => {
    e.preventDefault();
    myName = $('#gateName').value.trim().slice(0, 20);
    if (!myName) return;
    try { localStorage.setItem('veloce:name', myName); } catch { /* приватный режим */ }
    gateErr.hidden = true;
    $('#gateBtn').disabled = true;
    if (net.connected) doJoin(); // иначе войдём сами, как только соединение установится
  });

  $('#copyRoom').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Ссылка на комнату скопирована'); }
    catch { prompt('Ссылка на комнату:', location.href); }
  });

  /* ---------- Старт ---------- */
  updatePlayIcon();
  renderMedia();
  loadCatalog(true);
  net.connect();
})();
