#!/usr/bin/env node
/**
 * argon2-compat-test.js
 *
 * Verifies that @node-rs/argon2 produces BYTE-IDENTICAL raw Argon2id output to
 * argon2@0.40.3 for the exact parameters the wallet uses.
 *
 * WHY THIS MATTERS:
 *   src/wallet/storage.js does NOT use argon2.hash()/verify() with PHC strings.
 *   It derives the AES-256-GCM key directly:
 *     argon2.hash(password, { type: argon2id, memoryCost: 65536, timeCost: 3,
 *                             parallelism: 4, hashLength: 32, salt, raw: true })
 *   and "verifies" by AES-GCM-decrypting a known plaintext with that key.
 *   So swapping to @node-rs/argon2 is safe ONLY if it yields the SAME 32 raw
 *   bytes for the same (password, salt, params). MISMATCH ⇒ swapping locks out
 *   every existing wallet. Run this BEFORE shipping any swap.
 *
 * RUN ON THE HOST:
 *   cd /www/wwwroot/lab-app/labs-wallet
 *   node scripts/argon2-compat-test.js
 *
 * Exit codes: 0 = MATCH (safe), 1 = MISMATCH (do not swap), 2 = setup error.
 */
'use strict';

const crypto = require('crypto');
const { execSync } = require('child_process');

// Must stay in sync with ARGON2_PARAMS in src/wallet/storage.js.
const PARAMS = { memoryCost: 65536, timeCost: 3, parallelism: 4, hashLength: 32 };

// ── load the existing dependency: argon2@0.40.3 ──
let oldArgon2;
try {
    oldArgon2 = require('argon2');
} catch (e) {
    console.error('FATAL: could not load argon2 (the existing dependency):', e.message);
    console.error('Run `npm ci` in labs-wallet first.');
    process.exit(2);
}

// ── load @node-rs/argon2, installing transiently (--no-save) if absent ──
function loadNrs() {
    try { return require('@node-rs/argon2'); } catch (_) { return null; }
}
let nrs = loadNrs();
if (!nrs) {
    console.log('@node-rs/argon2 not installed — installing transiently with --no-save …\n');
    try {
        execSync('npm install --no-save @node-rs/argon2', { stdio: 'inherit' });
    } catch (e) {
        console.error('FATAL: `npm install --no-save @node-rs/argon2` failed:', e.message);
        process.exit(2);
    }
    nrs = loadNrs();
    if (!nrs) {
        console.error('FATAL: @node-rs/argon2 still not loadable after install.');
        process.exit(2);
    }
}

// @node-rs/argon2 Argon2id id — use its enum if exposed, else the numeric value (2).
const NRS_ARGON2ID = (nrs.Algorithm && nrs.Algorithm.Argon2id != null) ? nrs.Algorithm.Argon2id : 2;

// argon2@0.40.3: raw key derivation → Buffer(hashLength). version omitted ⇒ default 0x13.
async function deriveOld(password, salt) {
    return oldArgon2.hash(password, {
        type: oldArgon2.argon2id,
        memoryCost: PARAMS.memoryCost,
        timeCost: PARAMS.timeCost,
        parallelism: PARAMS.parallelism,
        hashLength: PARAMS.hashLength,
        salt,
        raw: true,
    });
}

// @node-rs/argon2: hash() returns a PHC string:
//   $argon2id$v=19$m=65536,t=3,p=4$<saltB64>$<hashB64>
// We parse the salt it actually used + the raw hash bytes, so the comparison is
// fair even if @node-rs ignores the salt we passed and generates its own.
async function deriveNrs(password, salt) {
    const phc = await nrs.hash(password, {
        algorithm: NRS_ARGON2ID,
        memoryCost: PARAMS.memoryCost,
        timeCost: PARAMS.timeCost,
        parallelism: PARAMS.parallelism,
        outputLen: PARAMS.hashLength,
        salt,
        // version omitted ⇒ default 0x13 (19), matching argon2@0.40.3.
    });
    const parts = String(phc).split('$'); // ['', 'argon2id', 'v=19', 'm=..,t=..,p=..', saltB64, hashB64]
    return {
        phc,
        version: (parts[2] || '').replace('v=', '') || '?',
        usedSalt: Buffer.from(parts[parts.length - 2], 'base64'),
        raw: Buffer.from(parts[parts.length - 1], 'base64'),
    };
}

function preview(s) {
    const t = String(s);
    return t.length > 36 ? t.slice(0, 33) + '…' : t;
}

// Realistic 24-char sample using storage.js's generateMasterPassword alphabet.
function generatedSample() {
    const ALPHA = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*';
    let out = '';
    const buf = crypto.randomBytes(64);
    for (let i = 0; i < buf.length && out.length < 24; i++) if (buf[i] < 252) out += ALPHA[buf[i] % ALPHA.length];
    return out;
}

(async () => {
    console.log('argon2 (old)     :', require('argon2/package.json').version);
    try { console.log('@node-rs/argon2  :', require('@node-rs/argon2/package.json').version); } catch (_) {}
    console.log('params           :', JSON.stringify(PARAMS));
    console.log('');

    const passwords = [
        'correct horse battery staple',
        'Tr0ub4dor&3-XRPSync!',
        generatedSample(),
        '🔐 unicode pässwörd 测试 1234',
        'x'.repeat(64),
    ];

    let allMatch = true;
    for (let i = 0; i < passwords.length; i++) {
        const password = passwords[i];
        const salt = crypto.randomBytes(32);
        const nr = await deriveNrs(password, salt);
        // Compare against the salt @node-rs actually used (handles either behavior).
        const old = await deriveOld(password, nr.usedSalt);
        const saltHonored = Buffer.compare(salt, nr.usedSalt) === 0;
        const match = Buffer.isBuffer(old) && old.length === nr.raw.length && Buffer.compare(old, nr.raw) === 0;
        allMatch = allMatch && match;

        console.log(`#${i + 1}  ${match ? 'MATCH ✅' : 'MISMATCH ❌'}   (argon2 version v=${nr.version}, salt honored: ${saltHonored})`);
        console.log(`    pw     : ${preview(password)}`);
        console.log(`    salt   : ${nr.usedSalt.toString('hex')}`);
        console.log(`    old    : ${old.toString('hex')}`);
        console.log(`    node-rs: ${nr.raw.toString('hex')}`);
        console.log('');
    }

    console.log('────────────────────────────────────────────────────────────');
    if (allMatch) {
        console.log('RESULT: MATCH ✅  — @node-rs/argon2 is byte-compatible for these params.');
        console.log('Safe to swap: existing argon2id wallets will unlock unchanged.');
        process.exit(0);
    } else {
        console.log('RESULT: MISMATCH ❌  — DO NOT SWAP.');
        console.log('Swapping would lock out every existing wallet. Fix argon2 packaging instead.');
        process.exit(1);
    }
})().catch((e) => {
    console.error('\nTEST ERROR:', e && (e.stack || e.message || e));
    console.error('If this is an API-shape error from @node-rs/argon2 (option names / raw output),');
    console.error('report the error and we will adjust the script to its actual API.');
    process.exit(2);
});
