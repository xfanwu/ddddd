# Dung design guide

Dung does one thing: **paste a link → it downloads**. Every screen should make that move
obvious to someone who has never used a download manager. When in doubt, remove.

The interface is **black ink on white paper**. The only colour in the app belongs to the
beetle, its ball and the golden trail. That contrast is the brand: keep chrome monochrome
so the beetle stays the hero.

Source of truth: [`src/renderer/styles.css`](../src/renderer/styles.css) and
[`src/renderer/dung-progress.js`](../src/renderer/dung-progress.js). If this page and the
code disagree, fix one of them in the same pull request.

---

## Principles

1. **One obvious action per state.** Idle → paste. Downloading → wait (Pause / Cancel are
   secondary). Finished → **Open**. The primary action is the only solid black button.
2. **No jargon on the surface.** Threads, splits, binaries and logs live under
   *Settings → Advanced* or in History. The home page says "queued", "done", "Show in folder".
3. **It just goes.** Pasting a link (in the box, anywhere in the window, or by drag and drop)
   starts the download. Never add a confirmation step to the main flow.
4. **Monochrome chrome, colourful beetle.** Do not introduce new accent colours. Red is
   reserved for errors and destructive buttons.
5. **Motion explains, never decorates.** Animate only when something moves, appears or
   changes state, and always respect `prefers-reduced-motion`.

---

## Colour tokens

Defined on `:root` in `styles.css`. Use the variable, never the raw value.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#ffffff` | Window background |
| `--surface` | `#ffffff` | Cards, dialogs, inputs |
| `--surface-alt` | `#fafafa` | Notes, log panel, hover on ghost buttons |
| `--surface-strong` | `rgba(0,0,0,.05)` | Segmented control track, `.mini` buttons, hover fills |
| `--border` | `rgba(0,0,0,.09)` | Hairlines between rows and sections |
| `--border-strong` | `rgba(0,0,0,.16)` | Input and ghost-button outlines |
| `--text` | `#111111` | Body text, **and the primary/accent colour** |
| `--text-dim` | `#6b6b6b` | Secondary text, metadata, hints |
| `--accent` | `#111111` | Primary buttons, focus rings, switches (same ink as text) |
| `--accent-soft` | `rgba(0,0,0,.06)` | Focus halo |
| `--danger` | `#d92d20` | Errors, Overwrite, failed lanes |
| `--warning` | `#b54708` | Paused bars in History |

### Beetle palette (`--dp-*`)

Set once on the `dung-progress` selector in `styles.css`, so the hero bar and every lane
share it. The app is light-only, so these are pinned even when the OS is in dark mode.

| Token | Value | Part |
|---|---|---|
| `--dp-shell` | `#46348a` | Beetle shell |
| `--dp-sheen` | `#2fb8a6` | Teal highlight |
| `--dp-sheen-2` | `#8f66f2` | Violet highlight |
| `--dp-edge` / `--dp-leg` | `#1a1233` | Outline, near legs |
| `--dp-leg-far` | `#5a4a8a` | Far-side legs |
| `--dp-ball` | `#8a5a33` | Dung ball |
| `--dp-ball-light` / `--dp-ball-dark` | `#bb8750` / `#573720` | Ball shading and flecks |
| `--dp-track` / `--dp-track-shade` | `#e6e6e6` / `#d1d1d1` | **Empty** track (neutral grey, never purple) |
| `--dp-fill` / `--dp-fill-shade` | `#e2a23c` / `#b9791f` | Golden finished trail |
| `--dp-dust` | `#c4a779` | Dust kicked up while pushing |
| `--dp-ink` | `#111111` | Pixel percentage numerals |
| `--dp-spark` | `#e2a23c` | Sparkles at 100% |

The component also ships its own defaults (light and dark) inside `dung-progress.js` so it
works standalone. Change the app's look in `styles.css`; change the component's defaults
only if you mean to change the component for everyone.

---

## Typography

System stack: `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif`.
Monospace (paths, log, key caps): `ui-monospace, SFMono-Regular, Menlo, monospace`.
Numbers that tick (speed, sizes, percentages) use `font-variant-numeric: tabular-nums`.

| Role | Size / weight | Tracking | Where |
|---|---|---|---|
| Wordmark | 44px / 750 | −0.045em | Idle home |
| Dialog title | 22px / 650 (settings), 19px (alerts) | −0.02em | Modals |
| Current file | 18px / 650 | −0.01em | Home while downloading |
| Folder name | 17px / 650 | −0.01em | Settings folder card |
| Input / body | 15–16px / 400 | — | Paste box, rows |
| Lane name | 14px / 600 | — | Lanes |
| Meta | 12.5–13px / 400, `--text-dim` | — | Speed, size, hints |
| Eyebrow | 11.5px / 400, `--text-dim` | — | Small labels above values |
| Badge | 10.5px, uppercase, +0.05em | — | Status tags |

