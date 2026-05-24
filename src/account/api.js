// account/api.js — thin HTTP client for the XRPSync wallet endpoints.
// All HTTP happens in the Electron main process. The renderer only goes through IPC.
//
// Token lifecycle is owned by ./session.js. This file just makes the calls.

'use strict';

const https = require('https');
const http  = require('http');
const { URL } = require('url');

const DEFAULT_BASE = process.env.LABS_API_BASE || 'https://xrpsync.com';

function request(method, path, { token = null, body = null, base = DEFAULT_BASE, timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(path.startsWith('http') ? path : (base.replace(/\/$/, '') + path));
        const lib = u.protocol === 'https:' ? https : http;
        const headers = {
            'Accept': 'application/json',
            'User-Agent': 'LabsWallet/1.0',
        };
        if (token) headers['Authorization'] = 'Bearer ' + token;
        let payload = null;
        if (body !== null && body !== undefined) {
            payload = JSON.stringify(body);
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = lib.request({
            method,
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + (u.search || ''),
            headers,
        }, (res) => {
            let chunks = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { chunks += c; });
            res.on('end', () => {
                let json = null;
                try { json = chunks ? JSON.parse(chunks) : {}; }
                catch (_) { json = { raw: chunks }; }
                resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: json });
            });
        });
        req.setTimeout(timeoutMs, () => { req.destroy(new Error('request timeout after ' + timeoutMs + 'ms')); });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

module.exports = {
    login(email, password, { walletAddress = null, label = null } = {}) {
        return request('POST', '/api/wallet/login', { body: { email, password, wallet_address: walletAddress, label } });
    },
    logout(token) {
        return request('POST', '/api/wallet/logout', { token });
    },
    me(token) {
        return request('GET', '/api/wallet/me', { token });
    },
    subscription(token) {
        return request('GET', '/api/wallet/subscription', { token });
    },
    subscribe(token, tierSlug) {
        return request('POST', '/api/wallet/subscribe', { token, body: { tier_slug: tierSlug } });
    },
    verifyPayment(token, { tx_hash = null, signed_blob = null, payment_id = null }) {
        const body = {};
        if (tx_hash)    body.tx_hash    = tx_hash;
        if (signed_blob) body.signed_blob = signed_blob;
        if (payment_id) body.payment_id = payment_id;
        return request('POST', '/api/wallet/verify-payment', { token, body });
    },
    linkAddress(token, address, { switchExisting = false } = {}) {
        return request('POST', '/api/wallet/link-address', { token, body: { address, switch: switchExisting } });
    },
};
