#!/usr/bin/env node
// pairing-roundtrip-test.js — proves the desktop pairing-envelope encoder and
// the MOBILE decoder (labs-mobile/src/crypto/envelope.ts) are byte-compatible.
//
// Encrypts with labs-wallet/src/wallet/pairing-envelope.js, decrypts with the
// real mobile TypeScript module (transpiled on the fly with labs-mobile's own
// typescript install — no separate build step, no duplicated logic).
//
// Checks:
//   1. exact payload match after desktop-encrypt → mobile-decrypt
//   2. wrong one-time code fails (GCM auth)
//   3. tampered ciphertext fails (GCM auth)
//   4. non-pairing QR text is rejected
//
// Run: node scripts/pairing-roundtrip-test.js

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const Desktop = require('../src/wallet/pairing-envelope');

// ── load the mobile decoder (transpile TS → CJS, require in-place so its
//    @noble imports resolve from labs-mobile/node_modules) ──────────────────
const MOBILE_ROOT = path.resolve(__dirname, '../../labs-mobile');
const MOBILE_TS = path.join(MOBILE_ROOT, 'src/crypto/envelope.ts');
const TMP_CJS = path.join(MOBILE_ROOT, 'src/crypto/.envelope.roundtrip.cjs');

const ts = require(path.join(MOBILE_ROOT, 'node_modules/typescript'));
const out = ts.transpileModule(fs.readFileSync(MOBILE_TS, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
fs.writeFileSync(TMP_CJS, out.outputText);

async function main() {
    const Mobile = require(TMP_CJS);

    const payload = {
        v: 1,
        accounts: [
            { label: 'Trading', address: 'rPx3LK1c9rDmzAseDDPzZ8sP9hUVAa9dQf', regularKeySeed: 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2' },
            { label: null, address: 'r9cZA1mLK9JFXa5cMG8wbVJtSNHkqHk4q', regularKeySeed: 'sEd7rBGm5kxzauRTAV2hbsNz7N45X91' },
        ],
    };

    // 1 — round trip, exact match
    const code = Desktop.generateOneTimeCode();
    assert.match(code, /^\d{8}$/, 'one-time code must be 8 digits');
    const qrText = Desktop.encryptEnvelope(payload, code);
    assert.ok(qrText.startsWith(Desktop.QR_PREFIX), 'QR text carries the version prefix');
    assert.ok(Mobile.looksLikePairingQr(qrText), 'mobile recognises the QR');
    const decrypted = await Mobile.decryptEnvelope(qrText, code);
    assert.deepStrictEqual(decrypted, payload, 'decrypted payload must exactly match');
    console.log('PASS  desktop-encrypt → mobile-decrypt: exact payload match');
    console.log('      code=' + code + '  qrText=' + qrText.length + ' chars');

    // 2 — wrong code fails
    const wrongCode = code === '00000000' ? '00000001' : '00000000';
    await assert.rejects(
        () => Mobile.decryptEnvelope(qrText, wrongCode),
        (e) => e.message === 'bad_code_or_tampered',
        'wrong code must fail GCM auth'
    );
    console.log('PASS  wrong one-time code rejected (bad_code_or_tampered)');

    // 3 — tampered ciphertext fails: flip one bit inside the envelope's ct
    const envJson = JSON.parse(Buffer.from(qrText.slice(Desktop.QR_PREFIX.length), 'base64url').toString('utf8'));
    const ctBytes = Buffer.from(envJson.ct, 'base64');
    ctBytes[Math.floor(ctBytes.length / 2)] ^= 0x01;
    envJson.ct = ctBytes.toString('base64');
    const tamperedQr = Desktop.QR_PREFIX + Buffer.from(JSON.stringify(envJson), 'utf8').toString('base64url');
    await assert.rejects(
        () => Mobile.decryptEnvelope(tamperedQr, code),
        (e) => e.message === 'bad_code_or_tampered',
        'tampered ciphertext must fail GCM auth'
    );
    console.log('PASS  tampered ciphertext rejected (bad_code_or_tampered)');

    // 4 — non-pairing QR rejected before any KDF work
    await assert.rejects(
        () => Mobile.decryptEnvelope('rPx3LK1c9rDmzAseDDPzZ8sP9hUVAa9dQf', code),
        (e) => e.message === 'not_a_pairing_qr',
        'plain address QR must be rejected'
    );
    console.log('PASS  non-pairing QR text rejected (not_a_pairing_qr)');

    console.log('\nALL 4 CHECKS PASSED — encoder and mobile decoder are byte-compatible.');
}

main()
    .catch((e) => { console.error('FAIL', e); process.exitCode = 1; })
    .finally(() => { try { fs.unlinkSync(TMP_CJS); } catch (_) {} });
