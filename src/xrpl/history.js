// history.js — recent transaction history for an address.

'use strict';

const Conn = require('./connection');

async function fetch(address, limit = 50) {
    if (!address) throw new Error('address_required');
    const c = await Conn.getClient();
    const r = await c.request({
        command: 'account_tx',
        account: address,
        limit: Math.max(1, Math.min(200, Number(limit) || 50)),
        forward: false,
        ledger_index_min: -1,
        ledger_index_max: -1,
    });
    const txs = (r.result?.transactions || []).map((t) => {
        const tx = t.tx || t.tx_json || {};
        const meta = t.meta || {};
        return {
            hash: tx.hash || t.hash,
            type: tx.TransactionType,
            account: tx.Account,
            destination: tx.Destination,
            amount: tx.Amount,
            fee: tx.Fee,
            date: tx.date ? rippleEpochToIso(tx.date) : null,
            ledger: t.ledger_index,
            result: typeof meta === 'object' ? meta.TransactionResult : null,
        };
    });
    return { count: txs.length, txs };
}

// XRPL uses Ripple Epoch (seconds since 2000-01-01).
function rippleEpochToIso(seconds) {
    const RIPPLE_EPOCH = 946684800;
    return new Date((seconds + RIPPLE_EPOCH) * 1000).toISOString();
}

module.exports = { fetch };
