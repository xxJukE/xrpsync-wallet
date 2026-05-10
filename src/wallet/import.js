// import.js — import wallet from seed, secret, or BIP-39 mnemonic.

'use strict';

const xrpl = require('xrpl');
const { shape } = require('./generate');

// kind: 'seed' | 'secret' | 'mnemonic'
// secret/seed are the same thing in xrpl.js terminology — the family seed `s...`.
function fromInput(kind, value) {
    if (!value || typeof value !== 'string') throw new Error('empty_input');
    const v = value.trim();

    switch ((kind || '').toLowerCase()) {
        case 'seed':
        case 'secret':
            return shape(xrpl.Wallet.fromSeed(v));
        case 'mnemonic':
            return shape(xrpl.Wallet.fromMnemonic(v));
        default: {
            // Auto-detect: family seed always starts with 's', mnemonics have multiple words
            if (/\s/.test(v)) return shape(xrpl.Wallet.fromMnemonic(v));
            if (v.startsWith('s')) return shape(xrpl.Wallet.fromSeed(v));
            throw new Error('unknown_input_format');
        }
    }
}

module.exports = { fromInput };
