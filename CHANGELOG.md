# Changelog

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
