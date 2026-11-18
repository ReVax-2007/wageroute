# WageRoute — improvements list

Running list of improvements for the desktop app, Pocket, the build and the website. The full code audit is still to be added below. Items the owner asked for come first.

---

## Owner requests

### 1. "Glass" theme — future theme option

**Asked for:** 2026-11-10, from a reference screen recording ("Glassy Dashboard"). Frames from the clip: [docs/ideas/glass-theme-reference.jpg](docs/ideas/glass-theme-reference.jpg).

**What the reference shows**
- A full-window **background photo** (a dim, softly blurred interior), so the app sits *on* a scene instead of a flat colour.
- **Frosted translucent cards**: semi-transparent dark panels, a strong background blur behind them, a hairline light border, large radii (~16–20px) and soft shadows.
- A thin **icon-only rail** on the left instead of a wide text sidebar, plus round icon buttons at the top right.
- Muted white text at about 60% opacity for labels, full white for the figures, and accent colours kept to small chips, icons and change indicators.
- A small **lift on hover** (cards rise a few pixels) and smooth fades between screens.

**How it fits WageRoute today**
- The theme is `ThemePreference = 'dark' | 'light' | 'system'` (`src/shared/types.ts:13`), validated by `THEMES` in `src/shared/settings.ts:35`, picked with the `Segmented` control in `src/renderer/src/screens/Settings.tsx:292`, and applied as `data-theme` on `:root`. The colours are tokens in `src/renderer/src/styles/tokens.css` (`--bg`, `--panel`, `--panel-2`, `--border`, …), with a light override at `tokens.css:80`.
- So a glass theme is mostly a **new token set**, `:root[data-theme='glass']`, plus a small layer of glass-only rules.

**Proposed scope**
1. Add `'glass'` to `ThemePreference`, `THEMES`, and the Settings segmented control (Dark · Light · Glass · System). Old settings files stay valid. *System* keeps meaning light/dark.
2. `tokens.css`: a `[data-theme='glass']` block. Use translucent panels (`--panel: rgb(255 255 255 / 0.06)` and similar), light borders (`rgb(255 255 255 / 0.12)`), and new tokens `--glass-blur` (around 24px) and `--radius-card` (around 18px).
3. Glass-only CSS: `backdrop-filter: blur(var(--glass-blur)) saturate(140%)` on cards, dialogs, the sidebar and the top bar, and a background image on `.app-shell`. Ship one or two bundled, licence-clean backgrounds, generated or CC0 (never the image from the clip), with an optional **"Choose background…"** that stores a copy beside the settings and never uploads it.
4. Optional **compact rail**: a sidebar collapsed to icons with tooltips. Glass could default to it, and it would also help on the narrow windows that clipped the sidebar.
5. Motion: a card lift and fades only under `prefers-reduced-motion: no-preference`.
6. Pocket: the same token block in `src/pocket/styles.css` (it already uses `backdrop-filter`), behind its own theme setting, if parity is wanted.

**Guard rails**
- **Contrast:** money figures and labels must keep WCAG AA (4.5:1) over the *brightest* part of any background. Add a dim scrim (for example `rgb(0 0 0 / 0.35)`) over the photo, and check every screen, not just the dashboard.
- **Performance:** many blurred layers are costly on older GPUs and Linux without compositing. Blur only the large containers, not every row, and respect the OS "reduce transparency" setting (Electron's `nativeTheme.prefersReducedTransparency`) by falling back to solid Dark.
- **Readability of dense screens:** the Spreadsheet and the Priority Wall tables should sit on a near-opaque panel, not on full glass.
- Screenshots in `scripts/screenshots.mjs` and on the website stay in Dark unless a Glass set is added deliberately.

**Size:** M. Tokens, settings and the Segmented control are small. The background picker, the icon rail and a contrast pass over every screen are where the time goes.

---

## Audit findings

*Pending — the six area reviews (main process and data, shared money logic, desktop UI, Pocket, build and release, website and docs) stopped at the usage limit and will be added here when they finish.*
