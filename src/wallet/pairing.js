// pairing.js — desktop side of phone pairing (regular-key provisioning).
//
// Flow (per docs/DECISIONS.md 2026-06-13 "Mobile wallet architecture"):
//   1. User picks accounts (desktopOnly accounts are NEVER offered — enforced
//      here as well as in the UI) and confirms an explicit list.
//   2. For each account we mint a FRESH keypair, submit SetRegularKey signed
//      by the account's master seed (master-password gated), and on tesSUCCESS
//      keep the new seed IN MEMORY ONLY for the QR envelope.
//   3. The regular-key seeds go to the phone via an encrypted QR
//      (pairing-envelope.js) + an 8-digit one-time code shown beside it.
//   4. Desktop persists only { regularKeyAddress, pairedAt } per account.
//   5. "Revoke phone" submits SetRegularKey with the RegularKey field OMITTED
//      (= cleared on-ledger) — one transaction per account kills that
//      account's phone key. Also master-password gated.
//
// Regular-key seeds are NEVER written to disk on desktop, never logged, and
// never leave this module except inside the encrypted envelope returned to
// the renderer for display.
//
// This module does NOT touch src/bridge/* (frozen protocol, port 17760),
// src/wallet/sync.js (separate cloud-backup feature), or auto-sign. Note
// auto-sign already hard-blocks SetRegularKey — these submissions go through
// the explicit master-password path only.

'use strict';

const xrpl = require('xrpl');
const WalletStore = require('./storage');
const WalletSign = require('./sign');
const XrplConnection = require('../xrpl/connection');
const XrplSubmit = require('../xrpl/submit');
const Envelope = require('./pairing-envelope');

/**
 * Accounts the wizard may offer: every stored wallet NOT flagged desktopOnly.
 * Includes current pairing status so the UI can show paired/unpaired state.
 */
function listEligible() {
    return WalletStore.listWallets()
        .filter(w => !w.desktopOnly)
        .map(w => ({
            address: w.address,
            label: w.label,
            pairing: w.pairing,
        }));
}

/** Pairing status for every wallet (including desktopOnly — for the settings list). */
function status() {
    return WalletStore.listWallets().map(w => ({
        address: w.address,
        label: w.label,
        desktopOnly: w.desktopOnly,
        pairing: w.pairing,
    }));
}

/**
 * The exact transaction this module submits, before autofill.
 * Set:    { TransactionType:'SetRegularKey', Account, RegularKey:<new address> }
 * Revoke: { TransactionType:'SetRegularKey', Account }   // field omitted = cleared
 * autofill() adds Fee / Sequence / LastLedgerSequence; the account's MASTER
 * seed signs. Exposed so the UI confirm step can show the real shape.
 */
function buildSetRegularKeyTx(account, regularKeyAddress) {
    const tx = { TransactionType: 'SetRegularKey', Account: account };
    if (regularKeyAddress) tx.RegularKey = regularKeyAddress;
    return tx;
}

/**
 * Pair the given accounts: mint keypair → SetRegularKey → encrypted QR + code.
 *
 * @param {string[]} addresses  accounts the user explicitly confirmed
 * @param {string}   password   master password (verified per-account via revealSecret)
 * @returns {{
 *   ok: boolean,
 *   results: Array<{ address, label, ok, regularKeyAddress?, txHash?, error? }>,
 *   qrText?: string, code?: string,    // only when ≥1 account succeeded
 * }}
 * The caller (renderer) must treat qrText+code as display-only and drop them
 * when the wizard closes. On partial failure the UI offers immediate revoke
 * of the accounts that DID change on-ledger.
 */
