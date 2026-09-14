# XRPSync Wallet

XRPL desktop wallet for the XRPSync. Generate, store, and sign transactions
locally — your private keys never leave the device.

## Features

- xrpl.js wallet generation (seed, secret, mnemonic import supported)
- AES-256-GCM encrypted-at-rest secret storage (PBKDF2 key derivation from your password)
- Local transaction signing (`OfferCreate`, `Payment`, `TrustSet`, etc.)
- **Auto-sign** with per-site rules (per-tx cap, daily cap, allowed types/pairs)
- WebSocket bridge: pair the wallet with the XRPSync website to sign trades
- Dark Matrix theme matching the XRP terminal

## Security model

- Private keys are **never** stored on the server — they live only on this device, encrypted at rest.
- `AccountDelete`, `SetRegularKey`, and `SignerListSet` are hard-blocked from auto-sign.
- App locks after 5 minutes of inactivity; password re-entry required to unlock.
- Failed unlock attempts trigger an escalating lockout.

## Moving to another computer / portable copy

Everything the wallet knows lives in one encrypted file, `labs-wallet-data.json`,
in the data folder (Help → **Open data folder**). Three ways to move it:

1. **Copy the data file (recommended, keeps everything).** Close the wallet on the
   new machine, drop the old machine's `labs-wallet-data.json` into its data
   folder, launch. The old master password works (the key salt is inside the file),
   and auto-sign rules, phone pairing, address book and prefs all come along.
   Log in to XRPSync again — the session token is tied to the old machine's OS.
   Password recovery (OS keychain) must be re-enabled if you used it.
2. **Backup file.** Old machine: Backup & restore → Export (choose a backup
   password). New machine: on the first-launch screen pick **Restore from a backup
   file…**, enter the backup password, pick the file. Tick **Use a master password
   I choose** to keep a password you know (12+ chars, 3 character classes — your
   old one qualifies if it meets that bar); otherwise one is generated and shown
   once. Wallets and auto-sign rules come across; phone-pairing status, address
   book and prefs do not.
3. **Cloud sync** (Settings → Cloud sync, off by default). Encrypted with your
   master password; the server stores only ciphertext. On a new machine, log in
   and accept the restore prompt with the *old* master password. Limited to 5
   downloads per hour per account.

Any copy can switch to a password you prefer later: Settings → **Change master
password** (current password required; every wallet is re-encrypted; the cloud
blob is re-uploaded if sync is on).

### Portable (thumb drive)

The Windows build also produces `XRPSync-Wallet-Portable-<version>.exe`. Run it
from the drive and it keeps its data in `XRPSyncWalletData/` next to the exe.
On macOS/Linux, either start with `--portable` or put an empty `portable.txt`
next to the `.app` / AppImage. In portable mode:

- data folder = next to the executable (footer shows **PORTABLE**);
- auto-update is off — replace the exe to update;
- password recovery is off — the OS keychain belongs to the host PC;
- everything else (encryption, bridge on port 17760, auto-sign rules) is unchanged.

Lost drive = someone holds your encrypted file. The generated 24-character master
password is built for that; a short custom one is not. Plugging into an untrusted
PC exposes the password to that PC. Portable is convenience, not hardware-wallet
security.

## Development

```bash
cd labs-wallet
npm install
npm start
```

## Build

```bash
npm run build:win     # Windows installer (.exe via NSIS)
npm run build:mac     # macOS .dmg
npm run build:linux   # Linux AppImage
```

Output lives in `dist/`.

## Project layout

```
labs-wallet/
  main.js                Electron main process (windows, IPC handlers)
  preload.js             contextBridge — secure renderer ↔ main bridge
  src/
    wallet/              wallet generation, import, storage, signing, backup, auto-sign
    xrpl/                XRPL WebSocket client, balances, history, trustlines, submit
    bridge/              site-bridge WebSocket protocol (sign requests from website)
    ui/                  HTML pages, styles, renderer.js
  assets/                icons, logo
  dist/                  built installers (gitignored)
```

## License

MIT — see project root.
