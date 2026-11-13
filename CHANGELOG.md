# Changelog

## 1.6.2 — Update checks that don't hit a wall

### Fixed
- **"Update check failed: GitHub API responded 403" is gone.** GitHub's API allows only 60 checks an hour per network, and shared networks (offices, proxies, VPNs) run out fast. When that happens Dung now asks GitHub's regular release page instead, which has no such limit — so it still finds the new version and downloads it.

> On 1.6.0 or 1.6.1 and seeing that 403? Download 1.6.2 from the release page once; checks work from here on.

## 1.6.1 — Updates that actually download

### Fixed
- **The Download button on the update banner works behind a proxy.** Update checks and downloads now go through your system proxy (Clash, Surge, a company proxy…) just like your browser does, so they work where GitHub is only reachable through one.
- **When an update can't download, Dung says why** — and offers **Open in browser** instead of quietly doing nothing.
- A failed background check no longer makes a visible update banner forget its installer.
- Update downloads give up after 30 seconds without data instead of hanging, and never leave a half-downloaded installer behind.

### Also
- Dung now lives at **github.com/xfanwu/dung** (the old address redirects), with a new home page at **xfanwu.github.io/dung**.

> If you are on 1.6.0 or older and the update banner's Download does nothing, grab 1.6.1 from the release page once — updates work from here on.

## 1.6.0 — Paste a link. It downloads.

Dung is rebuilt around one move, for people who have never used a download manager.

### New
- **Just paste.** Press ⌘V / Ctrl+V anywhere in the window, or drop a link on it — the download starts by itself.
- **Nothing to install.** The downloader (aria2 1.37) now ships inside the app. No Homebrew, no setup.
- **Several at once.** Each download gets its own little beetle lane; finished ones dance, then fold away.
- **History behind a sliding door.** Pull the list tab on the right edge (or ⌘]) and your past downloads slide in.
- **A finish screen that waits for you,** with Open and Show in folder.
- **You already have it?** Dung tells you, with Show file — or Download again, saved alongside.
- **Dung language:** downloads are *rolling*, queued ones wait *in line*, finished ones are *rolled home*.
- **New look:** black on white with the colourful pixel beetle, a pixel wordmark, and a golden pixel-dung app icon.
- **Simpler Settings:** where files go, a speed limit that understands "5 MB/s", and the rest tucked under Advanced.

### Fixed
- Dung could **overwrite a file of yours** that happened to share a download's name. It now asks: Cancel, Keep Both or Overwrite.
- Pasting the same link twice no longer starts a second copy (or risks deleting the one in progress).
- The finish screen sometimes showed the wrong file, flashed back to the start, or the beetle rolled backwards.
- Videos no longer need `brew install ffmpeg`.
- The page no longer jumps when a message appears; many smaller fixes from end-to-end testing.

### Under the hood
- Developer tools are off in release builds (`DUNG_DEVTOOLS=1` to debug).
- New test workflow: a real-app end-to-end suite runs on every change.
- aria2 is GPL-2.0-or-later; its licence ships in the app and its source is attached to this release.
