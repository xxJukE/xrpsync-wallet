# XRPSync Wallet — Manual Test: Phone Pairing (regular keys)

Operator click-throughs for the desktop side of the phone-pairing feature
(wizard, revoke, partial-failure). The phone side is in
`../labs-mobile/MANUAL_TEST.md`; the end-to-end moment of truth is scanning the
desktop QR with your iPhone in Expo Go.

> **Real on-ledger cost.** Each account you pair submits **one `SetRegularKey`**
> (~12 drops fee + it adds nothing to owner reserve). Each revoke submits one
> more. Use a low-value test account first. Mainnet is live.

## 0. Pre-flight (headless build verification — already run by the build)

These run without the UI and should all pass:

```bash
cd labs-wallet
node scripts/pairing-roundtrip-test.js   # 4/4 — encoder ↔ mobile decoder byte-compatible
node --check main.js preload.js src/wallet/pairing.js src/wallet/pairing-envelope.js
```

## 1. Flag an account desktop-only (Treasury safety)

1. Launch the wallet (`npm start`), unlock.
2. Open the **SYNC Treasury** (or any account you never want on a phone).
3. On the wallet page, tick **“Desktop-only — never offer this account to phone pairing.”**
4. Open **Pair phone** (left sidebar, Tools). **Expect:** the Treasury does **not**
   appear in the picker. ✅ The operator flags this manually — no address is hardcoded.

## 2. Pair one account (happy path)

1. Sidebar → **Pair phone**. The picker lists every non-desktop-only account.
2. Tick one **test** account → **Continue**.
3. **Confirm screen:** verify it lists exactly that account and shows the exact tx:
   ```json
   { "TransactionType": "SetRegularKey", "Account": "r…", "RegularKey": "<fresh keypair minted at submit time>" }
   ```
   (Fee / Sequence / LastLedgerSequence are added by autofill.)
4. Type your **master password** → **Set regular keys.**
5. **Run screen:** shows “✓ regular key set” + the new regular-key address, on `tesSUCCESS`.
6. **QR screen:**
   - A QR renders on a white tile.
   - An **8-digit one-time code** shows **beside** the QR (never inside it).
   - Copy text states the code/QR are not saved and that desktop can revoke anytime.
7. Leave this screen open for the phone test (`labs-mobile/MANUAL_TEST.md` §2).
8. After the phone imports, click **Done.** Re-open **Pair phone** → the account now
   shows under **PHONE KEYS** with its regular-key address + paired date.

### Verify on-ledger (optional)
Look up the account on any XRPL explorer → it should now have a **RegularKey** set
to the address shown on the Run screen.

## 3. The code is required — QR alone is useless

1. Start a pairing, reach the QR screen.
2. On the phone, scan the QR but enter a **wrong** 8-digit code.
   **Expect (phone):** “Wrong code, or the QR was damaged.” Nothing imports.
   This is the GCM auth-tag failing — the QR carries no usable key without the code.

## 4. Abort after an on-ledger change (single account)

1. Pair an account; on the **QR screen**, click **Abort — revoke these keys now.**
2. **Expect:** “Revoking…” then the wizard returns to the picker; the account is no
   longer under PHONE KEYS. One `SetRegularKey` (cleared) was submitted.
3. Explorer: the account’s RegularKey is now gone.

## 5. Partial failure → offered revoke

To force a partial failure, pair **two** accounts where one will fail (e.g. one is
**unfunded** so its `SetRegularKey` can’t validate):

1. Pick a funded test account **and** a brand-new unfunded one → Continue → password → go.
2. **Run screen:** one row “✓ regular key set”, one row “✗ <error>”.
3. The **partial-failure panel** appears with two choices:
   - **Revoke the keys that were set** → clears the regular key on the account that
     succeeded; returns to the picker.
   - **Continue with successful accounts** → proceeds to the QR for the one that worked.
4. Try **Revoke**: confirm the funded account’s RegularKey is cleared on-ledger.

## 6. Revoke from the status list

1. Pair an account so it shows under **PHONE KEYS**.
2. Enter your **master password** in the field there.
3. Click **Revoke** on that row (or **Revoke phone — all accounts**).
4. **Expect:** “✓ revoked r…”, the row disappears, RegularKey cleared on-ledger.
   The phone, on its next launch/foreground, will detect this and show **Device revoked**
   (see `labs-mobile/MANUAL_TEST.md` §5).

## 7. Master-password gating

- On the Confirm screen, a wrong password → returns to Confirm with “Wrong master password.”
  **No** `SetRegularKey` is submitted.
- Revoke with an empty/wrong password → “Enter the master password to revoke.” / per-account
  `wrong_password`. Nothing submitted.

## 8. Secrets never hit disk (inspection)

- Open the wallet data file (Help → **Open data folder** → `labs-wallet-data.json`).
- After pairing, find the account under `wallets`. It has `desktopOnly` and a `pairing`
  block with **`regularKeyAddress` + `pairedAt` only** — **no seed, no regular-key secret.**
- The regular-key **seeds** existed only in memory during the wizard and inside the
  encrypted QR. Confirm no seed string appears anywhere in the JSON.

## What is intentionally NOT touched
- `src/bridge/*` (site bridge, port 17760) — frozen, unused by pairing.
- `src/wallet/sync.js` / `sync:*` — cloud backup, separate feature.
- `src/wallet/auto-sign.js` — unchanged; it already hard-blocks `SetRegularKey`,
  so pairing’s submits go only through the explicit master-password path here.
- keytar service names, electron-store name (`labs-wallet-data`) — unchanged.
