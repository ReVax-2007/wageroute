# Contributing to WageRoute

WageRoute is source-available, not open-source. Contributing does not change that: the license in [LICENSE](LICENSE) still governs use, modification and distribution. By opening a pull request you agree to the contribution grant in section 3 of that license.

## Before you start

- For a large feature, schema change or anything that alters data compatibility, open an issue or discussion first. It is cheaper than reviewing a rejected design.
- Do not report security vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).
- Use synthetic accounts, amounts and memos in tests, screenshots and bug reports. Never attach a real database, backup, CSV export or `.env` file.

## Branches and commits

- Branch from `main`. Never commit or push directly to `main`.
- Use a descriptive branch name:
  - `feat/short-description`
  - `fix/short-description`
  - `docs/short-description`
  - `refactor/short-description`
  - `chore/short-description`
- Keep each pull request focused on one concern. Do not mix unrelated refactors with a behaviour change.
- Write commit messages in the imperative mood and explain **why** the change is needed. A subject under ~72 characters is preferred.
- Do not force-push `main`. Avoid force-pushing a shared branch once review has started; add follow-up commits instead.

## Setup and checks

Node.js 22 or newer is required; `.nvmrc` pins the CI version (24).

```bash
npm ci
npm test
npm run typecheck
npm run build
```

All four must pass before a pull request is ready for review. `npm run build` already runs both typecheck projects.

### Testing without touching real data

Electron can use a temporary application-data home on macOS:

```bash
CFFIXED_USER_HOME=/tmp/wageroute-dev npm run dev
```

For migration or import tests, work on a **copy** of a database, never the live ledger. Copy `.db`, `-wal` and `-shm` together while the app is closed. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Code and data standards

- **TypeScript strict.** Avoid `any`; keep shared contracts in `src/shared`. Do not duplicate a domain type in the renderer.
- **Money is integer cents.** Use `parseMoneyToCents`, `formatMoney` and the existing arithmetic helpers. Never store or calculate dollars as floats.
- **Respect the process boundary.** Renderer code must not import Node or Electron main modules. New IPC needs a narrow preload method, input validation and a user-scoped query.
- **Do not weaken security controls** — renderer sandbox, context isolation, CSP, import size/row caps, column allowlists, navigation denial or permission denial — to make a feature work. Discuss the need first.
- **SQL is parameterised.** Never interpolate user input into SQL, including identifiers.
- **Migrations are append-only.** Never edit an existing migration. Add a new version, preserve existing rows, test on a previous-schema database copy, and keep backup compatibility honest.
- **Imports stay additive.** Do not turn them into destructive restores or silent overwrites without an accepted ADR.
- **Delete means soft delete.** Preserve tombstones unless a change explicitly addresses purge/compaction.
- **No new network calls, telemetry, analytics or crash reporting.** WageRoute is local-only by design.
- **UI changes are tested manually.** Check both themes, the empty state and the failure path. Include a screenshot in the pull request when appearance changes.
- **Documentation is part of the change.** Update the relevant file in `docs/` when behaviour, data, commands or security assumptions change. Load-bearing decisions need an ADR in `docs/decisions/`.

## Pull requests

A pull request should state:

- **What changed** and **why**;
- how it was verified (commands and manual paths);
- any data, migration or backup-compatibility impact;
- any security or privacy impact;
- screenshots for visible UI changes.

The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) covers the checklist. A maintainer reviews and merges; contributors do not merge their own pull requests. Review comments are about the change, not the person.

## What not to commit

The repository must never contain:

- `wageroute.db`, `-wal` or `-shm` files, or any other local database;
- JSON backups, CSV exports or screenshots containing real financial data;
- `.env` files, credentials, API keys or signing certificates;
- build output (`out/`, `release/`), installers or blockmaps.

`.gitignore` covers the common cases, but review `git status` before committing. If a secret is committed, treat it as exposed and rotate it; removing it from the latest commit is not enough.

## License of contributions

By submitting a contribution you grant the Licensor a non-exclusive, royalty-free, sublicensable and transferable license to use, reproduce, modify, license and distribute it as part of WageRoute, as described in [LICENSE](LICENSE) section 3.
