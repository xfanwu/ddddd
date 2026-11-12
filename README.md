# Dung

A native macOS download manager powered by [aria2](https://aria2.github.io/) — with a pixel dung beetle that rolls a growing ball across the progress bar as your files come down, and a white-on-white interface that stays out of the way.

<p>
  <img alt="release" src="https://img.shields.io/github/v/release/xfanwu/ddddd?style=flat-square&color=0ea5e9">
  <img alt="downloads" src="https://img.shields.io/github/downloads/xfanwu/ddddd/total?style=flat-square&color=0ea5e9">
  <img alt="license" src="https://img.shields.io/github/license/xfanwu/ddddd?style=flat-square&color=0ea5e9">
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS%2011%2B%20%7C%20Windows%2010%2B-000000?style=flat-square&logo=apple&logoColor=white">
  <img alt="arch" src="https://img.shields.io/badge/arch-arm64%20%7C%20x64-0ea5e9?style=flat-square">
  <img alt="electron" src="https://img.shields.io/badge/Electron-33-47848F?style=flat-square&logo=electron&logoColor=white">
  <img alt="aria2" src="https://img.shields.io/badge/aria2-1.37%2B-0ea5e9?style=flat-square">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square">
</p>

![Dung main window](docs/screenshot-main.png)

*Idle: the beetle waits at the start of the track.*

![idle](docs/screenshot-idle.png)

## Why this exists

aria2 is excellent and its command line is hostile. Wrapping it badly is easy, and the failure mode is silent:

- `~/.aria2/aria2.conf` is read by default, so a stray `enable-rpc=true` or `split=10` changes what your app does.
- With 16 parallel connections, some CDNs return mismatched byte ranges. You get a file that is *exactly* the right size and still corrupt.
- `--file-allocation=none` truncates the file to full length immediately, so `ls -l` proves nothing.
- A stalled range can leave the daemon running forever while the download looks complete.

This app exists because an 845 MB DMG came down at 100% and macOS refused to open it. Every default here is a response to one of those failures.

## Features

| | |
|---|---|
| **Beetle progress** | A pixel dung beetle pushes a ball that grows as progress advances. At 100% it climbs on top for a little dance. Home and history sit one click apart. |
| **Isolated engine** | Each launch spawns its own `aria2c` with `--no-conf=true`, a random localhost port, and a per-run RPC secret. Your global config cannot hijack it. |
| **Safe concurrency** | 4 connections / 4 splits by default. The slider warns loudly above 8 — the point where CDNs start corrupting large files. |
| **Disk image verification** | Every finished `.dmg` is checked with `hdiutil verify`; the row reports `checksum ok` or the failure reason. |
| **Existing files** | If the target file already exists, choose Cancel, Overwrite, or Keep Both instead of getting a failed download. |
| **Visible internals** | Live split count and active thread count per download, plus a total in the header. |
| **Resumable queue** | `--save-session` / `--input-file` persist the queue; interrupted downloads resume on next launch. |
| **Live settings** | Changing connections, split, speed limit or folder goes through `changeGlobalOption`, so active downloads keep running. |
| **One-click recovery** | If `aria2c` is missing, the app installs it: Homebrew on macOS, the official upstream zip on Windows. |
| **Real progress** | Reads `completedLength` over RPC instead of trusting file size. |
| **Update checks** | Compares the running version against GitHub Releases on launch and every 6 hours; downloads the matching DMG or setup.exe for you. |
| **X / Twitter videos** | Paste a status link and it resolves the direct `video.twimg.com` MP4 renditions. HLS-only posts are reported clearly instead of failing silently. |
| **Any site yt-dlp understands** | Not a fixed list: unknown links are probed, with a `detecting` row you can cancel. Around 1,750 extractors come along for free. |

| Settings | Engine offline |
|---|---|
| ![settings](docs/screenshot-settings.png) | ![offline](docs/screenshot-offline.png) |

## Install

Download the latest build from [**Releases**](https://github.com/xfanwu/ddddd/releases).

**macOS (Apple Silicon)** — open the DMG and drag **Dung** to *Applications*.

```sh
curl -L -o Dung.dmg https://github.com/xfanwu/ddddd/releases/latest/download/Dung-1.5.0-arm64.dmg
open Dung.dmg
```

**Windows (x64)** — run the `-setup.exe` installer, or use the portable `.exe` if you don't want
anything written to Program Files.

The app needs an `aria2c` binary. It finds Homebrew, MacPorts, Chocolatey, Scoop, `/usr/local/bin`,
a bundled `Contents/Resources/bin/aria2c`, or whatever path you set in Settings. If it finds nothing,
the window offers a **Download aria2** button:

- **macOS** runs `brew install aria2`.
- **Windows** downloads the official `aria2-*-win-64bit` zip from GitHub and unpacks `aria2c.exe`
  into `%APPDATA%\Dung\bin`, so no package manager is required.

### First launch

**macOS** builds are ad-hoc signed but not notarized, so Gatekeeper blocks them once:

```sh
xattr -dr com.apple.quarantine "/Applications/Dung.app"
```

Or right-click the app → **Open** → **Open**.

If macOS says the app **"is damaged and can't be opened"**, that is not a bad download — it is
Gatekeeper reacting to an incomplete signature. Releases up to 1.3.0 shipped without a bundle
signature; 1.4.0 and later are ad-hoc signed at build time (`scripts/after-pack.js`). Repair an
already-installed copy without re-downloading:

```sh
xattr -dr com.apple.quarantine "/Applications/Dung.app"
codesign --force --deep --sign - "/Applications/Dung.app"
```

A signed build still shows "unidentified developer" on first launch. Only a Developer ID plus
notarization removes that prompt.

**Windows** builds are unsigned too — SmartScreen shows "Windows protected your PC". Choose
**More info** → **Run anyway**.

## Build from source

```sh
git clone https://github.com/xfanwu/ddddd.git
cd Dung
npm install
npm start          # run in development
npm run dist       # produce dist/Dung-1.5.0-arm64.dmg
```

Requires Node 18+ and macOS. The icon is rendered from an emoji, so you can change it:

```sh
# edit EMOJI in scripts/make-icon.js, then
npx electron scripts/make-icon.js
cd build && iconutil -c icns icon.iconset -o icon.icns
```

## Privacy

This app is deliberately anonymous. There is no account system, no sign-in, no cookies, and no
telemetry.

- It never reads browser cookies and never asks for credentials.
- Outbound requests are limited to: the URL you paste, the media host it points at, and
  `api.github.com` for update checks.
- Local state is `settings.json`, `history.json`, and the aria2 session file in your app-support
  folder. Nothing is reported anywhere; there is no server component.

YouTube is intentionally **not** supported. Its terms forbid downloading, and every workaround
(cookies, accounts, headless browsers) requires tying your identity to the request. Rather than ship a
feature that half-works and leaks an account, the app declines the link outright:

> YouTube downloading is not supported due to restrictions from YouTube's side.

## Supported sites

Routing is by shape, not by a hand-maintained whitelist:

| Input | Backend |
|---|---|
| Direct file, magnet | aria2 |
| X / Twitter status | built-in resolver, then aria2 |
| TikTok, Instagram | yt-dlp |
| SoundCloud, Streamable, Dailymotion, and anything else yt-dlp knows | yt-dlp, discovered by probing |
| A link that is not a media page | yt-dlp probe fails, falls back to aria2 |
| YouTube | declined with a dialog |

An unknown link shows a `detecting` row immediately (indeterminate bar, cancellable) while the probe
runs; it never looks like the button did nothing. After 12 seconds the row says the source is slow,
and at 45 seconds it gives up — real sites routinely take 25–30 seconds to answer, so cutting earlier
would break them.

Because the router asks yt-dlp instead of matching hostnames, new sites generally work without a code
change. yt-dlp is downloaded on demand; ffmpeg is needed for merging separate audio/video streams
(`brew install ffmpeg`).

Sites that require an account — Vimeo, parts of Facebook and Twitch — produce an explicit error row
rather than a broken file. That is intentional: this app has no login.

YouTube links are rejected with a dialog and never queued.

## Updates

The app checks `api.github.com/repos/xfanwu/ddddd/releases/latest` shortly after launch and every
six hours. Settings has the current version plus a **Check for updates** button.

When something newer exists you get a banner with **Download**, which fetches the installer for your
platform into `~/Downloads` (or `%USERPROFILE%\Downloads`) and then offers **Open installer**.

One honest limitation: **silent self-replacement is not implemented.** macOS's Squirrel updater
refuses to swap in a bundle whose code signature does not match, and these builds are unsigned, so a
real in-place update would fail. Windows NSIS could do it, but the flow is kept identical on both
platforms for predictability. Signing the app with a Developer ID would unlock true background
updates.

Update checks send nothing but a plain anonymous HTTPS request to GitHub; there is no telemetry.

## How it works

```
src/main/aria2.js       aria2c process + JSON-RPC client, polling, pause/resume, session
src/main/installer.js   gets aria2c onto the machine (Homebrew on mac, upstream zip on Windows)
src/main/resolvers/x.js turns x.com/twitter.com status URLs into direct MP4 links
src/main/updater.js     GitHub Releases check, asset selection, download
src/main/ytdlp.js       extractor backend for DASH sites (TikTok, Instagram, …)
src/main/routing.js     decides aria2 vs resolver vs yt-dlp vs decline
src/main/unsupported.js sites the app declines, with a user-facing reason
src/main/main.js        Electron main: window, IPC, settings/history, hdiutil verification
src/main/preload.js     contextBridge API — the renderer gets no Node access
src/renderer/*          vanilla HTML/CSS/JS, no bundler, no framework
scripts/smoke-engine.js headless engine test
```

The renderer never talks to aria2 directly. Every call crosses IPC, so the RPC secret stays in the
main process and the UI cannot be tricked into issuing arbitrary RPC.

Progress comes from `aria2.tellStatus`, split and connection settings are remembered at queue time
because aria2 does not report them back through `tellStatus`.

## Testing

There is no test runner — the checks are real downloads through the real engine.

```sh
node scripts/smoke-engine.js                   # spawn, download, verify bytes, pause, resume, remove, shutdown
node scripts/smoke-x.js                        # resolve a real X post, download it, check the MP4 header

# extractor path (needs yt-dlp on PATH or in settings):
#   paste a TikTok/Instagram URL into the app, or drive it with SMOKE_URL

SMOKE_TEST=1 SMOKE_UPDATE=1 npx electron .                    # hit the real GitHub Releases API
SMOKE_TEST=1 SMOKE_UPDATE=1 SMOKE_UPDATE_DOWNLOAD=1 npx electron .   # download the update asset

SMOKE_TEST=1 npx electron .                    # window boots, engine reports ready
SMOKE_TEST=1 SMOKE_DOWNLOAD=1 npx electron .   # IPC -> download -> rendered row
ARIA2C_FORCE_MISSING=1 SMOKE_TEST=1 SMOKE_INSTALL=1 npx electron .   # install flow
```

`ARIA2C_FORCE_MISSING=1` makes the *first* binary lookup fail so the install-then-redetect path can
be exercised on a machine that already has aria2.

## Notes on safety

- Never trust a large download's size as proof of integrity. Run `hdiutil verify` (automatic here for
  `.dmg` on macOS), or compare a published SHA-256.
- X video downloads rely on X's embedded-player payload exposing MP4 renditions. Long or
  protected posts that are HLS-only cannot be fetched by aria2 at all; the app says so rather
  than writing a broken file.
- Disk-image verification is macOS-only; the toggle is hidden on Windows because `hdiutil` does not
  exist there.
- Above 8 connections you are gambling on CDN consistency. The app defaults to 4 for that reason.
- macOS builds are ad-hoc signed, not notarized; Windows builds are unsigned. macOS needs the quarantine flag cleared and Windows needs
  SmartScreen bypassed; both builds are reproducible from source.

## License

[MIT](LICENSE) © 2026 xfanwu

aria2 itself is GPL-2.0 and is **not** bundled — the app drives a separately installed binary.
