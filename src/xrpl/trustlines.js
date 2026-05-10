// trustlines.js — list trustlines for an address.
// Building TrustSet transactions is the caller's job (from the UI), and signing happens
// via wallet/sign.js. This module is read-only.

'use strict';

const Conn = require('./connection');

async function fetch(address) {
    if (!address) throw new Error('address_required');
    const c = await Conn.getClient();
    const r = await c.request({
        command: 'account_lines',
        account: address,
        ledger_index: 'validated',
    });
    return (r.result?.lines || []).map((l) => ({
        currency: l.currency,
        issuer: l.account,
        balance: l.balance,
        limit: l.limit,
        no_ripple: !!l.no_ripple,
        authorized: !!l.authorized,
        freeze: !!l.freeze,
    }));
}

module.exports = { fetch };
