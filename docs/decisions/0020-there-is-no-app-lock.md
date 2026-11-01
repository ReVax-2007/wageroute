# 0020. There is no app lock

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Project owner
- **Related:** [ADR 0019](0019-the-ledger-is-plaintext-at-rest.md), [SECURITY.md](../SECURITY.md)

## Context

WageRoute opens straight to the dashboard. There is no PIN, no Touch ID gate, no idle timeout and no "lock now" action. Anyone who can unlock the computer or reach an unlocked session sees every balance, bill and paycheck.

The audit asked for a decision: add a lock, or write down that local access control is out of scope. A lock sounds cheap, but on a local app it is mostly theatre unless it is backed by encryption — a PIN that gates the UI does not stop anyone who can copy the database file.

## Decision

**There is no app lock. The operating-system login is the access control.**

- The app does not authenticate a user, store a PIN, or re-authenticate on idle.
- The window is a normal desktop window: closing it quits the app, and the OS screensaver or lock screen is the expected way to hide it.
- **A UI-only lock is rejected as a security control.** It would raise the apparent protection without changing what an attacker with file access can read (ADR 0019).
- If Touch ID or `safeStorage`-backed locking is ever added, it must come with an explicit statement of what it does and does not protect, and a new ADR. A lock that can be bypassed by copying `wageroute.db` must say so.
- The security documentation lists "someone at an unlocked session sees the ledger" as a known weakness rather than a defect.

## Consequences

### Positive

- No recovery path to design: there is no passcode to forget and no support case where a user is locked out of their own financial history.
- The security model is one sentence a user can act on: lock the computer.
- The app stays usable as a quick-glance dashboard, which is how a personal ledger is actually opened several times a day.

### Negative

- **A shared or unattended machine exposes everything.** Anyone at the keyboard sees the numbers; the app does nothing about it.
- **The audit and the docs must keep saying so.** A future UI that implies "your data is protected" without encryption would be false.
- **No lock means no "hide amounts" mode either.** Shoulder-surfing is not addressed.

### Neutral

- No schema, IPC or renderer change.
- The diagnostics panel and the About card never display balances, so they do not widen the exposure.

## Alternatives considered

### PIN or Touch ID gate in front of the dashboard

Rejected as a security control for the reasons above. It could still be a privacy convenience (hiding amounts from someone glancing at the screen), but that is a different feature with a different claim, and it should not be sold as protection for the file.

### Lock automatically after N minutes of inactivity

Rejected for the same reason; it also fights the "quick glance" use case and creates a state the renderer has to hide without actually protecting anything at rest.
