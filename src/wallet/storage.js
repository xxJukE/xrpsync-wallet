// storage.js — encrypted-at-rest wallet store.
//
// Layout in electron-store (`labs-wallet-data.json`):
//   master:  { salt, verify_iv, verify_ct }   ← used to verify the password without storing it
//   wallets: { [address]: { label, classicAddress, iv, ct, addedAt } }
//   prefs:   { lock_ms, allow_auto_sign_unattended, ... }
//
// Encryption: AES-256-GCM. Key derived via PBKDF2 (SHA-512, 200k iterations) from the user's
// master password + a per-install salt. The derived key is held in memory only while unlocked.

'use strict';

const crypto = require('crypto');
const Store  = require('electron-store');

const PBKDF2_ITERS = 200_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha512';

let store = null;
let unlockedKey = null; // Buffer (32 bytes) when unlocked
let failedAttempts = 0;
let lastFailedAt = 0;

function init({ name }) {
    store = new Store({ name: name || 'labs-wallet-data' });
    if (!store.has('master')) {
        // Fresh install — caller will create master via setMasterPassword().
    }
    if (!store.has('wallets')) store.set('wallets', {});
    if (!store.has('prefs')) store.set('prefs', {});
}

function hasMasterPassword() { return !!store?.get('master'); }

async function setMasterPassword(password) {
    if (!password || password.length < 8) throw new Error('password_too_short');
    const salt = crypto.randomBytes(32);
    const key = await deriveKey(password, salt);
    // Verify token: encrypt a known plaintext so we can verify password later
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update('labs-wallet-verify', 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    store.set('master', {
        salt: salt.toString('base64'),
        verify_iv: iv.toString('base64'),
        verify_ct: Buffer.concat([ct, tag]).toString('base64'),
    });
    unlockedKey = key;
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
        const salt = Buffer.from(m.salt, 'base64');
        const key = await deriveKey(password, salt);
        const iv = Buffer.from(m.verify_iv, 'base64');
        const ctTag = Buffer.from(m.verify_ct, 'base64');
        const ct = ctTag.subarray(0, ctTag.length - 16);
        const tag = ctTag.subarray(ctTag.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
        if (plain !== 'labs-wallet-verify') throw new Error('bad_token');
        unlockedKey = key;
        failedAttempts = 0;
        return true;
    } catch (_) {
        failedAttempts++;
        lastFailedAt = Date.now();
        return false;
    }
}

function lock() { unlockedKey = null; }

async function deriveKey(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.pbkdf2(password, salt, PBKDF2_ITERS, PBKDF2_KEYLEN, PBKDF2_DIGEST, (err, key) => {
            if (err) return reject(err);
            resolve(key);
        });
    });
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
    const salt = Buffer.from(m.salt, 'base64');
    const key = await deriveKey(password, salt);
    // Verify the freshly derived key matches by trying a decrypt against the verify token
    try {
        const iv = Buffer.from(m.verify_iv, 'base64');
        const ctTag = Buffer.from(m.verify_ct, 'base64');
        decryptWithKey({ iv: iv.toString('base64'), ct: ctTag.toString('base64') }, key);
    } catch (_) {
        throw new Error('wrong_password');
    }
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
    setMasterPassword,
    unlock,
    lock,
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
