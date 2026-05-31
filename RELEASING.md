# Releasing & Auto-Update — XRPSync Wallet

The wallet now updates **in place** (no uninstall/reinstall): it checks GitHub
Releases on launch + every 6h, shows a pill in the top bar when an update
exists, and the user clicks it to download → restart into the new version.

## One-time setup

1. **Set the publish target** in `package.json` → `build.publish[0].owner` —
   currently the placeholder `CHANGEME-github-owner`. Set it to the GitHub
   account/org that owns the public `xrpsync-wallet` repo.
2. **Install the new dep** (adds `electron-updater`):
   ```bash
   cd labs-wallet && npm install
   ```

## Cutting a release

Auto-update only fires when the published version is **higher** than the
installed one, so bump `version` every release.

```bash
# 1. bump version (also rebuild stamp if you track it in main.js BUILD_STAMP)
npm version patch        # or minor/major

# 2. build + publish to GitHub Releases (generates latest.yml the updater reads)
export GH_TOKEN=<a GitHub token with repo scope>
npx electron-builder --win   --publish always
npx electron-builder --linux --publish always
npx electron-builder --mac   --publish always   # see signing note below
```

`--publish always` uploads the installer **and** the `latest*.yml` feed files —
both are required; without the yml the client can't detect updates.

## Platform notes / caveats

- **Windows (NSIS):** works unsigned (`signAndEditExecutable: false`). Users see
  a SmartScreen warning on first install; auto-update itself works fine.
- **Linux (AppImage):** auto-update works out of the box.
- **macOS:** auto-update **requires code signing + notarization** — Squirrel.Mac
  refuses to update an unsigned/ad-hoc app. Until you have an Apple Developer
  cert, Mac users must update manually. (The pill still shows; install will fail.)
- This workstation **cannot build the binaries** (no Wine for `.exe`, no signing
  identities). Build on the host or a CI runner.

## Verification checklist

### Auto-update
- [ ] `npm install` pulls `electron-updater`.
- [ ] In **dev** (`npm start`), the pill never shows and `update:check` returns
      `updates disabled (dev build)` — expected (electron-updater is packaged-only).
- [ ] Publish v1 → install it. Publish v1.0.1 → relaunch v1 → pill appears within
      ~8s ("⬆ Update v1.0.1 — click to install").
- [ ] Click → "Downloading… N%" → "✔ Update ready — click to restart".
- [ ] Click again → app quits, reinstalls, relaunches as v1.0.1.

### Auto-sign Pro gate
- [ ] **Free / logged-out:** open *Auto-sign rules* — the 🔒 "Pro feature" banner
      shows; toggling a site to ENABLED is blocked with an upgrade alert.
- [ ] Enabling on a **Pro** account first shows the irreversibility / no-liability
      warning; only proceeds on accept. Defaults OFF; disabling needs no warning.
- [ ] **Free account with a stale ENABLED rule:** trigger a sign request from the
      site → wallet does **not** auto-sign; it opens the manual approval window
      and logs `auto_sign_blocked_no_pro`. (Manual approval still works.)
- [ ] **Pro account:** auto-sign proceeds within configured limits as before.
- [ ] Upgrade Free→Pro (admin grant), then in the wallet the account refreshes
      (`account:refresh` / relaunch) → auto-sign unlocks without reinstall.

## How the tier gate works

The server asserts the entitlement in the authenticated `GET /api/wallet/me`
payload (`entitlements.flags.auto_sign`). The wallet reads the cached copy in
`accountAllowsAutoSign()` (main.js) before any auto-sign, and the UI gates on the
same flag. Honest-user enforcement only — the local bridge never routes through
the server — but it stops a Free user from using the paid convenience. Manual,
per-trade approval is always available to everyone.