async function begin(addresses, password) {
    if (!Array.isArray(addresses) || !addresses.length) return { ok: false, error: 'no_accounts_selected', results: [] };

    const all = WalletStore.listWallets();
    const byAddr = Object.fromEntries(all.map(w => [w.address, w]));

    // Verify the master password ONCE up front (cheap fail before any ledger
    // work) using the first account's seed reveal.
    try { await WalletStore.revealSecret(addresses[0], password); }
    catch (e) {
        const code = (e && e.message) === 'wrong_password' ? 'wrong_password' : (e && e.message) || 'reveal_failed';
        return { ok: false, error: code, results: [] };
    }

    const results = [];
    const transferAccounts = []; // { label, address, regularKeySeed } — memory only

    for (const address of addresses) {
        const meta = byAddr[address];
        if (!meta) { results.push({ address, label: null, ok: false, error: 'wallet_not_found' }); continue; }
        // Enforce desktopOnly in main, not just the UI picker.
        if (meta.desktopOnly) { results.push({ address, label: meta.label, ok: false, error: 'desktop_only' }); continue; }

        try {
            const masterSeed = await WalletStore.revealSecret(address, password);
            const fresh = xrpl.Wallet.generate(); // fresh regular keypair, per account
            const prepared = await XrplConnection.autofill(buildSetRegularKeyTx(address, fresh.classicAddress));
            const signed = WalletSign.sign(masterSeed, prepared);
            const r = await XrplSubmit.submitAndWait(signed.tx_blob);
            if (r.engine_result === 'tesSUCCESS') {
                WalletStore.setPairing(address, { regularKeyAddress: fresh.classicAddress, pairedAt: new Date().toISOString() });
                transferAccounts.push({ label: meta.label || null, address, regularKeySeed: fresh.seed });
                results.push({ address, label: meta.label, ok: true, regularKeyAddress: fresh.classicAddress, txHash: r.tx_hash });
            } else {
                results.push({ address, label: meta.label, ok: false, error: r.engine_result || 'submit_failed' });
            }
        } catch (e) {
            results.push({ address, label: meta.label, ok: false, error: (e && e.message) || 'pair_failed' });
        }
    }

    if (!transferAccounts.length) return { ok: false, error: 'all_accounts_failed', results };

    const code = Envelope.generateOneTimeCode();
    const qrText = Envelope.encryptEnvelope({ v: 1, accounts: transferAccounts }, code);
    // transferAccounts (and the seeds inside) go out of scope here — nothing
    // below this line persists them.
    return { ok: true, results, qrText, code };
}

/**
 * Revoke the phone for the given accounts: SetRegularKey with the field
 * omitted clears the regular key on-ledger; any key the phone holds for that
 * account is dead the moment the tx validates.
 */
async function revoke(addresses, password) {
    if (!Array.isArray(addresses) || !addresses.length) return { ok: false, error: 'no_accounts_selected', results: [] };

    const all = WalletStore.listWallets();
    const byAddr = Object.fromEntries(all.map(w => [w.address, w]));

    const results = [];
    for (const address of addresses) {
        const meta = byAddr[address];
        if (!meta) { results.push({ address, label: null, ok: false, error: 'wallet_not_found' }); continue; }
        try {
            const masterSeed = await WalletStore.revealSecret(address, password);
            const prepared = await XrplConnection.autofill(buildSetRegularKeyTx(address, null));
            const signed = WalletSign.sign(masterSeed, prepared);
            const r = await XrplSubmit.submitAndWait(signed.tx_blob);
            if (r.engine_result === 'tesSUCCESS') {
                WalletStore.clearPairing(address);
                results.push({ address, label: meta.label, ok: true, txHash: r.tx_hash });
            } else {
                results.push({ address, label: meta.label, ok: false, error: r.engine_result || 'submit_failed' });
            }
        } catch (e) {
            const code = (e && e.message) === 'wrong_password' ? 'wrong_password' : (e && e.message) || 'revoke_failed';
            results.push({ address, label: meta.label, ok: false, error: code });
        }
    }
    return { ok: results.every(r => r.ok), results };
}

module.exports = { listEligible, status, begin, revoke, buildSetRegularKeyTx };
