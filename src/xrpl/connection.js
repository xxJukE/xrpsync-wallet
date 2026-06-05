// connection.js — singleton XRPL WebSocket client.
// Default endpoint is xrplcluster.com (load-balanced public mainnet).
// Falls back to s1.ripple.com on connect failure. Reconnects with exponential backoff.

'use strict';

const xrpl = require('xrpl');

// Network is switchable so the Treasury → Create Token wizard can rehearse the
// whole irreversible flow on testnet (free faucet XRP) before doing it for real.
const NETWORKS = {
    mainnet: ['wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com'],
    testnet: ['wss://s.altnet.rippletest.net:51233'],
};
let network = 'mainnet';
let ENDPOINTS = NETWORKS.mainnet;

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

// Switch the active network (mainnet|testnet) and force a reconnect to it.
// Used by the token-creation wizard's testnet rehearsal toggle.
async function setNetwork(net) {
    if (!NETWORKS[net]) throw new Error('unknown_network: ' + net);
    if (net === network) return network;
    network = net;
    ENDPOINTS = NETWORKS[net];
    endpointIdx = 0;
    await disconnect();   // next getClient() connects to the new network
    return network;
}

function getNetwork() { return network; }

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

module.exports = { getClient, disconnect, autofill, serverInfo, request, setNetwork, getNetwork };
