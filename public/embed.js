/* Veloce — встроенные плееры YouTube / Rutube / VK Видео.
   Единый интерфейс: load(ep, pos, play), play(), pause(), seek(t), time(), paused(), destroy().
   События наружу: onPlay(t), onPause(t), onSeek(t), onEnded(), onError(text).
   Управление самим роликом (громкость, полный экран, качество) — через родные кнопки плеера. */
(function () {
  'use strict';

  const loaded = {};
  function loadScript(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = () => { delete loaded[src]; reject(new Error('script')); };
      document.head.appendChild(s);
    });
    return loaded[src];
  }

  /* Следит за временем ролика: считает «ожидаемое» положение и замечает перемотку */
  function makeTracker(onSeek) {
    let t = 0, playing = false, stamp = Date.now();
    return {
      expected() { return t + (playing ? (Date.now() - stamp) / 1000 : 0); },
      get() { return this.expected(); },
      isPlaying() { return playing; },
      update(newT, newPlaying) {
        const exp = this.expected();
        if (Math.abs(newT - exp) > 1.6) onSeek(newT);
        t = newT; stamp = Date.now(); playing = newPlaying;
      },
      set(newT, newPlaying) { t = newT; stamp = Date.now(); playing = newPlaying; },
    };
  }

  function makeIframe(host, src) {
    const f = document.createElement('iframe');
    f.src = src;
    f.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media; clipboard-write';
    f.setAttribute('allowfullscreen', '');
    f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#000';
    host.appendChild(f);
    return f;
  }

  /* ============================== YouTube ============================== */
  function youtube(host, ep, pos, play, cb) {
    let player = null, ready = false, dead = false, poll = 0;
    const pending = [];
    const trk = makeTracker((t) => cb.onSeek(t));
    const run = (fn) => { if (ready && player) { try { fn(); } catch (e) { /* плеер ещё не готов */ } } else pending.push(fn); };
    const div = document.createElement('div');
    div.style.cssText = 'position:absolute;inset:0';
    host.appendChild(div);

    loadScript('https://www.youtube.com/iframe_api').then(() => new Promise((res) => {
      if (window.YT && YT.Player) return res();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(); };
    })).then(() => {
      if (dead) return;
      player = new YT.Player(div, {
        width: '100%', height: '100%', videoId: ep.id,
        playerVars: { playsinline: 1, rel: 0, start: Math.floor(pos) || 0, autoplay: play ? 1 : 0 },
        events: {
          onReady: () => {
            ready = true;
            const f = div.tagName === 'IFRAME' ? div : host.querySelector('iframe');
            if (f) f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0';
            pending.splice(0).forEach((fn) => { try { fn(); } catch (e) { /* пропускаем */ } });
            if (play) { try { player.playVideo(); } catch (e) { /* автозапуск мог быть запрещён */ } }
          },
          onStateChange: (e) => {
            const t = player.getCurrentTime();
            if (e.data === 1) { trk.set(t, true); cb.onPlay(t); }
            else if (e.data === 2) { trk.set(t, false); cb.onPause(t); }
            else if (e.data === 0) { cb.onEnded(); }
          },
          onError: (e) => {
            const c = e.data;
            cb.onError(c === 101 || c === 150 ? 'Автор запретил встраивание этого ролика' : c === 100 ? 'Ролик не найден или скрыт' : 'YouTube не смог открыть ролик');
          },
        },
      });
      poll = setInterval(() => {
        if (!ready) return;
        try {
          const s = player.getPlayerState();
          trk.update(player.getCurrentTime(), s === 1 || s === 3);
        } catch (e) { /* ещё грузится */ }
      }, 500);
    }).catch(() => cb.onError('Не удалось загрузить плеер YouTube (сайт недоступен?)'));

    return {
      play: () => run(() => player.playVideo()),
      pause: () => run(() => player.pauseVideo()),
      seek: (t) => { trk.set(t, trk.isPlaying()); run(() => player.seekTo(t, true)); },
      time: () => trk.get(),
      paused: () => !trk.isPlaying(),
      destroy: () => { dead = true; clearInterval(poll); try { player && player.destroy(); } catch (e) { /* уже удалён */ } div.remove(); },
    };
  }

  /* =============================== Rutube =============================== */
  function rutube(host, ep, pos, play, cb) {
    const trk = makeTracker((t) => cb.onSeek(t));
    let ready = false, dur = 0, dead = false;
    const pending = [];
    const f = makeIframe(host, 'https://rutube.ru/play/embed/' + ep.id + (ep.key ? '?p=' + encodeURIComponent(ep.key) : ''));
    const cmd = (type, data) => { try { f.contentWindow.postMessage(JSON.stringify({ type, data: data || {} }), '*'); } catch (e) { /* нет окна */ } };
    const run = (fn) => (ready ? fn() : pending.push(fn));

    const onReady = () => {
      if (ready) return;
      ready = true;
      if (pos > 0.5) cmd('player:setCurrentTime', { time: pos });
      if (play) cmd('player:play');
      pending.splice(0).forEach((fn) => fn());
    };
    const onMsg = (ev) => {
      if (dead || ev.source !== f.contentWindow) return;
      let m = ev.data;
      if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return; } }
      if (!m || typeof m.type !== 'string') return;
      const d = m.data || {};
      switch (m.type) {
        case 'player:ready': onReady(); break;
        case 'player:durationChange': dur = Number(d.duration) || dur; break;
        case 'player:currentTime': { onReady(); if (typeof d.time === 'number') trk.update(d.time, trk.isPlaying()); break; }
        case 'player:changeState': {
          onReady();
          const t = trk.get();
          if (d.state === 'playing') { trk.set(t, true); cb.onPlay(t); }
          else if (d.state === 'paused') { trk.set(t, false); cb.onPause(t); }
          else if (d.state === 'stopped' && dur && t >= dur - 2) { trk.set(t, false); cb.onEnded(); }
          break;
        }
        case 'player:playComplete': cb.onEnded(); break;
      }
    };
    window.addEventListener('message', onMsg);
    const fallback = setTimeout(onReady, 4000); // если «ready» не пришёл — всё равно пробуем

    return {
      play: () => run(() => cmd('player:play')),
      pause: () => run(() => cmd('player:pause')),
      seek: (t) => { trk.set(t, trk.isPlaying()); run(() => cmd('player:setCurrentTime', { time: t })); },
      time: () => trk.get(),
      paused: () => !trk.isPlaying(),
      destroy: () => { dead = true; clearTimeout(fallback); window.removeEventListener('message', onMsg); f.remove(); },
    };
  }

  /* ============================== VK Видео ============================== */
  function vk(host, ep, pos, play, cb) {
    const trk = makeTracker((t) => cb.onSeek(t));
    const [oid, id] = ep.id.split('_');
    const src = 'https://vk.com/video_ext.php?oid=' + oid + '&id=' + id + (ep.hash ? '&hash=' + ep.hash : '') + '&js_api=1&autoplay=' + (play ? 1 : 0);
    const f = makeIframe(host, src);
    let pl = null, dead = false, synced = false;
    const pending = [];
    const run = (fn) => { if (pl) { try { fn(); } catch (e) { /* команда не прошла */ } } else pending.push(fn); };

    function init() {
      if (dead) return;
      try { pl = window.VK.VideoPlayer(f); } catch (e) { cb.onError('VK: плеер не поддерживает синхронизацию'); return; }
      const on = (name, fn) => { try { pl.on(name, fn); } catch (e) { /* такого события нет */ } };
      const tOf = (e) => (typeof e === 'number' ? e : e && typeof e.time === 'number' ? e.time : trk.get());
      on('started', (e) => { const t = tOf(e); trk.set(t, true); cb.onPlay(t); });
      on('resumed', (e) => { const t = tOf(e); trk.set(t, true); cb.onPlay(t); });
      on('paused', (e) => { const t = tOf(e); trk.set(t, false); cb.onPause(t); });
      on('ended', () => { trk.set(trk.get(), false); cb.onEnded(); });
      on('timeupdate', (e) => { trk.update(tOf(e), trk.isPlaying()); });
      on('inited', ready);
      setTimeout(ready, 2500); // на случай, если «inited» не придёт
    }
    function ready() {
      if (synced) return;
      synced = true;
      if (pos > 0.5) { try { pl.seek(pos); } catch (e) { /* пропускаем */ } }
      pending.splice(0).forEach((fn) => { try { fn(); } catch (e) { /* пропускаем */ } });
    }

    loadScript('https://vk.com/js/api/videoplayer.js').then(() => {
      if (window.VK && window.VK.VideoPlayer) init();
      else cb.onError('VK: не удалось включить синхронизацию, ролик играет сам по себе');
    }).catch(() => cb.onError('VK: не удалось загрузить API плеера, ролик играет без синхронизации'));

    return {
      play: () => run(() => pl.play()),
      pause: () => run(() => pl.pause()),
      seek: (t) => { trk.set(t, trk.isPlaying()); run(() => pl.seek(t)); },
      time: () => trk.get(),
      paused: () => !trk.isPlaying(),
      destroy: () => { dead = true; f.remove(); },
    };
  }

  window.createEmbed = function createEmbed({ host, onPlay, onPause, onSeek, onEnded, onError }) {
    let inner = null;
    const cb = { onPlay, onPause, onSeek, onEnded, onError };
    const impl = { yt: youtube, rt: rutube, vk };
    const noop = () => {};
    return {
      load(ep, pos, play) {
        inner = impl[ep.p](host, ep, pos || 0, !!play, cb);
      },
      play() { inner && inner.play(); },
      pause() { inner && inner.pause(); },
      seek(t) { inner && inner.seek(t); },
      time() { return inner ? inner.time() : 0; },
      paused() { return inner ? inner.paused() : true; },
      destroy() { if (inner) { (inner.destroy || noop)(); inner = null; } },
    };
  };
})();
