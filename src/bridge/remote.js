// remote.js — optional outbound WebSocket client to the Labs Platform server.
// When configured (URL + token), the wallet maintains a long-lived connection so trades
// initiated from the user's mobile/web session land here even when the desktop browser
// isn't open. Disabled by default.

'use strict';

const WS = require('ws');
const Protocol = require('./protocol');
const Store = require('../wallet/storage');

let ws = null;
let url = null;
let token = null;
let onSignRequestCb = null;
let reconnectTimer = null;
let backoff = 2_000;
let connected = false;

function start({ onSignRequest }) {
    onSignRequestCb = onSignRequest;
    const cfg = Store.getPref('bridge_remote') || {};
    if (cfg.url) { url = cfg.url; token = cfg.token || null; connect(); }
}

function configure({ url: nextUrl, token: nextToken }) {
    Store.setPref('bridge_remote', { url: nextUrl, token: nextToken });
    url = nextUrl; token = nextToken;
    if (ws) { try { ws.close(); } catch (_) {} ws = null; connected = false; }
    if (url) connect();
    return { ok: true, url };
}

function connect() {
    if (!url) return;
    try {
        const headers = token ? { Authorization: 'Bearer ' + token } : undefined;
        ws = new WS(url, { headers });
    } catch (_) { return scheduleReconnect(); }

    ws.on('open', () => {
        connected = true;
        backoff = 2_000;
        // Hello — let server know which wallet is online
        const addr = Store.defaultAddress();
        if (addr) {
            try { ws.send(JSON.stringify(Protocol.buildWalletConnected(addr, {}))); } catch (_) {}
        }
    });

    ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
        if (msg.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {} return; }
        if (msg.type === 'sign_request') {
            Protocol.trackRequest(msg, 'remote', (response) => {
                try { ws.send(JSON.stringify(response)); } catch (_) {}
            });
            if (typeof onSignRequestCb === 'function') onSignRequestCb(msg);
        }
    });

    ws.on('close', () => { connected = false; scheduleReconnect(); });
    ws.on('error', () => { /* swallow — close will fire */ });
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    if (!url) return;
    const wait = Math.min(backoff, 60_000);
    backoff *= 2;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
}

function disconnect() { if (ws) try { ws.close(); } catch (_) {} ws = null; connected = false; }

function status() {
    return { configured: !!url, connected, url: url || null };
}

module.exports = { start, configure, disconnect, status };
