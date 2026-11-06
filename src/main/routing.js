'use strict';

/**
 * Decides which backend a URL should go to.
 *
 *   direct    -> aria2, it is a file or a magnet
 *   x         -> the built-in X resolver, then aria2
 *   youtube   -> declined outright
 *   extractor -> a site we know yt-dlp handles
 *   probe     -> unknown, ask yt-dlp; fall back to aria2 if it is not a media page
 */

const { isXUrl } = require('./resolvers/x');
const { isYouTubeUrl } = require('./unsupported');
const { isExtractorUrl } = require('./ytdlp');

const DIRECT_FILE =
  /\.(zip|dmg|pkg|7z|rar|tar|tgz|gz|bz2|xz|zst|iso|exe|msi|apk|deb|rpm|pdf|epub|mp4|m4v|mkv|avi|mov|webm|flv|mp3|flac|wav|m4a|aac|ogg|opus|png|jpe?g|gif|webp|svg|txt|csv|json|xml|srt|vtt|torrent|bin|img)(?:[?#]|$)/i;

function classify(url) {
  const value = String(url || '').trim();

  if (/^magnet:/i.test(value)) return 'direct';
  if (isXUrl(value)) return 'x';
  if (isYouTubeUrl(value)) return 'youtube';
  if (isExtractorUrl(value)) return 'extractor';
  if (DIRECT_FILE.test(value)) return 'direct';

  return 'probe';
}

module.exports = { classify, DIRECT_FILE };
