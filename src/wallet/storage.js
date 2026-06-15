// storage.js — encrypted-at-rest wallet store.
//
// Layout in electron-store (`labs-wallet-data.json`):
//   master:  { kdf, salt, verify_iv, verify_ct, params? }
//             kdf = 'argon2id' (v2, current) | 'pbkdf2' (v1, legacy — auto-migrated)
//   wallets: { [address]: { label, classicAddress, iv, ct, addedAt,
//              desktopOnly?, pairing?: { regularKeyAddress, pairedAt } } }
//              desktopOnly  — never offered to the phone-pairing wizard
//              pairing      — phone regular-key PUBLIC address only, no secrets
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
try { argon2 = require('@node-rs/argon2'); }
catch (_) { /* Surface a clear error the first time it's actually needed. */ }

const PBKDF2_ITERS    = 200_000;
const PBKDF2_KEYLEN   = 32;
const PBKDF2_DIGEST   = 'sha512';
const VERIFY_PLAINTEXT = 'labs-wallet-verify';

// Argon2id parameters. Targets ~100ms on a modern laptop; raises the cost of a
// stolen `labs-wallet-data.json` from "a few GPU hours" to "infeasible without
// the actual password." @node-rs/argon2 returns a PHC string; deriveKeyArgon2
// extracts the raw 32-byte hash — byte-identical to the prior argon2@0.40.3
// `raw: true` output for these params (verified by scripts/argon2-compat-test.js).
const ARGON2_PARAMS = {
    memoryCost: 65536,    // 64 MB
    timeCost: 3,
    parallelism: 4,
    hashLength: 32,
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
        if (Date.now() - lastFailedAt < cooldown) return { ok: false, error: 'cooldown' };
    }
    const m = store.get('master');
    if (!m) return { ok: false, error: 'no_master' };

    // Derive the key. A THROW here is an engine fault (e.g. the argon2 native
    // module failed to load) — NOT a wrong password. A wrong password still
    // derives a (wrong) key and only fails the verify step below. So we must
    // not count a derivation throw against the user or trip the cooldown —
    // otherwise a broken build silently locks people out of valid wallets.
    let key;
    try {
        key = await deriveKeyForMaster(m, password);
    } catch (e) {
        console.error('[storage] KDF engine unavailable on unlock:', e?.message || e);
        return { ok: false, error: 'engine_unavailable' };
    }

    if (!verifyKeyAgainstMaster(m, key)) {
        // Genuine wrong password — penalize and apply the cooldown as before.
        failedAttempts++;
        lastFailedAt = Date.now();
        return { ok: false, error: 'bad_password' };
    }

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
    return { ok: true };
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
    // @node-rs/argon2.hash() returns a PHC string:
    //   $argon2id$v=19$m=65536,t=3,p=4$<saltB64>$<hashB64>
    // The final segment is the raw hash; base64-decode it to the 32-byte AES key.
    // version omitted ⇒ default 0x13 (19), matching argon2@0.40.3. Byte-identical
    // to the prior `raw: true` derivation (proven in scripts/argon2-compat-test.js).
    const algorithm = (argon2.Algorithm && argon2.Algorithm.Argon2id != null) ? argon2.Algorithm.Argon2id : 2;
    const phc = await argon2.hash(password, {
        algorithm,
        memoryCost:  ARGON2_PARAMS.memoryCost,
        timeCost:    ARGON2_PARAMS.timeCost,
        parallelism: ARGON2_PARAMS.parallelism,
        outputLen:   ARGON2_PARAMS.hashLength,
        salt,
    });
    return Buffer.from(String(phc).split('$').pop(), 'base64');
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
            // Non-secret metadata must survive the re-key.
            desktopOnly: !!w.desktopOnly,
            pairing: w.pairing || null,
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
        desktopOnly: !!w.desktopOnly,
        // Phone-pairing state. NEVER holds key material — only the regular
        // key's public ADDRESS and a timestamp. Regular-key seeds exist on
        // desktop solely in memory during the pairing wizard.
        pairing: w.pairing ? { regularKeyAddress: w.pairing.regularKeyAddress, pairedAt: w.pairing.pairedAt } : null,
    }));
}

// ── Phone pairing metadata (no secrets) ─────────────────────────────────────
function setDesktopOnly(address, flag) {
    const wallets = store.get('wallets') || {};
    if (!wallets[address]) throw new Error('wallet_not_found');
    wallets[address].desktopOnly = !!flag;
    store.set('wallets', wallets);
}

function setPairing(address, { regularKeyAddress, pairedAt }) {
    if (!regularKeyAddress) throw new Error('regular_key_address_required');
    const wallets = store.get('wallets') || {};
    if (!wallets[address]) throw new Error('wallet_not_found');
    wallets[address].pairing = { regularKeyAddress, pairedAt: pairedAt || new Date().toISOString() };
    store.set('wallets', wallets);
}

function clearPairing(address) {
    const wallets = store.get('wallets') || {};
    if (!wallets[address]) throw new Error('wallet_not_found');
    wallets[address].pairing = null;
    store.set('wallets', wallets);
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

// ── Address book (saved external destinations) ──────────────────────────────
// Non-secret: only public classic addresses + an optional destination tag and a
// user label. Stored in cleartext alongside prefs — there is nothing here that
// isn't already public on-ledger. Each entry: { id, label, address, tag, addedAt }.
// `tag` is a non-negative integer or null. Exchanges (Kalshi/Zerohash, etc.) hand
// out a pooled deposit address + a per-user destination tag; saving both together
// means the user never has to re-paste the `r…?dt=…` string by hand.
function listAddressBook() {
    return store.get('address_book') || [];
}

function addAddressBookEntry({ label, address, tag } = {}) {
    if (!address || typeof address !== 'string' || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address.trim())) {
        throw new Error('invalid_address');
    }
    const cleanTag = (tag === null || tag === undefined || tag === '') ? null : Number(tag);
    if (cleanTag !== null && (!Number.isInteger(cleanTag) || cleanTag < 0 || cleanTag > 4294967295)) {
        throw new Error('invalid_tag');
    }
    const book = listAddressBook();
    const entry = {
        id: crypto.randomUUID(),
        label: (label && String(label).trim()) || shortLabel(address.trim()),
        address: address.trim(),
        tag: cleanTag,
        addedAt: new Date().toISOString(),
    };
    book.push(entry);
    store.set('address_book', book);
    return entry;
}

function removeAddressBookEntry(id) {
    const book = listAddressBook().filter((e) => e.id !== id);
    store.set('address_book', book);
    return book;
}

function shortLabel(a) { return a.slice(0, 6) + '…' + a.slice(-4); }

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
    setDesktopOnly,
    setPairing,
    clearPairing,
    revealSecret,
    revealAutoSignSecret,
    defaultAddress,
    getPref,
    setPref,
    listAddressBook,
    addAddressBookEntry,
    removeAddressBookEntry,
    getAutoSignRules,
    setAutoSignRules,
    getAutoSignLog,
    setAutoSignLog,
    getAutoSignDailyTotals,
    setAutoSignDailyTotals,
};
