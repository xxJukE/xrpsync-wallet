// sync.js — opt-in encrypted cloud sync of the wallet store.
//
// The cloud blob is AES-256-GCM ciphertext of:
//   { wallets:[{address,label,seed,addedAt}], rules:{...}, prefs:{...} }
// encrypted with a key derived from the user's master password via Argon2id.
// The server holds only the ciphertext; it cannot read the wallets and cannot
// derive the key without the password, which never leaves this machine.
//
// The blob_version field below is a wire-format version — bump it if the
// envelope changes. The inner payload schema is `payload_v`.

'use strict';

const crypto  = require('crypto');
const os      = require('os');

const BLOB_VERSION    = 1;
const PAYLOAD_VERSION = 1;

let argon2 = null;
try { argon2 = require('@node-rs/argon2'); } catch (_) { /* surfaced when used */ }

const ARGON2 = {
    memoryCost: 65536,
    timeCost:   3,
    parallelism: 4,
    hashLength:  32,
};

async function deriveKey(password, salt) {
    if (!argon2) throw new Error('argon2_unavailable');
    // @node-rs/argon2.hash() returns a PHC string; the final segment is the raw
    // hash. Byte-identical to the prior argon2@0.40.3 `raw: true` output for these
    // params (same params as storage.js — verified by scripts/argon2-compat-test.js).
    const algorithm = (argon2.Algorithm && argon2.Algorithm.Argon2id != null) ? argon2.Algorithm.Argon2id : 2;
    const phc = await argon2.hash(password, {
        algorithm,
        memoryCost:  ARGON2.memoryCost,
        timeCost:    ARGON2.timeCost,
        parallelism: ARGON2.parallelism,
        outputLen:   ARGON2.hashLength,
        salt,
    });
    return Buffer.from(String(phc).split('$').pop(), 'base64');
}

/**
 * Build the encrypted blob ready to ship to the server. Requires the wallet
 * store to be unlocked so we can read raw seeds.
 *
 * @param {object} WalletStore — the storage module instance
 * @param {string} masterPassword — used to derive the cloud-blob key
 * @returns {Promise<{ blob: Buffer, checksum: string, version: number }>}
 */
async function buildBlob(WalletStore, masterPassword) {
    if (!masterPassword) throw new Error('master_password_required');

    const wallets = WalletStore.listWallets().map(w => ({
        address: w.address,
        label:   w.label,
        addedAt: w.addedAt,
        seed:    WalletStore.revealAutoSignSecret(w.address),
    }));

    const inner = JSON.stringify({
        payload_v: PAYLOAD_VERSION,
        created_at: new Date().toISOString(),
        device: { platform: process.platform, host: safeHost() },
        wallets,
        rules: WalletStore.getAutoSignRules(),
        prefs: {
            lock_ms: WalletStore.getPref('lock_ms'),
        },
    });

    const salt = crypto.randomBytes(32);
    const key  = await deriveKey(masterPassword, salt);
    const iv   = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(inner, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Outer envelope, JSON-encoded then UTF-8 bytes — the server treats the
    // whole thing as opaque so this is purely for our own decoder.
    const envelope = Buffer.from(JSON.stringify({
        v:    BLOB_VERSION,
        kdf:  'argon2id',
        params: ARGON2,
        salt: salt.toString('base64'),
        iv:   iv.toString('base64'),
        ct:   Buffer.concat([ct, tag]).toString('base64'),
    }), 'utf8');

    return {
        blob: envelope,
        checksum: crypto.createHash('sha256').update(envelope).digest('hex'),
        version: BLOB_VERSION,
    };
}

/**
 * Decode a blob previously produced by buildBlob(). Returns the inner payload
 * (wallets, rules, prefs). Throws on wrong password / tampered blob.
 */
async function decodeBlob(blobBuffer, masterPassword) {
    if (!masterPassword) throw new Error('master_password_required');
    let env;
    try { env = JSON.parse(blobBuffer.toString('utf8')); }
    catch (_) { throw new Error('blob_unparseable'); }

    if (env.v !== BLOB_VERSION) throw new Error('unsupported_blob_version');
    if (env.kdf !== 'argon2id') throw new Error('unsupported_kdf');

    const salt = Buffer.from(env.salt, 'base64');
    const iv   = Buffer.from(env.iv, 'base64');
    const ctTag = Buffer.from(env.ct, 'base64');
    const ct = ctTag.subarray(0, ctTag.length - 16);
    const tag = ctTag.subarray(ctTag.length - 16);

    const key = await deriveKey(masterPassword, salt);
    let plain;
    try {
        const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
        dec.setAuthTag(tag);
        plain = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
    } catch (_) {
        throw new Error('wrong_password_or_tampered');
    }
    return JSON.parse(plain);
}

function safeHost() {
    try { return os.hostname().slice(0, 40); } catch (_) { return null; }
}

// ── HTTP client around the server endpoints ────────────────────────────────
async function uploadBlob({ baseUrl, token, blob, version, checksum, deviceLabel }) {
    const url = baseUrl.replace(/\/$/, '') + '/api/wallet/sync-upload';
    const body = JSON.stringify({
        encrypted_blob: blob.toString('base64'),
        version,
        checksum,
        device_label: deviceLabel || safeHost(),
    });
    return jsonRequest('POST', url, token, body);
}

async function downloadBlob({ baseUrl, token }) {
    const url = baseUrl.replace(/\/$/, '') + '/api/wallet/sync-download';
    return jsonRequest('GET', url, token);
}

async function statusRequest({ baseUrl, token }) {
    const url = baseUrl.replace(/\/$/, '') + '/api/wallet/sync-status';
    return jsonRequest('GET', url, token);
}

async function deleteBackup({ baseUrl, token }) {
    const url = baseUrl.replace(/\/$/, '') + '/api/wallet/sync';
    return jsonRequest('DELETE', url, token);
}

function jsonRequest(method, url, token, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const isHttps = u.protocol === 'https:';
        const lib = isHttps ? require('https') : require('http');
        const req = lib.request({
            method,
            hostname: u.hostname,
            port:     u.port || (isHttps ? 443 : 80),
            path:     u.pathname + u.search,
            headers: {
                'Authorization': 'Bearer ' + token,
                'Accept':        'application/json',
                ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
            },
            timeout: 30_000,
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed = null;
                try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
                resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: parsed, raw: text });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('request_timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

module.exports = {
    BLOB_VERSION,
    buildBlob,
    decodeBlob,
    uploadBlob,
    downloadBlob,
    statusRequest,
    deleteBackup,
};
