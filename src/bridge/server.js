// server.js — local WebSocket server (loopback only).
// The XRPSync website (running in the user's browser) connects to
// ws://127.0.0.1:17760 to send sign requests. Refuses any non-loopback connection.
//
// Greeting sequence on every browser connection:
//   1. hello                    (synchronous, proves the send path)
//   2. wallet_connected         (synchronous, address + zero balances)
//   3. balance_update           (async, real balances when XRPL responds)
//
// XRPL failures NEVER block the greeting. A wallet with 0 XRP / unfunded account is valid.

'use strict';

const { WebSocketServer } = require('ws');
const Protocol = require('./protocol');

const log  = (...a) => console.log('[bridge]',  ...a);
const warn = (...a) => console.warn('[bridge]', ...a);
const err  = (...a) => console.error('[bridge]', ...a);

// Origin allow-list. Loopback-only is not enough: any page in the user's browser
// can reach 127.0.0.1, and the browser sets the Origin header honestly (JS can't
// forge it on a WebSocket). So we additionally require a recognized Origin —
// otherwise a malicious site could connect and spoof the `source` field to ride
// the user's xrpsync.com auto-sign rules. Override with BRIDGE_ALLOWED_ORIGINS
// (comma-separated). localhost/127.0.0.1 (any scheme/port) is always allowed for dev.
const ALLOWED_ORIGINS = (process.env.BRIDGE_ALLOWED_ORIGINS ||
    'https://xrpsync.com,https://www.xrpsync.com')
    .split(',').map((s) => s.trim()).filter(Boolean);

function originAllowed(origin) {
    if (!origin) return false;                       // browsers always send one; reject blanks
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    try {
        const h = new URL(origin).hostname;
        if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true; // dev
    } catch (_) { /* malformed origin → reject */ }
    return false;
}

let wss = null;
let listening = false;
let onSignRequestCb = null;
let getWalletInfoSyncCb = null;   // () => { address, locked } | null   — must NOT throw, must NOT block
let getBalancesCb = null;         // async (address) => { XRP, RLUSD }  — may throw, may take seconds

