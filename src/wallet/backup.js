// backup.js — export and import the full wallet store as a single password-protected blob.
//
// Export shape (JSON):
//   { v: 1, created_at, salt, iv, ct }
// `ct` decrypts to a JSON document: { wallets: [...], rules: {...} }
//
// The backup uses an INDEPENDENT password (the user's choice at backup time), distinct
// from the master password. That way you can export to a stronger password before sharing
// or storing offline.

'use strict';

const crypto = require('crypto');
const Store = require('./storage');

const PBKDF2_ITERS = 200_000;

async function exportAll(backupPassword) {
    if (!backupPassword || backupPassword.length < 8) throw new Error('backup_password_too_short');

    // We need access to RAW seeds, not encrypted blobs — so the user must already be unlocked.
    const wallets = Store.listWallets().map(w => ({
        address: w.address,
        label: w.label,
        addedAt: w.addedAt,
        // We re-decrypt with the in-memory unlocked key, then re-encrypt with the backup password
        seed: Store.revealAutoSignSecret(w.address),
    }));

    const payload = JSON.stringify({
        wallets,
        rules: Store.getAutoSignRules(),
    });

    const salt = crypto.randomBytes(32);
    const key = await pbkdf2(backupPassword, salt);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return JSON.stringify({
        v: 1,
        created_at: new Date().toISOString(),
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        ct: Buffer.concat([ct, tag]).toString('base64'),
    }, null, 2);
}

async function importAll(blob, backupPassword) {
    let parsed;
    try { parsed = JSON.parse(blob); } catch (_) { throw new Error('invalid_backup_file'); }
    if (parsed.v !== 1) throw new Error('unsupported_backup_version');

    const salt = Buffer.from(parsed.salt, 'base64');
    const key = await pbkdf2(backupPassword, salt);
    const iv = Buffer.from(parsed.iv, 'base64');
    const ctTag = Buffer.from(parsed.ct, 'base64');
    const ct = ctTag.subarray(0, ctTag.length - 16);
    const tag = ctTag.subarray(ctTag.length - 16);

    let plain;
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch (_) {
        throw new Error('wrong_backup_password');
    }

    const data = JSON.parse(plain);
    let imported = 0;
    for (const w of (data.wallets || [])) {
        try {
            // Build the wallet shape so storage.saveWallet can re-encrypt with the live master key
            const xrpl = require('xrpl');
            const xw = xrpl.Wallet.fromSeed(w.seed);
            await Store.saveWallet({
                address: xw.classicAddress,
                classicAddress: xw.classicAddress,
                seed: w.seed,
                publicKey: xw.publicKey,
            }, w.label || null);
            imported++;
        } catch (_) {
            // skip malformed entry
        }
    }

    if (data.rules && typeof data.rules === 'object') Store.setAutoSignRules(data.rules);
    return imported;
}

function pbkdf2(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.pbkdf2(password, salt, PBKDF2_ITERS, 32, 'sha512', (err, key) => {
            if (err) return reject(err);
            resolve(key);
        });
    });
}

module.exports = { exportAll, importAll };
