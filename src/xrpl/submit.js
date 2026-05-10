// submit.js — submit a signed transaction blob to the XRPL.
// Returns the engine result + tx hash. Caller decides whether to wait for validation.

'use strict';

const Conn = require('./connection');

async function submitSignedBlob(tx_blob, opts = {}) {
    if (!tx_blob) throw new Error('tx_blob_required');
    const c = await Conn.getClient();
    const r = await c.submit(tx_blob, { wallet: undefined, autofill: false });
    return {
        engine_result: r?.result?.engine_result,
        engine_result_message: r?.result?.engine_result_message,
        tx_hash: r?.result?.tx_json?.hash || null,
        accepted: r?.result?.accepted ?? null,
        applied: r?.result?.applied ?? null,
    };
}

// Submit and wait for ledger validation (used for high-stakes payments).
async function submitAndWait(tx_blob) {
    if (!tx_blob) throw new Error('tx_blob_required');
    const c = await Conn.getClient();
    const r = await c.submitAndWait(tx_blob);
    return {
        validated: r?.result?.validated,
        engine_result: r?.result?.meta?.TransactionResult,
        tx_hash: r?.result?.hash,
        ledger_index: r?.result?.ledger_index,
    };
}

module.exports = { submitSignedBlob, submitAndWait };
