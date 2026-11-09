# Privacy Policy

*Version française : [PRIVACY.fr.md](PRIVACY.fr.md)*

**Effective date:** November 8, 2026

This policy explains what personal information WageRoute collects, which is essentially none, and where your information goes when you use the app, the phone app, the website and the services around them. It is written to meet Canada's *Personal Information Protection and Electronic Documents Act* (PIPEDA) and Quebec's *Act respecting the protection of personal information in the private sector* (as amended by Law 25), and to answer the questions the EU/UK GDPR and US state privacy laws ask.

WageRoute is made by Xavier Voet ("we", "us"), an individual developer in Quebec, Canada.

## The short version

- **The WageRoute app collects nothing.** Your ledger, your settings and everything you type stay in files on your own computer. The app has no account, sends no telemetry or analytics, makes no network requests, and has no server that could receive your data.
- **We never see your financial data,** and we have no way to.
- **The website sets no cookies** and runs no analytics or tracking. It stores one setting in your browser: your light/dark theme choice.
- Some services that deliver WageRoute (GitHub, Homebrew, the Windows Package Manager, Buy Me a Coffee) are run by other companies, under their own privacy policies. They are listed below.

## 1. The desktop app

WageRoute is a local-first desktop application for macOS, Windows and Linux.

- **Where your data lives.** Your ledger is one SQLite file in your user folder: `~/Library/Application Support/WageRoute` on macOS, `%APPDATA%\WageRoute` on Windows and `~/.config/WageRoute` on Linux. Alternatively, it is in a folder you choose in Settings. The app also keeps local safety copies (`backups/`) and a local crash log in that folder. None of it is sent anywhere.
- **No network.** The app does not connect to the internet. It contains no analytics, crash reporting, update check, advertising or tracking code. The one external link in the app opens our Buy Me a Coffee page in your own browser, and only when you click it.
- **Encryption, if you turn it on.** When you enable encryption at rest, the key is kept beside your ledger in `ledger.key.json`, protected by your choice of your computer's keychain or a passphrase (newer versions add a PIN and, where supported, a fingerprint or face passkey). The passphrase and PIN are never stored, and nothing is ever sent to us. **We cannot recover a forgotten passphrase or PIN**, because we never had it.
- **Exports and imports** are files you create and choose where to save. They contain your financial data, so treat them as sensitive.

## 2. WageRoute Pocket (the phone app)

Pocket is an optional web app that runs in your phone's browser.

- It keeps its copy of your data in your browser's own storage (IndexedDB) on that device. It never uploads it. Data moves between your phone and computer only in backup files that you carry yourself.
- Pocket is static files with no backend. Whoever **hosts** those files (you, if you self-host, or a static host you choose) can see ordinary web-server logs such as your IP address and browser type, but never your ledger.

## 3. The website (revax-2007.github.io/wageroute)

- **Hosting.** The website is hosted by **GitHub Pages**. GitHub processes technical information such as your IP address to deliver the pages and keep the service secure, under the [GitHub General Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement). We do not receive those logs.
- **No cookies, no analytics, no trackers.** The site loads nothing from third parties.
- **One browser setting.** If you choose Light or Dark with the theme switch, the site stores that choice in your browser's `localStorage` under the key `wageroute-theme`. It never leaves your browser. Choosing Auto removes it.
- **Search.** We use Google Search Console to see how the site appears in Google Search. It reports search statistics, such as how often the site appeared in results, which Google collects on its own search pages under the [Google Privacy Policy](https://policies.google.com/privacy). The site itself contains no Google tracking code; a single verification tag proves we own the site.

## 4. Downloads and installers

You get WageRoute from services run by other companies, each with its own privacy policy:

- **GitHub** hosts the source code, releases and install scripts ([GitHub privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)). Downloading a release or running `install.sh` / `install.ps1` connects your computer to GitHub.
- **Homebrew**, if you install with `brew`, has its own [analytics policy](https://docs.brew.sh/Analytics), which you can turn off with `brew analytics off`.
- The **Windows Package Manager** (`winget`), if you use it, is operated by Microsoft under the [Microsoft Privacy Statement](https://www.microsoft.com/en-us/privacy/privacystatement).

The install scripts collect nothing and send nothing to us. They download the release from GitHub and install it on your computer.

## 5. Self-hosting (Docker)

If you run WageRoute in your own containers, you are the operator. Your ledger stays in your own Docker volume, and any login or proxy you put in front of it is yours to configure. Nothing is sent to us.

## 6. Donations

If you choose to support the project, payment is handled entirely by **Buy Me a Coffee** under its [privacy policy](https://www.buymeacoffee.com/privacy-policy). We receive what that platform shows creators (typically your display name, any message you write and the amount), and we use it only to see and acknowledge your support.

## 7. Contacting us on GitHub

If you open an issue or pull request, what you post is public and handled by GitHub. We use it only to answer you and improve WageRoute. **Do not post personal or financial information in an issue.**

## 8. Your rights

Under Canadian, Quebec, EU/UK and US state laws, you may have the right to access, correct, delete or move your personal information, to withdraw consent, and to complain to a regulator.

Because the app and website collect no personal information, **we hold no data about you to access or delete.** The data in WageRoute is in your own files, which you control completely. For anything you have given us directly, such as a GitHub post or a donation message, contact us (section 11) and we will help within 30 days.

We do not sell or share personal information, as those terms are defined in US state laws such as the California Consumer Privacy Act. We use no automated decision-making and no profiling.

## 9. Children

WageRoute is not directed at children under 14, and we do not knowingly collect information from anyone, of any age.

## 10. Security

The app's security model, including encryption at rest and its limits, is described in [docs/SECURITY.md](docs/SECURITY.md). Report a vulnerability as explained in [SECURITY.md](SECURITY.md).

## 11. Person in charge and contact

The person in charge of the protection of personal information (Quebec, Law 25) is **Xavier Voet**, the developer of WageRoute.

- **Questions or requests:** open an issue at <https://github.com/ReVax-2007/wageroute/issues>.
- **Anything private:** open an issue that says only that you have a private privacy request, with no details, and we will arrange a private channel with you.

If you are not satisfied with our answer, you can contact the Commission d'accès à l'information du Québec (<https://www.cai.gouv.qc.ca>) or the Office of the Privacy Commissioner of Canada (<https://www.priv.gc.ca>), or the data protection authority where you live.

## 12. Changes

If this policy changes, we will update the effective date above, and the history of every change is public in this repository. We will never start collecting personal information without saying so here first.
