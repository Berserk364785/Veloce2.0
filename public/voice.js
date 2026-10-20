/* Veloce — голосовой звонок и камера (WebRTC, «каждый с каждым»).
   Сервер только пересылает сигналы; звук и видео идут напрямую между участниками.
   Схема «perfect negotiation» — устойчива к одновременным звонкам друг другу. */
(function () {
  'use strict';

  window.createVoice = function createVoice({ net, getMyId, onChange, toast }) {
    let on = false, muted = false, cam = false, listenOnly = false;
    let local = null, camTrack = null, iceList = null;
    const peers = new Map();
    const levels = new Map();
    const speaking = new Set();
    let ac = null;
    const audioBin = document.getElementById('audioBin');

    const sig = (to, data) => net.emit('voice:signal', { to, data });

    async function getIce() {
      if (iceList) return iceList;
      try { iceList = (await (await fetch('/api/config')).json()).iceServers; }
      catch { iceList = [{ urls: 'stun:stun.l.google.com:19302' }]; }
      return iceList;
    }

    /* ---------- индикатор «говорит» ---------- */
    function watch(id, stream) {
      if (levels.has(id) || !stream.getAudioTracks().length) return;
      try {
        ac = ac || new (window.AudioContext || window.webkitAudioContext)();
        if (ac.state === 'suspended') ac.resume();
        const an = ac.createAnalyser();
        an.fftSize = 256;
        ac.createMediaStreamSource(stream).connect(an);
        levels.set(id, { an, buf: new Uint8Array(an.frequencyBinCount) });
      } catch { /* без индикатора можно жить */ }
    }
    setInterval(() => {
      let changed = false;
      levels.forEach((l, id) => {
        l.an.getByteFrequencyData(l.buf);
        let sum = 0;
        for (const v of l.buf) sum += v;
        const sp = sum / l.buf.length > 14;
        if (sp !== speaking.has(id)) { sp ? speaking.add(id) : speaking.delete(id); changed = true; }
      });
      if (changed) onChange();
    }, 200);

    /* ---------- соединения с участниками ---------- */
    function attachAudio(p, stream) {
      if (!p.audioEl) {
        const a = document.createElement('audio');
        a.autoplay = true; a.playsInline = true;
        audioBin.appendChild(a);
        p.audioEl = a;
      }
      p.audioEl.srcObject = stream;
      const pr = p.audioEl.play();
      if (pr && pr.catch) pr.catch(() => {});
    }

    function ensurePeer(id) {
      let p = peers.get(id);
      if (p) return p;
      const pc = new RTCPeerConnection({ iceServers: iceList || [] });
      p = { id, pc, polite: String(getMyId()) < String(id), making: false, ignore: false, stream: null, audioEl: null, camSender: null };
      peers.set(id, p);

      local.getTracks().forEach((t) => {
        const s = pc.addTrack(t, local);
        if (t.kind === 'video') p.camSender = s;
      });
      if (!local.getAudioTracks().length) pc.addTransceiver('audio', { direction: 'recvonly' });

      pc.onnegotiationneeded = async () => {
        try {
          p.making = true;
          await pc.setLocalDescription();
          sig(id, { description: pc.localDescription });
        } catch (e) { console.warn('negotiation', e); }
        finally { p.making = false; }
      };
      pc.onicecandidate = (e) => { if (e.candidate) sig(id, { candidate: e.candidate }); };
      pc.ontrack = (e) => {
        const stream = e.streams[0] || new MediaStream([e.track]);
        p.stream = stream;
        if (e.track.kind === 'audio') { attachAudio(p, stream); watch(id, stream); }
        onChange();
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') { try { pc.restartIce(); } catch { /* нет */ } }
      };
      return p;
    }

    function closePeer(id) {
      const p = peers.get(id);
      if (!p) return;
      try { p.pc.close(); } catch { /* уже закрыто */ }
      if (p.audioEl) { p.audioEl.srcObject = null; p.audioEl.remove(); }
      levels.delete(id); speaking.delete(id);
      peers.delete(id);
    }

    net.on('voice:signal', async ({ from, data }) => {
      if (!on || !data) return;
      const p = ensurePeer(from);
      const pc = p.pc;
      try {
        if (data.description) {
          const collision = data.description.type === 'offer' && (p.making || pc.signalingState !== 'stable');
          p.ignore = !p.polite && collision;
          if (p.ignore) return;
          await pc.setRemoteDescription(data.description);
          if (data.description.type === 'offer') {
            await pc.setLocalDescription();
            sig(from, { description: pc.localDescription });
          }
        } else if (data.candidate) {
          try { await pc.addIceCandidate(data.candidate); }
          catch (e) { if (!p.ignore) console.warn('ice', e); }
        }
      } catch (e) { console.warn('signal', e); }
    });

    /* ---------- управление ---------- */
    async function join() {
      if (on) return;
      await getIce();
      local = new MediaStream();
      listenOnly = false;
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        s.getAudioTracks().forEach((t) => local.addTrack(t));
      } catch {
        listenOnly = true;
        toast('Нет доступа к микрофону — вы слушаете без голоса');
      }
      on = true; muted = false; cam = false;
      if (!listenOnly) watch(getMyId(), local);
      net.emit('voice:join', null, (res) => { ((res && res.peers) || []).forEach((id) => ensurePeer(id)); });
      onChange();
    }

    function teardown() {
      const wasOn = on;
      on = false; cam = false; muted = false;
      [...peers.keys()].forEach(closePeer);
      if (local) local.getTracks().forEach((t) => t.stop());
      local = null; camTrack = null;
      levels.delete(getMyId()); speaking.clear();
      if (wasOn) onChange();
    }

    function leave() {
      if (!on) return;
      net.emit('voice:leave');
      teardown();
    }

    function toggleMute() {
      if (!on || listenOnly) return;
      muted = !muted;
      local.getAudioTracks().forEach((t) => { t.enabled = !muted; });
      net.emit('voice:mute', { v: muted });
      onChange();
    }

    async function toggleCam() {
      if (!on) return;
      if (!cam) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 }, facingMode: 'user' } });
          camTrack = s.getVideoTracks()[0];
        } catch { toast('Нет доступа к камере'); return; }
        local.addTrack(camTrack);
        peers.forEach((p) => { p.camSender = p.pc.addTrack(camTrack, local); });
        camTrack.onended = () => { if (cam) toggleCam(); };
        cam = true;
      } else {
        cam = false;
        if (camTrack) { camTrack.onended = null; camTrack.stop(); local.removeTrack(camTrack); }
        peers.forEach((p) => {
          if (p.camSender) { try { p.pc.removeTrack(p.camSender); } catch { /* нет */ } p.camSender = null; }
        });
        camTrack = null;
      }
      net.emit('voice:cam', { v: cam });
      onChange();
    }

    /* Список участников изменился: закрываем соединения с теми, кто вышел из звонка */
    function sync(list) {
      if (on) {
        const inVoice = new Set(list.filter((m) => m.voice).map((m) => m.id));
        [...peers.keys()].forEach((id) => { if (!inVoice.has(id)) closePeer(id); });
      }
      onChange();
    }

    window.addEventListener('pagehide', () => { if (on) net.emit('voice:leave'); });

    return {
      join, leave, toggleMute, toggleCam, sync, teardown,
      isOn: () => on, isMuted: () => muted, isCam: () => cam, isListenOnly: () => listenOnly,
      isSpeaking: (id) => speaking.has(id),
      streamFor: (id) => (id === getMyId() ? local : (peers.get(id) || {}).stream || null),
    };
  };
})();