---

## Shape and spacing

- **Pill (`999px`)** for anything you press or type into on the main surfaces: paste box,
  primary/ghost buttons on Home, banners, Settings inputs, switches.
- **20px** radius for dialogs, **16px** for cards inside dialogs, **8px** for small
  utility controls (`.mini`, legacy inputs), **5px** for badges.
- Outlines: **2px `--text`** marks the one thing to act on (idle paste box, folder card);
  **1px `--border-strong`** for everything else.
- Focus on the paste box lifts it with a hard offset shadow: `6px 6px 0 var(--text)`.
- Spacing scale in use: 4 · 6 · 8 · 10 · 14 · 16 · 20 · 24px. Page gutters are 24px.
- Content column: `min(560px, 88%)` for the beetle, paste box and lanes.

---

## Components

| Class | Look | Use for |
|---|---|---|
| `.primary` | Solid black, white text | The single main action of a view (Download, Open, Done) |
| `.ghost` | White, 1px outline | Secondary action next to a primary (Show in folder, Pause) |
| `.pill` | Small solid black pill | Inline action inside a card (Change folder) |
| `.link-btn` | Text only, dim | Tertiary (Cancel, Done on Home, Check for updates) |
| `.mini` | Small grey fill | Row actions in History and lanes; `.mini.strong` = black, `.mini.quiet` = icon-only |
| `.badge` | Tiny uppercase outline | Status; `.ok` black, `.bad` red |
| `.switch` | iOS-style toggle | Boolean settings |
| `.option` / `.option-list` | Rounded list of label + control | Plain-language settings |
| `<dung-progress>` | Pixel beetle | Progress. `scale="4"` on Home, `scale="2" no-label` in lanes |

---

## Home states

`.app[data-mode]` drives layout; `nextMode()` in `renderer.js` decides it.

| Mode | When | Shows |
|---|---|---|
| `idle` | Nothing running | Wordmark, beetle at rest, big paste box, "Just press ⌘V" hint |
| `active` | One download (or one just finished, for 6s) | File name + meta, big beetle, Pause/Cancel or **Open**/Show in folder, slim paste box |
| `lanes` | Two or more live downloads | Up to **3** lanes (name, meta, ✕, small beetle), then "+N more" → History. Finished lanes show **Open** for 8s |
| `.needs-setup` (class) | The download helper (aria2) is missing or broken | A **One-time setup** card above a faded paste box: one plain sentence, one button. Raw errors only under "What does this install?" |
| `history` | History tab | List of live and saved files with Open / Show in folder / ✕ |

---

## Motion

Tokens on `:root`:

| Token | Value | Use |
|---|---|---|
| `--ease` | `cubic-bezier(.2,.8,.2,1)` | The only easing curve — a soft settle |
| `--t-fast` | 160ms | Hover, press |
| `--t-mid` | 260ms | Things appearing: dialogs, banners, lanes, buttons |
| `--t-slow` | 420ms | Layout morphs between modes |

- **Mode changes** use the View Transitions API (`render()` in `renderer.js`). Elements
  with a `view-transition-name` — `wordmark`, `pastebox`, `beetle`, `current`, `nav`,
  `footer` — glide to their new position. Give any new persistent element a unique name
  if it should morph rather than cross-fade.
- **Home ↔ History** slides 24px sideways like turning a page.
- **Dialogs** rise 12px and scale from 0.97; **banners** drop 8px; **lanes** and
  **stage buttons** fade up with a 40ms stagger.
- **Buttons** press to `scale(.96)`.
- The beetle animates itself; don't add CSS animation to `<dung-progress>`.
- Everything is disabled under `prefers-reduced-motion: reduce` (the beetle then jumps
  straight to its value).

---

## Copy

- Talk like a friendly person: "Paste a link here", "Show in folder", "That doesn't look
  like a link."
- Errors say what to do next, not just what failed.
- **Never show internal names on the surface.** Say "helper", "video support", "activity
  log" — not aria2, engine, yt-dlp, RPC or binary. Those words may appear only in
  *Settings → Advanced*, in "What does this install?" and in tooltips.
- Lowercase for status words in meta (`queued`, `done`, `paused`); sentence case for
  buttons and titles.
- Use ⌘ on macOS and "Ctrl" elsewhere (the hint swaps automatically).

---

## Contributing checklist

- [ ] Used existing tokens; no new colours outside the beetle palette.
- [ ] The view still has exactly one solid black primary action.
- [ ] New technical options go under *Settings → Advanced*.
- [ ] New motion uses `--ease` and a `--t-*` duration, and is covered by the
      reduced-motion rule.
- [ ] Checked at the default window size and with the window narrowed.
- [ ] Updated this file and, if the look changed, the screenshots in `docs/`.
