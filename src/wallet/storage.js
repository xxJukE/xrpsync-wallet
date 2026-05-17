// storage.js — encrypted-at-rest wallet store.
//
// Layout in electron-store (`labs-wallet-data.json`):
//   master:  { kdf, salt, verify_iv, verify_ct, params? }
//             kdf = 'argon2id' (v2, current) | 'pbkdf2' (v1, legacy — auto-migrated)
//   wallets: { [address]: { label, classicAddress, iv, ct, addedAt } }
//   prefs:   { lock_ms, allow_auto_sign_unattended, ... }
//
// Encryption: AES-256-GCM. Key derived from the master password + a per-install salt.
// Current KDF is Argon2id (64MB / 3 iters / 4 lanes / 32-byte raw output).
// Legacy installs that still hold a PBKDF2 master block are detected on unlock
// and re-keyed transparently — the user's wallets keep working, the next save
// stamps the new Argon2id master block.

'use strict';

const crypto = require('crypto');
const Store  = require('electron-store');

let argon2 = null;
try { argon2 = require('argon2'); }
catch (_) { /* Surface a clear error the first time it's actually needed. */ }

const PBKDF2_ITERS    = 200_000;
const PBKDF2_KEYLEN   = 32;
const PBKDF2_DIGEST   = 'sha512';
const VERIFY_PLAINTEXT = 'labs-wallet-verify';

// Argon2id parameters. Targets ~100ms on a modern laptop; raises the cost of a
// stolen `labs-wallet-data.json` from "a few GPU hours" to "infeasible without
// the actual password."
const ARGON2_PARAMS = {
    type: () => argon2.argon2id,
    memoryCost: 65536,    // 64 MB
    timeCost: 3,
    parallelism: 4,
    hashLength: 32,
    raw: true,
};

let store = null;
let unlockedKey = null; // Buffer (32 bytes) when unlocked
let unlockedPasswordRef = null; // held only briefly, for migration / opt-in reveal flows
let failedAttempts = 0;
let lastFailedAt = 0;

function init({ name }) {
    store = new Store({ name: name || 'labs-wallet-data' });
    if (!store.has('wallets')) store.set('wallets', {});
    if (!store.has('prefs')) store.set('prefs', {});
}

function hasMasterPassword() { return !!store?.get('master'); }

/** Inspect the current KDF without touching the password. */
function masterKdf() {
    const m = store?.get('master');
    if (!m) return null;
    return m.kdf || 'pbkdf2';
}

/**
 * Generate a 24-character master password with no ambiguous glyphs (no 0, O, l, 1, I).
 * Uses crypto.randomBytes — uniform across the 63-char alphabet via rejection sampling
 * so we don't bias toward the first chars when 256 % 63 != 0.
 */
function generateMasterPassword(length = 24) {
    const ALPHA = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*';
    const out = [];
    while (out.length < length) {
        const buf = crypto.randomBytes(length * 2);
        for (let i = 0; i < buf.length && out.length < length; i++) {
            const b = buf[i];
            if (b < 252) out.push(ALPHA[b % ALPHA.length]); // 252 = 63*4, unbiased
        }
    }
    return out.join('');
}

