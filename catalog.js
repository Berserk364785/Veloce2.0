'use strict';
/* Метаданные каталога: Shikimori (аниме, ключ не нужен) и TMDB (фильмы/сериалы, нужен бесплатный ключ).
   Здесь только описания и постеры — видео сюда не подтягивается (см. data/sources.json). */

const TTL = 10 * 60 * 1000;
const cache = new Map();

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return v;
}

async function getJson(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Veloce/1.0', Accept: 'application/json', ...headers }, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

const KIND_RU = { tv: 'Сериал', movie: 'Фильм', ova: 'OVA', ona: 'ONA', special: 'Спецвыпуск', tv_special: 'ТВ-спецвыпуск', music: 'Клип' };

async function shikimori({ q, page }) {
  return cached(`shiki|${q}|${page}`, async () => {
    const p = new URLSearchParams({ limit: '24', page: String(page), order: 'popularity', censored: 'true' });
    if (q) p.set('search', q);
    const list = await getJson('https://shikimori.io/api/animes?' + p);
    const items = list.map((a) => ({
      key: 'shiki:' + a.id,
      title: a.russian || a.name,
      year: (a.aired_on || '').slice(0, 4),
      poster: a.image && a.image.original ? 'https://shikimori.io'' + a.image.original : null,
      rating: a.score ? Number(a.score) : null,
      kind: KIND_RU[a.kind] || 'Аниме',
      type: 'anime',
    }));
    return { items };
  });
}

async function tmdb({ q, page }) {
  const key = process.env.TMDB_API_KEY;
  if (!key) return { items: [], disabled: true };
  return cached(`tmdb|${q}|${page}`, async () => {
    const bearer = key.length > 40; // v4-токен (JWT) или v3-ключ
    const p = new URLSearchParams({ language: 'ru-RU', page: String(page), include_adult: 'false' });
    if (!bearer) p.set('api_key', key);
    const url = q
      ? `https://api.themoviedb.org/3/search/multi?${p}&query=${encodeURIComponent(q)}`
      : `https://api.themoviedb.org/3/trending/all/week?${p}`;
    const j = await getJson(url, bearer ? { Authorization: 'Bearer ' + key } : {});
    const items = (j.results || [])
      .filter((x) => x.media_type === 'movie' || x.media_type === 'tv')
      .map((x) => ({
        key: `tmdb:${x.media_type}:${x.id}`,
        title: x.title || x.name,
        year: (x.release_date || x.first_air_date || '').slice(0, 4),
        poster: x.poster_path ? 'https://image.tmdb.org/t/p/w342' + x.poster_path : null,
        rating: x.vote_average ? Math.round(x.vote_average * 10) / 10 : null,
        kind: x.media_type === 'tv' ? 'Сериал' : 'Фильм',
        type: 'movie',
      }));
    return { items };
  });
}

/* Прокси картинок: постеры грузятся через наш сервер (быстрее и надёжнее, чем напрямую из браузера) */
const IMG_HOSTS = ['image.tmdb.org', 'shikimori.io'];
function imgAllowed(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && IMG_HOSTS.some((h) => x.hostname === h || x.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}
const proxied = (u) => (u && imgAllowed(u) ? '/img?u=' + encodeURIComponent(u) : u || null);

async function fetchImage(u) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'Veloce/1.0' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const type = r.headers.get('content-type') || '';
    if (!type.startsWith('image/')) throw new Error('not an image');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('too large');
    return { type, buf };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { shikimori, tmdb, imgAllowed, proxied, fetchImage };
