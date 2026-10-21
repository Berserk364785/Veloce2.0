'use strict';
/* Разбор ссылок на YouTube / Rutube / VK Видео.
   Возвращает { p: 'yt'|'rt'|'vk', id, ... } или null, если ссылка не оттуда.
   Клиент строит адрес плеера только из этих проверенных полей, а не из исходной ссылки. */

const YT_ID = /^[\w-]{11}$/;
const RT_ID = /^[a-f0-9]{32}$/i;
const RT_KEY = /^[\w-]{1,64}$/;

const hostIs = (h, list) => list.some((x) => h === x || h.endsWith('.' + x));

function parseEmbed(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  /* YouTube */
  if (h === 'youtu.be') {
    return YT_ID.test(parts[0] || '') ? { p: 'yt', id: parts[0] } : null;
  }
  if (hostIs(h, ['youtube.com', 'youtube-nocookie.com'])) {
    let id = '';
    if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) id = parts[1] || '';
    return YT_ID.test(id) ? { p: 'yt', id } : null;
  }

  /* Rutube */
  if (hostIs(h, ['rutube.ru'])) {
    let id = '';
    if (parts[0] === 'video' && parts[1] === 'private') id = parts[2] || '';
    else if (parts[0] === 'video' || parts[0] === 'shorts') id = parts[1] || '';
    else if (parts[0] === 'play' && parts[1] === 'embed') id = parts[2] || '';
    if (!RT_ID.test(id)) return null;
    const key = u.searchParams.get('p') || '';
    const out = { p: 'rt', id: id.toLowerCase() };
    if (key && RT_KEY.test(key)) out.key = key;
    return out;
  }

  /* VK Видео */
  if (hostIs(h, ['vk.com', 'vk.ru', 'vkvideo.ru'])) {
    let oid = '', id = '', hash = u.searchParams.get('hash') || '';
    if (parts[0] === 'video_ext.php') {
      oid = u.searchParams.get('oid') || '';
      id = u.searchParams.get('id') || '';
    } else {
      // vk.com/video-123_456, vk.com/video?z=video-123_456..., vkvideo.ru/video-123_456
      const hay = decodeURIComponent(parts[0] || '') + ' ' + decodeURIComponent(u.searchParams.get('z') || '');
      const m = /video(-?\d{1,12})_(\d{1,12})(?:_([a-f0-9]{8,32}))?/.exec(hay);
      if (m) { oid = m[1]; id = m[2]; if (!hash && m[3]) hash = m[3]; }
    }
    if (!/^-?\d{1,12}$/.test(oid) || !/^\d{1,12}$/.test(id)) return null;
    const out = { p: 'vk', id: oid + '_' + id };
    if (/^[a-f0-9]{8,32}$/i.test(hash)) out.hash = hash.toLowerCase();
    return out;
  }
  return null;
}

module.exports = { parseEmbed };
