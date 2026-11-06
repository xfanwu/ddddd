'use strict';

/**
 * Sites this app intentionally does not support.
 *
 * YouTube is excluded on purpose: its terms forbid downloading, and every
 * workaround (cookies, accounts, headless browsers) requires tying the user's
 * identity to the request. The app is anonymous by design, so it declines
 * instead of pretending or half-working.
 */

const YOUTUBE_PATTERNS = [
  /^https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\//i,
  /^https?:\/\/youtu\.be\//i,
  /^https?:\/\/youtube-nocookie\.com\//i,
];

const MESSAGE =
  "YouTube downloading is not supported due to restrictions from YouTube's side.";

function isYouTubeUrl(url) {
  const value = String(url || '').trim();
  return YOUTUBE_PATTERNS.some((pattern) => pattern.test(value));
}

module.exports = { isYouTubeUrl, YOUTUBE_MESSAGE: MESSAGE };
