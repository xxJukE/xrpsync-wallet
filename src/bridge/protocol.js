// protocol.js — message format for the website ↔ wallet bridge.
//
// Inbound (website → wallet):
//   { type: 'sign_request', id, source, transaction, description, timestamp, urgency }
//   { type: 'ping' }
//
// Outbound (wallet → website):
//   { type: 'sign_response', id, status: 'approved'|'rejected', signed_blob?, tx_hash?, address?, reason? }
//   { type: 'wallet_connected', address, balances }
//   { type: 'pong' }
//
// validateSignRequest is intentionally strict — anything malformed is rejected at the door.

'use strict';

const { v4: uuid } = require('uuid');

// Pending requests keyed by id, so onApproval can reply on the right socket.
const pending = new Map();

function trackRequest(req, source, replyFn) {
    pending.set(req.id, { req, source, replyFn, ts: Date.now() });
    // Auto-expire after 5 minutes
    setTimeout(() => pending.delete(req.id), 5 * 60 * 1000);
}

function validateSignRequest(req) {
    if (!req || typeof req !== 'object') return { ok: false, reason: 'not_object' };
    if (req.type !== 'sign_request') return { ok: false, reason: 'wrong_type' };
    if (typeof req.id !== 'string' || !req.id) return { ok: false, reason: 'missing_id' };
    if (typeof req.source !== 'string') return { ok: false, reason: 'missing_source' };
    if (!req.transaction || typeof req.transaction !== 'object') return { ok: false, reason: 'missing_tx' };
    if (typeof req.transaction.TransactionType !== 'string') return { ok: false, reason: 'missing_tx_type' };
    if (typeof req.transaction.Account !== 'string') return { ok: false, reason: 'missing_account' };
    return { ok: true };
}

// Sent immediately on websocket connect — lets the website know which wallet is connected.
function buildWalletConnected(address, balances) {
    return {
        type: 'wallet_connected',
        timestamp: new Date().toISOString(),
        address,
        balances: balances || {},
    };
}

function buildResponse(reqId, fields) {
    return {
        type: 'sign_response',
        id: reqId,
        timestamp: new Date().toISOString(),
        ...fields,
    };
}

// Send a response to the website that originated `req`. `source` is 'local' or 'remote'.
function sendResponse(req, source, payload) {
    const entry = pending.get(req.id);
    if (entry && typeof entry.replyFn === 'function') {
        try { entry.replyFn(buildResponse(req.id, payload)); } catch (_) {}
        pending.delete(req.id);
    }
}

// User clicked Approve / Reject in the approval window.
async function handleApproval({ id, approved, password, address, sign, store, xrpl }) {
    const entry = pending.get(id);
    if (!entry) return;
    const { req, source } = entry;

    if (!approved) {
        sendResponse(req, source, { status: 'rejected', reason: 'user_rejected' });
        return;
    }

    try {
        const targetAddress = address || req.transaction.Account;
        const seed = await store.revealSecret(targetAddress, password);
        const prepared = await xrpl.autofill(req.transaction);
        const signed = sign.sign(seed, prepared);
        sendResponse(req, source, {
            status: 'approved',
            signed_blob: signed.tx_blob,
            tx_hash: signed.hash,
            address: targetAddress,
            auto: false,
        });
    } catch (err) {
        sendResponse(req, source, { status: 'rejected', reason: 'sign_failed:' + (err.message || err.code || 'unknown') });
    }
}

function newId() { return 'req_' + uuid().replace(/-/g, ''); }

module.exports = {
    trackRequest,
    validateSignRequest,
    buildResponse,
    buildWalletConnected,
    sendResponse,
    handleApproval,
    newId,
    pending,
};
