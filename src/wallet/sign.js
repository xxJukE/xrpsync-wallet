// sign.js — local transaction signing using xrpl.js.
// Takes a seed (already decrypted by storage.js) plus a *prepared* (autofilled) transaction
// and returns { tx_blob, hash }. Never logs or persists the seed.

'use strict';

const xrpl = require('xrpl');

function sign(seed, preparedTx) {
    if (!seed) throw new Error('seed_required');
    if (!preparedTx || typeof preparedTx !== 'object') throw new Error('tx_required');
    const wallet = xrpl.Wallet.fromSeed(seed);
    const { tx_blob, hash } = wallet.sign(preparedTx);
    return { tx_blob, hash };
}

module.exports = { sign };
