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
