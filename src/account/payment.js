// account/payment.js — one-call subscription upgrade flow inside the wallet.
//
// Glue between Labs API + existing XRPL signing modules. Builds a Payment
// transaction from the server's `initiate` response, signs it with the
// user's seed (requires master password unlock at this point — same model
// as the Send pane), submits to XRPL, then verifies on the server.

'use strict';

const Api = require('./api');

function hex(s) {
    return Buffer.from(String(s), 'utf8').toString('hex').toUpperCase();
}

/**
 * Run the full upgrade flow.
 *
 * @param {object} deps
 *   token        — Labs Bearer token
 *   tierSlug     — 'pro' | 'growth'
 *   address      — XRPL address paying from (active wallet)
 *   password     — master password (used to reveal the seed)
 *   store        — WalletStore module
 *   sign         — WalletSign module
 *   xrpl         — XrplConnection module (autofill)
 *   submit       — XrplSubmit module (submitSignedBlob)
 *
 * @returns {Promise<object>} { tx_hash, tier, expires_at, payment_id, signed }
 */
async function upgrade({ token, tierSlug, address, password, store, sign, xrpl, submit }) {
    if (!token) throw new Error('not logged in to Labs');
    if (!tierSlug) throw new Error('tier required');
    if (!address) throw new Error('no active wallet address');
    if (!password) throw new Error('master password required');

    // 1. Ask the server for the unsigned tx + memo.
    const init = await Api.subscribe(token, tierSlug);
    if (!init.ok || !init.body.ok) {
        const err = (init.body && init.body.error) || ('initiate failed status=' + init.status);
        throw new Error(err);
    }
    const unsigned = init.body.unsigned_tx;
    const paymentId = init.body.payment_id;
    if (!unsigned || unsigned.TransactionType !== 'Payment') {
        throw new Error('server did not return a Payment tx');
    }
    // Defensive: re-check that the tx is paying FROM the active wallet. The
    // server bases this on the user's xrpl_address, but the wallet may have
    // multiple wallets — pin to the address the user is paying with.
    unsigned.Account = address;

    // 2. Reveal seed, sign locally, submit.
    const seed = await store.revealSecret(address, password);
    const prepared = await xrpl.autofill(unsigned);
    const signed = sign.sign(seed, prepared);
    const submitResult = await submit.submitSignedBlob(signed.tx_blob);

    // 3. Ask the server to verify — it will pull the tx from XRPL and
    // activate the subscription. Idempotent on tx_hash.
    const verify = await Api.verifyPayment(token, {
        signed_blob: signed.tx_blob,
        tx_hash: signed.hash,
        payment_id: paymentId,
    });
    if (!verify.ok || !verify.body.success) {
        // The XRPL submit may have succeeded even if /verify failed. Return
        // the tx hash so the UI can show "submitted — server will pick it up
        // on the next poller tick".
        return {
            tx_hash: signed.hash,
            tier: tierSlug,
            expires_at: null,
            payment_id: paymentId,
            signed: signed,
            submit_result: submitResult,
            verified: false,
            verify_error: (verify.body && verify.body.error) || 'verification deferred',
        };
    }

    return {
        tx_hash: signed.hash,
        tier: verify.body.tier,
        expires_at: verify.body.expires_at,
        payment_id: verify.body.payment_id,
        signed: signed,
        submit_result: submitResult,
        verified: true,
    };
}

module.exports = { upgrade, hex };
