// account/session.js — persistent XRPSync account session for the desktop wallet.
//
// Stores the bearer token (encrypted by Electron safeStorage when available,
// fallback to plain electron-store with a clear marker) plus the last-known
// user payload. Tokens are long-lived (30 days server-side); we always call
// /api/wallet/me on boot to confirm the token still works before trusting
// the cached user payload.

'use strict';

const Store = require('electron-store');
const { safeStorage } = require('electron');

let store = null;
let cached = { token: null, user: null }; // hot copy for fast getters

const KEY_TOKEN_ENC  = 'labs_account_token_enc';     // base64 of safeStorage ciphertext
const KEY_TOKEN_PLAIN = 'labs_account_token_plain';  // fallback when safeStorage missing
const KEY_USER       = 'labs_account_user';

function init() {
    if (store) return;
    store = new Store({ name: 'labs-account' });
    // Warm the cache so getToken()/getUser() don't need to hit disk every call.
    cached.token = _readToken();
    cached.user  = store.get(KEY_USER, null);
}

function _readToken() {
    if (!store) return null;
    try {
        if (safeStorage && safeStorage.isEncryptionAvailable()) {
            const enc = store.get(KEY_TOKEN_ENC, null);
            if (!enc) return null;
            const buf = Buffer.from(enc, 'base64');
            return safeStorage.decryptString(buf);
        }
    } catch (_) {
        // Fall through to plain-store fallback.
    }
    return store.get(KEY_TOKEN_PLAIN, null);
}

function setSession(token, user) {
    init();
    if (token) {
        let stored = false;
        try {
            if (safeStorage && safeStorage.isEncryptionAvailable()) {
                const buf = safeStorage.encryptString(token);
                store.set(KEY_TOKEN_ENC, buf.toString('base64'));
                store.delete(KEY_TOKEN_PLAIN);
                stored = true;
            }
        } catch (_) { /* fall through */ }
        if (!stored) {
            // safeStorage not available on this OS — store plaintext and mark it.
            store.set(KEY_TOKEN_PLAIN, token);
            store.delete(KEY_TOKEN_ENC);
        }
    }
    if (user) store.set(KEY_USER, user);
    cached.token = token ?? cached.token;
    cached.user  = user  ?? cached.user;
}

function clear() {
    init();
    store.delete(KEY_TOKEN_ENC);
    store.delete(KEY_TOKEN_PLAIN);
    store.delete(KEY_USER);
    cached.token = null;
    cached.user  = null;
}

function getToken() { init(); return cached.token; }
function getUser()  { init(); return cached.user; }
function isLoggedIn() { return !!getToken(); }

module.exports = {
    init,
    setSession,
    clear,
    getToken,
    getUser,
    isLoggedIn,
};
