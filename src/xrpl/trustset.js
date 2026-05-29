// trustset.js — build, sign, and submit a TrustSet transaction.
// Mirrors the connection/signing pattern in trustlines.js + sign.js: the caller
// passes an already-unlocked xrpl.js Wallet (resolved in main from the master
// password), we autofill via the shared Conn client, sign locally, and wait for
// validation. Read-only listing stays in trustlines.js; this is the write side.

'use strict';

const Conn = require('./connection');

// XRPL currency codes are either a 3-char ISO-style code or a 40-char (160-bit)
// hex code. Non-standard codes longer than 3 chars (e.g. "RLUSD") MUST be sent
// hex-encoded — left-aligned ASCII, zero-padded to 40. We accept all three input
// forms and emit what the ledger expects.
function normalizeCurrency(currency) {
    const c = String(currency || '').trim();
    if (/^[0-9A-Fa-f]{40}$/.test(c)) return c.toUpperCase();   // already hex
    if (c.length === 3) return c;                              // ISO 3-char, as-is
    if (c.length >= 1 && c.length <= 20 && /^[\x20-\x7E]+$/.test(c)) {
        return Buffer.from(c, 'ascii').toString('hex').toUpperCase().padEnd(40, '0');
    }
    return null;
}

async function submit({ wallet, currency, issuer, limit } = {}) {
    try {
        if (!wallet || typeof wallet.sign !== 'function' || !wallet.address) {
            return { ok: false, error: 'unlocked_wallet_required' };
        }
        const cur = normalizeCurrency(currency);
        if (!cur) return { ok: false, error: 'invalid_currency (use a 3-char code or 40-char hex)' };
        if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(String(issuer || ''))) {
            return { ok: false, error: 'invalid_issuer_address' };
        }
        const limStr = String(limit ?? '').trim();
        if (!/^\d+(\.\d+)?$/.test(limStr) || Number(limStr) < 0) {
            return { ok: false, error: 'invalid_limit (must be a number >= 0)' };
        }

        const tx = {
            TransactionType: 'TrustSet',
            Account: wallet.address,
            LimitAmount: { currency: cur, issuer, value: limStr },
            Flags: 0,
        };

        const client = await Conn.getClient();
        const prepared = await client.autofill(tx);
        const signed = wallet.sign(prepared);
        const res = await client.submitAndWait(signed.tx_blob);

        const engine = res?.result?.meta?.TransactionResult || res?.result?.engine_result || null;
        const txHash = res?.result?.hash || signed.hash || null;
        if (engine === 'tesSUCCESS') {
            return { ok: true, tx_hash: txHash, engine_result: engine };
        }
        return { ok: false, error: engine || 'submit_failed', tx_hash: txHash };
    } catch (e) {
        return { ok: false, error: (e && (e.message || String(e))) || 'trustset_failed' };
    }
}

module.exports = { submit };
