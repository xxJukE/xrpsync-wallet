// connection.js — singleton XRPL WebSocket client.
// Default endpoint is xrplcluster.com (load-balanced public mainnet).
// Falls back to s1.ripple.com on connect failure. Reconnects with exponential backoff.

'use strict';

const xrpl = require('xrpl');

const ENDPOINTS = [
    'wss://xrplcluster.com',
    'wss://s1.ripple.com',
    'wss://s2.ripple.com',
];

let client = null;
let connecting = null;
let endpointIdx = 0;
let backoffMs = 1_000;

async function getClient() {
    if (client && client.isConnected()) return client;
    if (connecting) return connecting;
    connecting = (async () => {
        const url = ENDPOINTS[endpointIdx];
        const c = new xrpl.Client(url);
        try {
            await c.connect();
            client = c;
            backoffMs = 1_000;
            client.on('disconnected', () => {
                client = null;
            });
            return client;
        } catch (err) {
            endpointIdx = (endpointIdx + 1) % ENDPOINTS.length;
            const wait = Math.min(backoffMs, 30_000);
            backoffMs *= 2;
            await new Promise(r => setTimeout(r, wait));
            connecting = null;
            return getClient();
        } finally {
            connecting = null;
        }
    })();
    return connecting;
}

async function disconnect() {
    if (client) { try { await client.disconnect(); } catch (_) {} client = null; }
}

async function autofill(transaction) {
    const c = await getClient();
    return c.autofill(transaction);
}

async function serverInfo() {
    const c = await getClient();
    const r = await c.request({ command: 'server_info' });
    return r.result?.info || null;
}

async function request(req) {
    const c = await getClient();
    return c.request(req);
}

module.exports = { getClient, disconnect, autofill, serverInfo, request };
