# Developing Dung

Everything behind the one paste box: how to build it, how it works, what it talks to, and how it is tested. For the look, the words and the motion, read the [design guide](DESIGN.md).

## Install details

The downloader ([aria2](https://aria2.github.io/)) ships inside the app (`Contents/Resources/bin/aria2c` on macOS, `resources\bin\aria2c.exe` on Windows).

If that copy ever goes missing (antivirus quarantine, a damaged install), Home shows a
**Quick fix** card: on Windows it re-downloads the official `aria2-*-win-64bit` zip into
`%APPDATA%\Dung\bin`; on macOS it points you to the latest release to reinstall. Power users can
point Dung at their own build under *Settings → Advanced*.

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

## First launch, in full

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
cd ddddd
npm install
npm run vendor     # put aria2c into vendor/bin (compiles it on macOS, ~2 min)
npm start          # run in development
npm run dist       # produce dist/Dung-<version>-arm64.dmg
```

Requires Node 18+. Packaging the DMG needs macOS with the Xcode command-line tools
(`xcode-select --install`) because aria2 is compiled from source. In development, any aria2c on
your `PATH` works too.

The app icon is pixel art drawn in code — a sparkling swirl of golden dung, in the golden-trail
colours of the progress bar. Regenerate `build/icon.png` and `build/icon.icns`
(all macOS sizes, no Mac tools needed) with:

```sh
node scripts/make-icon.js
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

An unknown link shows a *sniffing it out…* row immediately (looping beetle, cancellable) while the probe
runs; it never looks like the button did nothing. After 12 seconds the row says the source is slow,
and at 45 seconds it gives up — real sites routinely take 25–30 seconds to answer, so cutting earlier
would break them.

Because the router asks yt-dlp instead of matching hostnames, new sites generally work without a code
change. yt-dlp is downloaded on demand with one click ("Add video support"). Some sites serve
picture and sound as separate streams; if [ffmpeg](https://ffmpeg.org/) happens to be on your
machine, Dung uses it to merge the best of both, and otherwise it takes the best single file that
already has both — so videos download either way, with nothing extra to install.

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

## Under the shell

<p><a href="https://github.com/xfanwu/ddddd/actions/workflows/build.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/xfanwu/ddddd/build.yml?style=flat-square&label=build"></a> <img alt="aria2 bundled" src="https://img.shields.io/badge/aria2-1.37%20bundled-111111?style=flat-square"> <img alt="Electron 33" src="https://img.shields.io/badge/Electron-33-111111?style=flat-square"></p>

### Why the defaults are what they are

aria2 is excellent and its command line is hostile. Wrapping it badly is easy, and the failure mode is silent:

- `~/.aria2/aria2.conf` is read by default, so a stray `enable-rpc=true` or `split=10` changes what your app does.
- With 16 parallel connections, some CDNs return mismatched byte ranges. You get a file that is *exactly* the right size and still corrupt.
- `--file-allocation=none` truncates the file to full length immediately, so `ls -l` proves nothing.
- A stalled range can leave the daemon running forever while the download looks complete.

Dung exists because an 845 MB DMG came down at 100% and macOS refused to open it. Every default here is a response to one of those failures:

| | |
|---|---|
| **Isolated engine** | Each launch spawns its own `aria2c` with `--no-conf=true`, a random localhost port, and a per-run RPC secret. Your global config cannot hijack it. |
| **Safe concurrency** | 4 connections / 4 splits by default. The slider (Settings → Advanced) warns loudly above 8 — the point where CDNs start corrupting large files. |
| **Real progress** | Reads `completedLength` over RPC instead of trusting file size. |
| **Disk image verification** | Every finished `.dmg` is checked with `hdiutil verify`; the row reports `checksum ok` or the failure reason. |
| **Existing files** | If the target already exists, choose Cancel, Overwrite, or Keep Both instead of getting a failed download. |
| **Resumable queue** | `--save-session` / `--input-file` persist the queue; interrupted downloads resume on next launch. |
| **Live settings** | Connections, split, speed limit and folder go through `changeGlobalOption`, so active downloads keep running. |
| **Bundled, pinned aria2** | macOS builds compile checksum-pinned aria2 source against system libraries only; Windows uses the pinned official build. A missing copy is repaired in one click on Windows. |

### Code map

```
src/main/aria2.js              aria2c process + JSON-RPC client, polling, pause/resume, session
src/main/installer.js          repair path: re-downloads aria2c on Windows if the bundled copy is gone
src/main/resolvers/x.js        turns x.com/twitter.com status URLs into direct MP4 links
src/main/updater.js            GitHub Releases check, asset selection, download
src/main/ytdlp.js              extractor backend for DASH sites (TikTok, Instagram, …)
src/main/routing.js            decides aria2 vs resolver vs yt-dlp vs decline
src/main/unsupported.js        sites the app declines, with a user-facing reason
src/main/main.js               Electron main: window, IPC, settings/history, hdiutil verification
src/main/preload.js            contextBridge API — the renderer gets no Node access
src/renderer/*                 vanilla HTML/CSS/JS, no bundler, no framework
src/renderer/dung-progress.js  the <dung-progress> pixel beetle, a dependency-free web component
scripts/vendor-aria2.js        build step: puts a pinned, self-contained aria2c into vendor/bin
scripts/smoke-engine.js        headless engine test (ARIA2C=… to test a specific binary)
```

The renderer never talks to aria2 directly. Every call crosses IPC, so the RPC secret stays in the
main process and the UI cannot be tricked into issuing arbitrary RPC.

Progress comes from `aria2.tellStatus`, split and connection settings are remembered at queue time
because aria2 does not report them back through `tellStatus`.

### Testing

There is no test runner — the checks are real downloads through the real engine.

```sh
node scripts/smoke-engine.js                   # spawn, download, verify bytes, pause, resume, remove, shutdown
node scripts/smoke-x.js                        # resolve a real X post, download it, check the MP4 header
npm run test:ui                                # replay Home/lanes/finish/recovery flows in headless Chromium
npm run test:app                               # the real app + bundled aria2 + a local server: 36 edge cases
                                               # (duplicates, conflicts, pause, cancel, 404, crash, relaunch…)
                                               # on Linux without a display: xvfb-run -a npm run test:app

# extractor path (needs yt-dlp on PATH or in settings):
#   paste a TikTok/Instagram URL into the app, or drive it with SMOKE_URL

SMOKE_TEST=1 SMOKE_UPDATE=1 npx electron .                    # hit the real GitHub Releases API
SMOKE_TEST=1 SMOKE_UPDATE=1 SMOKE_UPDATE_DOWNLOAD=1 npx electron .   # download the update asset

SMOKE_TEST=1 npx electron .                    # window boots, engine reports ready
SMOKE_TEST=1 SMOKE_DOWNLOAD=1 npx electron .   # IPC -> download -> rendered row
ARIA2C_FORCE_MISSING=1 SMOKE_TEST=1 SMOKE_INSTALL=1 npx electron .   # install flow
```

Before packaging, bundle aria2 (CI does this automatically):

```sh
npm run vendor                                   # build/fetch aria2c into vendor/bin
ARIA2C=vendor/bin/aria2c node scripts/smoke-engine.js   # real download through the bundled copy
```

Chrome developer tools (and View → Reload) exist only in development (`npm start`). Released builds
have them switched off; to inspect a release anyway, launch it with `DUNG_DEVTOOLS=1`
(e.g. `DUNG_DEVTOOLS=1 /Applications/Dung.app/Contents/MacOS/Dung`). `DUNG_DEVTOOLS=0` turns them off
in development to check the release setup.

`ARIA2C_FORCE_MISSING=1` makes the *first* binary lookup fail so the install-then-redetect path can
be exercised on a machine that already has aria2.

### Notes on safety

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

## Contributing

PRs welcome. Keep it simple: one obvious action per screen, no new colours outside the beetle,
no jargon on the surface. The [design guide](DESIGN.md) has the tokens and the checklist.

## License

[MIT](../LICENSE) © 2026 xfanwu

### Third-party licenses

Dung bundles an unmodified **[aria2](https://aria2.github.io/) 1.37.0** (© Tatsuhiro Tsujikawa and
contributors), licensed under the **GNU GPL v2 or later**. Dung runs it as a separate program, so
Dung's own code stays MIT. The GPL text ships next to the binary (`bin/licenses/`), and the exact
source tarball (`aria2-1.37.0.tar.xz`) is attached to every [release](https://github.com/xfanwu/ddddd/releases).
You can swap in your own aria2 build under *Settings → Advanced*.

The brand typeface is **[Pixelify Sans](https://github.com/eifetx/Pixelify-Sans)** © The Pixelify Sans
Project Authors, under the SIL Open Font License 1.1 (`src/renderer/fonts/OFL.txt`).