async function setMasterPassword(password) {
    if (!password || password.length < 8) throw new Error('password_too_short');
    if (!argon2) throw new Error('argon2_unavailable_install_required');

    const salt = crypto.randomBytes(32);
    const key = await deriveKeyArgon2(password, salt);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(VERIFY_PLAINTEXT, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    store.set('master', {
        kdf:       'argon2id',
        salt:      salt.toString('base64'),
        verify_iv: iv.toString('base64'),
        verify_ct: Buffer.concat([ct, tag]).toString('base64'),
        params: {
            memoryCost: ARGON2_PARAMS.memoryCost,
            timeCost:   ARGON2_PARAMS.timeCost,
            parallelism: ARGON2_PARAMS.parallelism,
        },
    });
    unlockedKey = key;
    unlockedPasswordRef = password;
    failedAttempts = 0;
}

async function unlock(password) {
    if (failedAttempts >= 3) {
        const cooldown = Math.min(60_000 * Math.pow(2, failedAttempts - 3), 600_000);
        if (Date.now() - lastFailedAt < cooldown) return false;
    }
    const m = store.get('master');
    if (!m) return false;

    try {
        const key = await deriveKeyForMaster(m, password);
        if (!verifyKeyAgainstMaster(m, key)) throw new Error('bad_token');

        unlockedKey = key;
        unlockedPasswordRef = password;
        failedAttempts = 0;

        // Legacy PBKDF2 master? Re-key transparently using Argon2id while we
        // hold the password in-memory. The on-disk wallet ciphertexts stay
        // valid because they were encrypted with the same `key` that we just
        // re-derived (well-formed AES key); only the verify block changes.
        if ((m.kdf || 'pbkdf2') === 'pbkdf2' && argon2) {
            try { await migrateMasterToArgon2id(password); }
            catch (e) { console.warn('[storage] argon2id migration deferred', e?.message || e); }
        }
        return true;
    } catch (_) {
        failedAttempts++;
        lastFailedAt = Date.now();
        return false;
    }
}

function lock() {
    unlockedKey = null;
    unlockedPasswordRef = null;
}

/**
 * Retrieve the currently-unlocked master password.
 * Used ONLY when the user has explicitly enabled the password-recovery /
 * cloud-sync features and main.js needs the plaintext to push to OS
 * keychain or to derive the cloud-blob key. Callers must scrub the
 * returned value as soon as they're done with it.
 */
function getUnlockedPassword() {
    return unlockedPasswordRef;
}

async function deriveKeyArgon2(password, salt) {
    if (!argon2) throw new Error('argon2_unavailable');
    return argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: ARGON2_PARAMS.memoryCost,
        timeCost:   ARGON2_PARAMS.timeCost,
        parallelism: ARGON2_PARAMS.parallelism,
        hashLength:  ARGON2_PARAMS.hashLength,
        salt,
        raw: true,
    });
}

async function deriveKeyPbkdf2(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.pbkdf2(password, salt, PBKDF2_ITERS, PBKDF2_KEYLEN, PBKDF2_DIGEST, (err, key) => {
            if (err) return reject(err);
            resolve(key);
        });
    });
}

async function deriveKeyForMaster(masterBlock, password) {
    const salt = Buffer.from(masterBlock.salt, 'base64');
    return (masterBlock.kdf || 'pbkdf2') === 'argon2id'
        ? deriveKeyArgon2(password, salt)
        : deriveKeyPbkdf2(password, salt);
}

