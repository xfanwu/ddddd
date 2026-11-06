'use strict';

/**
 * Resolves an X / Twitter status URL into direct MP4 URLs that aria2 can fetch.
 *
 * X serves video as HLS (.m3u8), which aria2 cannot consume. Fortunately the
 * embedded-player payload also lists plain MP4 renditions, and the official
 * syndication endpoint exposes them without any API key:
 *
 *   https://cdn.syndication.twimg.com/tweet-result?id=<status>&token=a
 *
 * A third-party mirror (api.fxtwitter.com) is used only as a fallback, so a
 * change in one source does not break downloads outright.
 */

const TIMEOUT_MS = 15000;

const STATUS_PATTERN =
  /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:#!\/)?[^/]+\/status(?:es)?\/(\d+)/i;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function parseStatusUrl(url) {
  const match = STATUS_PATTERN.exec(String(url || '').trim());
  return match ? { id: match[1] } : null;
}

function isXUrl(url) {
  return Boolean(parseStatusUrl(url));
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  return response.json();
}

function variantsFromSyndication(payload) {
  const media = Array.isArray(payload.mediaDetails) ? payload.mediaDetails : [];
  const videos = [];

  for (const entry of media) {
    if (!entry || entry.type !== 'video') continue;
    const variants = ((entry.video_info || {}).variants || []).filter(
      (variant) => variant.content_type === 'video/mp4' && variant.url
    );
    if (!variants.length) continue;

    variants.sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));
    videos.push({
      url: variants[0].url,
      bitrate: Number(variants[0].bitrate || 0),
      hls: ((entry.video_info || {}).variants || []).some(
        (variant) => variant.content_type === 'application/x-mpegURL'
      ),
    });
  }

  return { videos, author: (payload.user || {}).screen_name || '' };
}

function variantsFromFx(payload) {
  const tweet = payload.tweet || {};
  const videos = ((tweet.media || {}).videos || [])
    .filter((video) => video && video.url)
    .map((video) => ({ url: video.url, bitrate: Number(video.bitrate || 0), hls: false }));

  return { videos, author: (tweet.author || {}).screen_name || '' };
}

function safeName(value) {
  return String(value || 'x').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 40);
}

/**
 * @returns {Promise<{items: Array<{url: string, out: string}>, author: string}>}
 */
async function resolveX(url, onLog = () => {}) {
  const parsed = parseStatusUrl(url);
  if (!parsed) throw new Error('Not an X status URL');

  const { id } = parsed;
  let result = null;

  try {
    onLog(`[x] resolving ${id} via syndication`);
    result = variantsFromSyndication(
      await getJson(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=a`)
    );
  } catch (err) {
    onLog(`[x] syndication failed: ${err.message}`);
  }

  if (!result || !result.videos.length) {
    try {
      onLog(`[x] falling back to fxtwitter for ${id}`);
      result = variantsFromFx(await getJson(`https://api.fxtwitter.com/status/${id}`));
    } catch (err) {
      onLog(`[x] fallback failed: ${err.message}`);
    }
  }

  if (!result || !result.videos.length) {
    throw new Error('No downloadable video in this post (it may be an image or HLS-only).');
  }

  const author = safeName(result.author || 'x');
  const items = result.videos.map((video, index) => ({
    url: video.url,
    out: result.videos.length > 1 ? `${author}-${id}-${index + 1}.mp4` : `${author}-${id}.mp4`,
  }));

  onLog(`[x] ${items.length} video rendition(s) for ${author}/${id}`);
  return { items, author, id };
}

module.exports = { resolveX, isXUrl, parseStatusUrl };
