// generate.js — create a fresh XRPL wallet.
// Output is shaped to match what storage.js wants: { address, classicAddress, seed, publicKey }.

'use strict';

const xrpl = require('xrpl');

function create(opts = {}) {
    const algo = opts.algorithm || 'ed25519'; // 'ed25519' (default) or 'secp256k1'
    const wallet = xrpl.Wallet.generate(algo);
    return shape(wallet);
}

function shape(wallet) {
    return {
        address:        wallet.classicAddress || wallet.address,
        classicAddress: wallet.classicAddress || wallet.address,
        seed:           wallet.seed,
        publicKey:      wallet.publicKey,
    };
}

module.exports = { create, shape };