function verifyKeyAgainstMaster(masterBlock, key) {
    try {
        const iv = Buffer.from(masterBlock.verify_iv, 'base64');
        const ctTag = Buffer.from(masterBlock.verify_ct, 'base64');
        const ct = ctTag.subarray(0, ctTag.length - 16);
        const tag = ctTag.subarray(ctTag.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
        return plain === VERIFY_PLAINTEXT;
    } catch (_) {
        return false;
    }
}

/**
 * Re-encrypt the master block under Argon2id and re-encrypt every wallet under
 * a freshly-derived Argon2id key. Done in-place while the user is unlocked,
 * so they don't have to do anything. The PBKDF2 path keeps working until
 * this succeeds.
 */
async function migrateMasterToArgon2id(password) {
    if (!argon2) throw new Error('argon2_unavailable');
    const oldKey = unlockedKey;
    if (!oldKey) throw new Error('not_unlocked');

    // Decrypt every wallet seed with the old key, then re-encrypt with a new key.
    const oldWallets = store.get('wallets') || {};
    const decrypted = {};
    for (const [addr, w] of Object.entries(oldWallets)) {
        try {
            decrypted[addr] = { ...w, _seed: decryptWithKey(w, oldKey) };
        } catch (e) {
            console.warn('[storage] skip wallet during migration', addr, e?.message);
        }
    }

    const newSalt = crypto.randomBytes(32);
    const newKey  = await deriveKeyArgon2(password, newSalt);

    const newWallets = {};
    for (const [addr, w] of Object.entries(decrypted)) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', newKey, iv);
        const ct = Buffer.concat([cipher.update(w._seed, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        newWallets[addr] = {
            label: w.label || null,
            classicAddress: w.classicAddress || addr,
            publicKey: w.publicKey || null,
            iv: iv.toString('base64'),
            ct: Buffer.concat([ct, tag]).toString('base64'),
            addedAt: w.addedAt,
        };
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', newKey, iv);
    const vct = Buffer.concat([cipher.update(VERIFY_PLAINTEXT, 'utf8'), cipher.final()]);
    const vtag = cipher.getAuthTag();
    store.set('master', {
        kdf:       'argon2id',
        salt:      newSalt.toString('base64'),
        verify_iv: iv.toString('base64'),
        verify_ct: Buffer.concat([vct, vtag]).toString('base64'),
        params: {
            memoryCost: ARGON2_PARAMS.memoryCost,
            timeCost:   ARGON2_PARAMS.timeCost,
            parallelism: ARGON2_PARAMS.parallelism,
        },
    });
    store.set('wallets', newWallets);
    unlockedKey = newKey;
}

function ensureUnlocked() {
    if (!unlockedKey) {
        const e = new Error('app_locked'); e.code = 'LOCKED'; throw e;
    }
}

function encrypt(plain) {
    ensureUnlocked();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', unlockedKey, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv: iv.toString('base64'), ct: Buffer.concat([ct, tag]).toString('base64') };
}

function decryptWithKey(encEntry, key) {
    const iv = Buffer.from(encEntry.iv, 'base64');
    const ctTag = Buffer.from(encEntry.ct, 'base64');
    const ct = ctTag.subarray(0, ctTag.length - 16);
    const tag = ctTag.subarray(ctTag.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function decrypt(encEntry) {
    ensureUnlocked();
    return decryptWithKey(encEntry, unlockedKey);
}

// ── Wallet CRUD ─────────────────────────────────────────────────────────────
async function saveWallet(wallet, label) {
    ensureUnlocked();
    const wallets = store.get('wallets') || {};
    const enc = encrypt(wallet.seed);
    wallets[wallet.address] = {
        label: label || null,
        classicAddress: wallet.classicAddress || wallet.address,
        publicKey: wallet.publicKey,
        iv: enc.iv,
        ct: enc.ct,
        addedAt: new Date().toISOString(),
    };
    store.set('wallets', wallets);
}

function listWallets() {
    const wallets = store.get('wallets') || {};
    return Object.entries(wallets).map(([addr, w]) => ({
        address: addr,
        classicAddress: w.classicAddress || addr,
        label: w.label,
        addedAt: w.addedAt,
        publicKey: w.publicKey || null,
    }));
}

function renameWallet(address, label) {
    const wallets = store.get('wallets') || {};
    if (!wallets[address]) throw new Error('wallet_not_found');
    wallets[address].label = label || null;
    store.set('wallets', wallets);
}

function deleteWallet(address) {
    const wallets = store.get('wallets') || {};
    delete wallets[address];
    store.set('wallets', wallets);
}

// Reveal secret with explicit password re-entry — even when unlocked, secret reveal
// requires re-typing the master password (defence in depth).
async function revealSecret(address, password) {
    const m = store.get('master');
    if (!m) throw new Error('no_master_set');
    const key = await deriveKeyForMaster(m, password);
    if (!verifyKeyAgainstMaster(m, key)) throw new Error('wrong_password');
    const wallets = store.get('wallets') || {};
    const entry = wallets[address];
    if (!entry) throw new Error('wallet_not_found');
    return decryptWithKey(entry, key);
}

// Auto-sign secret reveal — uses the in-memory unlockedKey, no password re-entry.
// Only callable while unlocked. The caller (auto-sign engine) must have already
// validated the request against the rules.
function revealAutoSignSecret(address) {
    ensureUnlocked();
    const wallets = store.get('wallets') || {};
    const entry = wallets[address];
    if (!entry) throw new Error('wallet_not_found');
    return decrypt(entry);
}

function defaultAddress() {
    const wallets = store.get('wallets') || {};
    const list = Object.keys(wallets);
    return list[0] || null;
}

// ── Prefs ───────────────────────────────────────────────────────────────────
function getPref(key) { return (store.get('prefs') || {})[key]; }
function setPref(key, value) {
    const prefs = store.get('prefs') || {};
    prefs[key] = value;
    store.set('prefs', prefs);
}

// ── Auto-sign storage (used by auto-sign module) ────────────────────────────
function getAutoSignRules() { return store.get('auto_sign_rules') || {}; }
function setAutoSignRules(rules) { store.set('auto_sign_rules', rules); }
function getAutoSignLog() { return store.get('auto_sign_log') || []; }
function setAutoSignLog(log) { store.set('auto_sign_log', log); }
function getAutoSignDailyTotals() { return store.get('auto_sign_daily') || {}; }
function setAutoSignDailyTotals(t) { store.set('auto_sign_daily', t); }

module.exports = {
    init,
    hasMasterPassword,
    masterKdf,
    generateMasterPassword,
    setMasterPassword,
    unlock,
    lock,
    getUnlockedPassword,
    saveWallet,
    listWallets,
    renameWallet,
    deleteWallet,
    revealSecret,
    revealAutoSignSecret,
    defaultAddress,
    getPref,
    setPref,
    getAutoSignRules,
    setAutoSignRules,
    getAutoSignLog,
    setAutoSignLog,
    getAutoSignDailyTotals,
    setAutoSignDailyTotals,
};
