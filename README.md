# WageRoute

**Zero-based paycheck routing for the desktop.**

WageRoute is a local-first personal finance ledger that puts every paycheck through the same order of operations:

1. **Protect the Priority Wall** — recurring bills are reserved before anything else moves.
2. **Split the true surplus** — savings, investments, sinking funds and debt payoff.
3. **Leave the remainder guilt-free** — leisure is the residual, so the plan can never spend money twice.

It is a planning and ledger tool, not a bank connection. There is no account linking, no cloud account, no telemetry and no sync. Everything lives in one SQLite file on the machine where you installed it.

> Version 1.0.1 · single user · macOS and Windows · unsigned developer builds

---

## Contents

- [What it does](#what-it-does)
- [Design rules](#design-rules)
- [Screens](#screens)
- [Technology](#technology)
- [Installing WageRoute](#installing-wageroute)
- [Quick start](#quick-start)
- [Where your data lives](#where-your-data-lives)
- [Backup, export and import](#backup-export-and-import)
- [Deployment status](#deployment-status)
- [Project layout](#project-layout)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

---

## What it does

| Area | Behaviour |
| --- | --- |
| **Priority Wall** | Track rent, utilities, insurance and subscriptions with weekly through yearly cadences. Each bill is smoothed into a monthly equivalent and a per-paycheck reserve. Paused bills stop reserving money but stay in history. |
| **Paycheck allocator** | A three-step wizard: enter the deposit, subtract the wall, distribute the true surplus. Splits are percentages of the surplus, not of gross income. The result is committed as one paycheck record with allocation lines. |
| **Sinking funds** | Named goals with targets, optional deadlines and priorities. The allocator funds them in priority order, then by deadline, then by name. Fully funded goals stop taking money. Unused goal budget sweeps into savings. |
| **Emergency fund** | A special sinking fund with an automatic target: monthly essentials × 3–6 months. Essentials are the Priority Wall plus, optionally, the average of recent variable expenses. A manual target mode is also available. |
| **Accounts and credit** | Checking, savings, cash, investment and credit accounts, grouped by institution. Balances are derived from entries. Credit cards store debt as a negative balance and expose a utilization meter against their limit. |
| **Spreadsheet** | An editable grid of every ledger row. Date, account, kind, category, description and amount edit in place. A second tab projects bills and goal deadlines over the next 90 days. |
| **Round-up** | Tangerine-style spare-change sweeps: when an expense is logged against a checking or cash account, the difference to the next $1, $2 or $5 is moved to a savings account as a paired transfer. |
| **Paired transfers** | Account-to-account moves are written as two linked rows sharing a `transfer_group_id`. Editing an amount, date, memo or category updates both legs. Deleting either leg removes both. |
| **Chronology prompts** | Active bills past their latest due date with no matching `bill_id` payment are surfaced on the dashboard as “Did this clear?” prompts with one-click logging. |
| **Data portability** | Full or partial JSON backups, a transactions CSV export, and additive imports of either format. Imports never delete local data, and re-importing the same file is idempotent. |
| **Appearance** | Dark, light or system theme. The resolved palette is cached locally to prevent a flash on launch. |

## Design rules

These are product and engineering constraints, not aspirations.

1. **Bills first.** The Priority Wall is funded before any percentage split is calculated. If a paycheck cannot cover the wall, all other buckets are zero and the plan reports a shortfall.
2. **Money is integer cents.** SQLite stores `INTEGER` cents. Floats never enter the ledger. Division by 100 happens only at display or export boundaries.
3. **The ledger is the source of truth.** Account balances are `starting_balance + SUM(entries)`. A correction is an adjustment row, never a silent overwrite.
4. **Routing is an envelope plan, not a bank transfer.** Committing a paycheck records income and allocation lines; it does not move money between accounts. Transfers and round-ups are separate, explicit ledger entries.
5. **Deletes are soft.** Rows get `deleted_at` tombstones so history and future sync stay coherent.
6. **Imports only add.** Existing rows and existing settings win. Nothing local is removed by an import.
7. **Local by default.** No server, no network calls in application code, no analytics, no auto-update.
8. **Deterministic domain logic.** The allocator, cadence maths, emergency calculator, projections and bill prompts are pure functions in `src/shared`, covered by Node tests.

## Screens

| Screen | Purpose | Key formulas |
| --- | --- | --- |
| **Overview** | Safe to Spend hero, accounts, month-to-date donut, last routing, goal progress, recent activity, bill prompts | `cash − monthly wall − funded goals` |
| **Priority Wall** | Bill CRUD, pause/resume, per-paycheck and monthly totals | `amount × bill periods / 12`; `amount × bill periods / pay periods` |
| **Sinking funds** | Goal CRUD, progress, emergency calculator | `funded / target`; `essentials × months` |
| **Accounts** | Bank-grouped account CRUD, balance adjustments, credit payments | `starting + SUM(entries)`; `max(0, −balance)` owed |
| **Spreadsheet** | Editable ledger and 90-day projection | `next due date`, `advance by frequency` |
| **Settings** | Theme, round-up, import/export, database path | `remainder to next increment` |

The **Allocator** is a full-screen wizard available from the sidebar or the Overview page, not a separate navigation tab.

## Technology

| Layer | Choice |
| --- | --- |
| Shell | Electron 45 |
| Build | electron-vite 6, Vite 8 |
| UI | React 19.3, TypeScript 7 (strict), Zustand 5 |
| Grid | react-data-grid 7 |
| Icons | lucide-react |
| Database | better-sqlite3 13, SQLite in WAL mode |
| Packaging | electron-builder 26 (DMG, NSIS, portable, zip, AppImage, deb, rpm) |
| Tests | `node:test` through `tsx` |
| CI | GitHub Actions, matrix macOS + Windows |

The renderer is sandboxed with `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`. It reaches the main process only through the typed `window.api` bridge.

## Installing WageRoute

The macOS build is ad-hoc signed, not notarized. The first launch of any downloaded copy needs one extra click (right-click the app → **Open** → **Open**); after that it opens normally. The cleanest no-prompt path is Homebrew or the curl one-liner below.

**Homebrew (recommended, macOS):**

Install and update through the official [`homebrew-wageroute`](https://github.com/ReVax-2007/homebrew-wageroute) tap:

```bash
brew tap ReVax-2007/wageroute
brew install --cask wageroute          # add --no-quarantine to skip the first-launch prompt entirely
brew upgrade --cask wageroute          # future updates
```

Homebrew verifies the DMG against a pinned SHA-256 before installing. `brew uninstall --cask wageroute` removes the app but leaves your data in place.

**DMG (manual):** download `WageRoute-<version>-arm64.dmg` (Apple Silicon) or `WageRoute-<version>.dmg` (Intel) from [GitHub Releases](https://github.com/ReVax-2007/wageroute/releases), drag to Applications, then right-click → **Open** on first launch.

**curl (no Gatekeeper prompt at all):** browsers tag downloads with a quarantine flag that triggers Gatekeeper; curl does not. Replace `v1.0.1` below with the latest version from [GitHub Releases](https://github.com/ReVax-2007/wageroute/releases).

```bash
curl -LO https://github.com/ReVax-2007/wageroute/releases/download/v1.0.1/WageRoute-1.0.1-arm64.dmg
hdiutil attach WageRoute-1.0.1-arm64.dmg
cp -R "/Volumes/WageRoute 1.0.1-arm64/WageRoute.app" /Applications/
hdiutil detach "/Volumes/WageRoute 1.0.1-arm64"
```

**Windows:** three formats, all unsigned — the NSIS installer (`WageRoute.Setup.<version>.exe`), a portable single-file exe, and an unpack-and-run zip. SmartScreen shows “Windows protected your PC” on first run — choose **More info → Run anyway**.

**Linux:** AppImage (no root, works on any distro — `chmod +x` and run), plus `.deb` for Debian/Ubuntu/Mint and `.rpm` for Fedora/RHEL, in x64 and arm64. All unsigned; a distro package manager may ask you to confirm installation.

Full details, including the Gatekeeper behaviour on each macOS version, are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and [docs/RELEASING.md](docs/RELEASING.md).

## Quick start

Requirements: **Node.js 22 or newer** (CI uses 24) and npm. macOS packaging expects Xcode Command Line Tools; Windows packaging is normally done on Windows or in CI.

```bash
npm install          # also rebuilds better-sqlite3 for Electron
npm run dev          # launch the app with hot reload
npm test             # 21 domain tests
npm run typecheck    # main/preload and renderer type checks
npm run build        # typecheck + production bundles in out/
npm run dist:mac     # DMG for arm64 and x64
npm run dist:win     # NSIS installer, portable exe and zip for x64 and arm64
npm run dist:linux   # AppImage, deb and rpm for x64 and arm64
```

`npm run dev` seeds a demo profile (Alex, with accounts, bills, goals, paychecks and transactions) the first time it launches, so every screen is explorable. Packaged builds are different: first launch creates an empty profile and the dashboard offers **Start from scratch** or **Import a backup**. In both cases the seed never runs again once a user row exists.

## Where your data lives

The database file is `wageroute.db` under Electron's per-user data directory:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/WageRoute/wageroute.db` |
| Windows | `%APPDATA%\WageRoute\wageroute.db` |
| Linux | `~/.config/WageRoute/wageroute.db` |

SQLite also creates `wageroute.db-wal` and `wageroute.db-shm` while the app is open. Copy all three together if you copy the database while WageRoute is running.

The app was previously named **Cash Flow Routing**. On first launch, if the new database does not exist, WageRoute copies `Cash Flow Routing/cash-flow-routing.db` (plus WAL and SHM) into the new folder and leaves the original untouched. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#legacy-data-adoption).

## Backup, export and import

- **Export full backup** writes every row of accounts, bills, goals, paychecks, allocations, transactions and settings as JSON. It includes tombstones and all linked IDs.
- **Export transactions CSV** writes the latest 500 ledger rows (the snapshot limit) with Date, Account, Institution, Kind, Category, Description, Amount and Currency.
- **Import data** accepts either format. JSON may contain only some tables. CSV is treated as entries and matched to local accounts by name (optionally narrowed by institution).
- Imports are additive and transactional. Existing IDs are skipped, existing settings keys win, and re-importing the same file changes nothing.

Full format rules, examples and failure modes are in [docs/IMPORT-EXPORT.md](docs/IMPORT-EXPORT.md).

## Deployment status

**WageRoute is local-only today.** There is no sync engine, no cloud backup, no server, no user account and no automatic updates. Multi-device use requires exporting and importing files manually. The schema is deliberately sync-ready, but no sync design has been agreed or implemented.

The CI workflow builds unsigned installers only; it does not publish a release. Code signing and notarization are not configured.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full status matrix and the GitHub vs GitLab recommendation, and [docs/RELEASING.md](docs/RELEASING.md) for the build and release checklist.

## Project layout

```text
.
├── build/                     App icon sources and generated .icns/.png
├── docs/                      Documentation (this set)
├── out/                       electron-vite build output (ignored)
├── release/                   electron-builder output (ignored)
├── src/
│   ├── main/                  Electron main process
│   │   ├── db/                connection, migrations, repositories, backup,
│   │   │                      entries import, legacy adoption, seed
│   │   ├── index.ts           app lifecycle, window, security policy
│   │   └── ipc.ts             IPC handlers and file dialogs
│   ├── preload/               contextBridge surface
│   ├── renderer/              React application
│   │   ├── index.html         CSP and document title
│   │   └── src/
│   │       ├── components/    Sidebar, grids, prompts, UI primitives
│   │       ├── lib/           Renderer-side derived finance helpers
│   │       ├── screens/       Dashboard, Wall, Goals, Accounts,
│   │       │                  Spreadsheet, Settings, Allocator
│   │       ├── store/         Zustand store and actions
│   │       └── styles/        tokens.css, app.css
│   └── shared/                Pure domain layer used by all processes
│       ├── allocator.ts       Paycheck routing algorithm
│       ├── cadence.ts         Bill/pay frequency smoothing
│       ├── emergency.ts       Emergency fund calculator
│       ├── csv.ts             CSV export and import parsing
│       └── types.ts           Shared TypeScript contracts
├── electron-builder.yml       Packaging targets
├── electron.vite.config.ts    Build config and aliases
└── package.json
```

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process model, boot sequence, IPC, state flow, module responsibilities |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | Every table, column, index, invariant, settings key and migration |
| [docs/FEATURES.md](docs/FEATURES.md) | Screen-by-screen behaviour and the exact formulas behind each number |
| [docs/IMPORT-EXPORT.md](docs/IMPORT-EXPORT.md) | JSON backup schema, partial imports, CSV grammar, dedupe and errors |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Local-only reality, multi-device options, sync status, repo hosting |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setup, scripts, feature checklist, migration recipe, debugging |
| [docs/RELEASING.md](docs/RELEASING.md) | Versioning, packaging, CI, signing gaps, release and rollback |
| [docs/SECURITY.md](docs/SECURITY.md) | Trust boundaries, controls, threats, known gaps |
| [docs/decisions/README.md](docs/decisions/README.md) | Architecture decision records for the load-bearing choices |

Related repositories: [ReVax-2007/homebrew-wageroute](https://github.com/ReVax-2007/homebrew-wageroute) — the official Homebrew tap (cask, install/update docs); bumped to each release per [docs/RELEASING.md](docs/RELEASING.md#release-checklist). |

## Contributing

Work on a separate branch and open a pull request; never push directly to `main`. Before requesting review, run `npm test`, `npm run typecheck` and `npm run build`. Do not commit databases, backups, CSV exports or real financial data. Full branch, review and data-safety standards are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

WageRoute is **source-available, not open-source**. See [LICENSE](LICENSE). You may use, study and modify it, including commercially, on machines you control, and keep your modifications private. You may not sell it, sublicense it, or distribute builds or modified versions — only the licensor ships WageRoute. Contributions may be pushed on a separate branch and are accepted through a pull request; submitting one grants the licensor permission to include it.
