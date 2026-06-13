// pairing-envelope.js — encrypted QR envelope for desktop → phone pairing.
//
// SHARED FORMAT — must stay byte-compatible with the decoder in
// labs-mobile/src/crypto/envelope.ts. Change one, change both, and re-run
// scripts/pairing-roundtrip-test.js.
//
// QR text:   "XRPSYNC-PAIR/1." + base64url( JSON.stringify(envelope) )
// envelope:  { v:1, kdf:'scrypt', n:131072, r:8, p:1,
//              salt:<b64 16B>, iv:<b64 12B>, ct:<b64 ciphertext||16B GCM tag> }
// key:       scrypt(utf8(code), salt, N=2^17, r=8, p=1, dkLen=32)
// cipher:    AES-256-GCM (@noble/ciphers — tag appended to ciphertext)
// plaintext: utf8( JSON.stringify({ v:1, accounts:[{label,address,regularKeySeed}] }) )
//
// The KDF here is DELIBERATELY scrypt via @noble/hashes, not the wallet
// store's Argon2id: Expo Go cannot load native modules, and the noble libs
// are audited pure-JS that produce identical bytes in Node and React Native.
// This KDF is for the pairing envelope ONLY — never touch storage.js's KDF.
//
// The one-time code is shown BESIDE the QR, never inside it: a photo of the
// QR alone is useless. Neither the code nor the decrypted payload is ever
// written to disk — both live only in memory for the duration of the wizard.

'use strict';

const crypto = require('crypto');
const { gcm } = require('@noble/ciphers/aes');
const { scrypt } = require('@noble/hashes/scrypt');

const QR_PREFIX = 'XRPSYNC-PAIR/1.';
const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, dkLen: 32 };
const CODE_DIGITS = 8;

/**
 * Crypto-random 8-digit one-time code (leading zeros allowed → always 8 chars).
 * Rejection sampling keeps the distribution uniform across 00000000–99999999.
 */
function generateOneTimeCode() {
    const RANGE = 10 ** CODE_DIGITS;                       // 1e8
    const LIMIT = Math.floor(0x1_0000_0000 / RANGE) * RANGE; // largest multiple of 1e8 ≤ 2^32
    for (;;) {
        const u32 = crypto.randomBytes(4).readUInt32BE(0);
        if (u32 < LIMIT) return String(u32 % RANGE).padStart(CODE_DIGITS, '0');
    }
}

function deriveKey(code, salt) {
    if (!/^\d{8}$/.test(code)) throw new Error('code_must_be_8_digits');
    return scrypt(Buffer.from(code, 'utf8'), salt, SCRYPT_PARAMS);
}

/**
 * Encrypt the transfer payload under the one-time code.
 * @param {{v:1, accounts:Array<{label:string|null, address:string, regularKeySeed:string}>}} payload
 * @param {string} code  8-digit one-time code from generateOneTimeCode()
 * @returns {string} the full QR text
 */
function encryptEnvelope(payload, code) {
    if (!payload || payload.v !== 1 || !Array.isArray(payload.accounts) || !payload.accounts.length) {
        throw new Error('bad_payload');
    }
    for (const a of payload.accounts) {
        if (!a || !a.address || !a.regularKeySeed) throw new Error('bad_payload_account');
    }
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveKey(code, salt);
    const ct = gcm(key, iv).encrypt(Buffer.from(JSON.stringify(payload), 'utf8'));
    const envelope = {
        v: 1,
        kdf: 'scrypt',
        n: SCRYPT_PARAMS.N,
        r: SCRYPT_PARAMS.r,
        p: SCRYPT_PARAMS.p,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        ct: Buffer.from(ct).toString('base64'),
    };
    return QR_PREFIX + Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

module.exports = { QR_PREFIX, SCRYPT_PARAMS, CODE_DIGITS, generateOneTimeCode, encryptEnvelope, deriveKey };