function start({ port = 17760, onSignRequest, getWalletInfoSync, getBalances }) {
    if (wss) { log('start: already running'); return; }
    onSignRequestCb = onSignRequest;
    getWalletInfoSyncCb = getWalletInfoSync;
    getBalancesCb = getBalances;
    log('start: opening WSS on 127.0.0.1:' + port +
        ' · sync=' + (typeof getWalletInfoSyncCb) +
        ' · balances=' + (typeof getBalancesCb));
    wss = new WebSocketServer({
        host: '127.0.0.1',
        port,
        verifyClient: (info, done) => {
            const ip = info.req.socket.remoteAddress;
            const ipOk = (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
            const originOk = originAllowed(info.origin);
            log('verifyClient: ip=' + ip + ' ipOk=' + ipOk + ' originOk=' + originOk + ' origin=' + (info.origin || '—'));
            if (ipOk && originOk) return done(true);
            if (ipOk && !originOk) warn('rejected: bad origin ' + (info.origin || '(none)') + ' — set BRIDGE_ALLOWED_ORIGINS if this is legit');
            return done(false, 403, 'Forbidden');
        },
    });
    wss.on('listening', () => { listening = true; log('listening on 127.0.0.1:' + port); });
    wss.on('error', (e) => { listening = false; err('wss error', e?.message || e); });
    wss.on('connection', (ws, req) => {
        log('connection: ip=' + req.socket.remoteAddress + ' total=' + wss.clients.size);
        onConnection(ws);
    });
}

function trySend(ws, payload, label) {
    try {
        const blob = JSON.stringify(payload);
        if (ws.readyState !== ws.OPEN) {
            warn('send: socket not open (' + label + ') readyState=' + ws.readyState);
            return false;
        }
        ws.send(blob);
        log('send: ' + label + ' → ' + blob.slice(0, 220));
        return true;
    } catch (e) {
        err('send failed (' + label + '):', e?.message || e);
        return false;
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Greeting — runs purely synchronously. No await, no XRPL. Always fires.
// ──────────────────────────────────────────────────────────────────────────
function greetSync(ws) {
    let info = null;
    if (typeof getWalletInfoSyncCb === 'function') {
        try { info = getWalletInfoSyncCb(); }
        catch (e) {
            err('getWalletInfoSync threw:', e?.message || e);
            trySend(ws, { type: 'wallet_status', state: 'wallet_info_error', error: String(e?.message || e), timestamp: new Date().toISOString() }, 'wallet_status:wallet_info_error');
            return null;
        }
    } else {
        err('greetSync: getWalletInfoSyncCb is ' + typeof getWalletInfoSyncCb);
        trySend(ws, { type: 'wallet_status', state: 'bridge_misconfigured', timestamp: new Date().toISOString() }, 'wallet_status:bridge_misconfigured');
        return null;
    }

    log('greetSync: info=' + JSON.stringify(info));

    if (!info) {
        trySend(ws, { type: 'wallet_status', state: 'no_wallets', timestamp: new Date().toISOString() }, 'wallet_status:no_wallets');
        return null;
    }
    if (info.locked) {
        trySend(ws, { type: 'wallet_status', state: 'locked', timestamp: new Date().toISOString() }, 'wallet_status:locked');
        return null;
    }
    if (!info.address) {
        trySend(ws, { type: 'wallet_status', state: 'no_address', timestamp: new Date().toISOString() }, 'wallet_status:no_address');
        return null;
    }

    // Greeting fires NOW. Zero balances by default — XRPL failure cannot block this.
    // Includes the XRPSync account tier (if logged in) so the website unlocks
    // premium features on first contact without an extra HTTP round-trip.
    trySend(ws, {
        type: 'wallet_connected',
        address: info.address,
        balances: { XRP: '0', RLUSD: '0' },
        status: 'connected',
        account: info.account || null,
        timestamp: new Date().toISOString(),
    }, 'wallet_connected');

    return info.address;
}

// ──────────────────────────────────────────────────────────────────────────
// Background balance refresh — fire-and-forget. Failure is non-fatal: an
// unfunded XRPL account legitimately returns "actNotFound", which is fine.
// ──────────────────────────────────────────────────────────────────────────
function refreshBalances(ws, address) {
    if (typeof getBalancesCb !== 'function') return;
    if (!address) return;
    Promise.resolve()
        .then(() => getBalancesCb(address))
        .then((balances) => {
            if (!balances) return;
            trySend(ws, {
                type: 'balance_update',
                address,
                balances,
                timestamp: new Date().toISOString(),
            }, 'balance_update');
        })
        .catch((e) => {
            // 0-XRP / unfunded account is normal — don't surface as an error to the browser
            warn('refreshBalances (' + address + ') failed (this is fine for unfunded accounts):', e?.message || e);
        });
}

function onConnection(ws) {
    // Step 1: synchronous hello — proves the send path works regardless of any
    // async hangs further down.
    trySend(ws, {
        type: 'hello',
        bridge: 'labs-wallet',
        version: 1,
        timestamp: new Date().toISOString(),
    }, 'hello');

    // Step 2: synchronous wallet_connected — never blocked by XRPL.
    const address = greetSync(ws);

    // Step 3: async balance refresh (fire-and-forget). Greeting already sent.
    if (address) refreshBalances(ws, address);

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (_) { warn('recv: bad JSON'); return; }
        log('recv: ' + (msg.type || '?') + ' id=' + (msg.id || '—'));

        if (msg.type === 'ping') {
            trySend(ws, { type: 'pong', timestamp: new Date().toISOString() }, 'pong');
            return;
        }
        if (msg.type === 'refresh' || msg.type === 'wallet_status') {
            const addr = greetSync(ws);
            if (addr) refreshBalances(ws, addr);
            return;
        }
        if (msg.type === 'sign_request') {
            Protocol.trackRequest(msg, 'local', (response) => {
                trySend(ws, response, 'sign_response id=' + response.id);
            });
            if (typeof onSignRequestCb === 'function') onSignRequestCb(msg);
            return;
        }
    });

    ws.on('error', (e) => err('socket error', e?.message || e));
    ws.on('close', (code, reason) => log('socket close code=' + code + ' reason=' + (reason?.toString() || '—')));
}

// Re-greet every connected browser. Called from main.js after unlock or wallet add.
function broadcastWalletInfo() {
    if (!wss) return;
    log('broadcastWalletInfo: clients=' + wss.clients.size);
    wss.clients.forEach((ws) => {
        if (ws.readyState !== ws.OPEN) return;
        const addr = greetSync(ws);
        if (addr) refreshBalances(ws, addr);
    });
}

function stop() {
    if (!wss) return;
    log('stop');
    try { wss.close(); } catch (_) {}
    wss = null;
    listening = false;
}

function status() {
    return {
        listening,
        port: 17760,
        connections: wss ? wss.clients.size : 0,
    };
}

module.exports = { start, stop, status, broadcastWalletInfo };
