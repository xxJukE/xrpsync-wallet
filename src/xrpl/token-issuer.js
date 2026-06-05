// token-issuer.js — Treasury → Create Token orchestration.
//
// Fixed-supply, two-account, blackholed model:
//   • a fresh throwaway ISSUER (gets blackholed at the end), and
//   • a DISTRIBUTOR (the user's chosen Treasury wallet) that receives + holds
//     the entire supply.
//
// These are discrete, individually-signed steps (NOT one atomic call) so the
// wizard can pause to verify before the one-way blackhole. Each function mirrors
// the trustset.js pattern: take an already-unlocked xrpl.js Wallet, autofill via
// the shared Conn client, sign locally, submitAndWait, return {ok, tx_hash, ...}.
//
// Issuer-signed steps: flags, domain, payment (issue), blackhole.
// Distributor-signed step: the TrustSet (see ./trustset.js — reuse it).

'use strict';

const xrpl = require('xrpl');
const Conn = require('./connection');

// ACCOUNT_ZERO — a real, valid r-address whose private key is unknowable. Setting
// it as the RegularKey and then disabling the master key permanently removes any
// ability to sign for the issuer = the standard XRPL "blackhole" (locks supply).
const BLACKHOLE_ADDRESS = 'rrrrrrrrrrrrrrrrrrrrBZbvji';

// Ledger flags (lsf*) on account_data.Flags.
const LSF = { DefaultRipple: 0x00800000, NoFreeze: 0x00400000, DisableMaster: 0x00100000 };

// 3-char ISO code as-is, 40-char hex as-is, otherwise ASCII → 40-char hex.
function normalizeCurrency(currency) {
    const c = String(currency || '').trim();
    if (/^[0-9A-Fa-f]{40}$/.test(c)) return c.toUpperCase();
    if (c.length === 3) return c;
    if (c.length >= 1 && c.length <= 20 && /^[\x20-\x7E]+$/.test(c)) {
        return Buffer.from(c, 'ascii').toString('hex').toUpperCase().padEnd(40, '0');
    }
    return null;
}

function isAddr(a) { return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(String(a || '')); }

// Sign an already-built tx with the given unlocked wallet and wait for validation.
async function signAndWait(wallet, tx) {
    if (!wallet || typeof wallet.sign !== 'function' || !wallet.address) {
        return { ok: false, error: 'unlocked_wallet_required' };
    }
    try {
        const client = await Conn.getClient();
        const prepared = await client.autofill(tx);
        const signed = wallet.sign(prepared);
        const res = await client.submitAndWait(signed.tx_blob);
        const engine = res?.result?.meta?.TransactionResult || res?.result?.engine_result || null;
        const txHash = res?.result?.hash || signed.hash || null;
        if (engine === 'tesSUCCESS') return { ok: true, tx_hash: txHash, engine_result: engine };
        return { ok: false, error: engine || 'submit_failed', tx_hash: txHash };
    } catch (e) {
        return { ok: false, error: (e && (e.message || String(e))) || 'tx_failed' };
    }
}

// Read account state: existence (funded), XRP balance, and the flags the wizard
// cares about. Returns { exists:false } if the account isn't funded yet.
async function accountState(address) {
    if (!isAddr(address)) return { ok: false, error: 'invalid_address' };
    try {
        const client = await Conn.getClient();
        const r = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' });
        const d = r?.result?.account_data;
        if (!d) return { ok: true, exists: false };
        const flags = Number(d.Flags || 0);
        return {
            ok: true,
            exists: true,
            balance_xrp: Number(xrpl.dropsToXrp(d.Balance || '0')),
            owner_count: Number(d.OwnerCount || 0),
            flags,
            defaultRipple: !!(flags & LSF.DefaultRipple),
            noFreeze: !!(flags & LSF.NoFreeze),
            disableMaster: !!(flags & LSF.DisableMaster),
            domain: d.Domain ? Buffer.from(d.Domain, 'hex').toString('ascii') : null,
        };
    } catch (e) {
        const msg = (e && (e.message || String(e))) || '';
        if (/actNotFound/i.test(msg)) return { ok: true, exists: false };
        return { ok: false, error: msg || 'account_info_failed' };
    }
}

// AccountSet SetFlag. flagName ∈ DefaultRipple | NoFreeze | DisableMaster.
async function setAccountFlag(issuerWallet, flagName) {
    const ASF = {
        DefaultRipple: xrpl.AccountSetAsfFlags.asfDefaultRipple,
        NoFreeze:      xrpl.AccountSetAsfFlags.asfNoFreeze,
        DisableMaster: xrpl.AccountSetAsfFlags.asfDisableMaster,
    };
    const flag = ASF[flagName];
    if (flag === undefined) return { ok: false, error: 'unknown_flag: ' + flagName };
    return signAndWait(issuerWallet, {
        TransactionType: 'AccountSet', Account: issuerWallet.address, SetFlag: flag,
    });
}

// Set the issuer Domain (for xrp-ledger.toml verification). Stored hex-encoded.
async function setDomain(issuerWallet, domain) {
    const d = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '');
    if (!d) return { ok: false, error: 'empty_domain' };
    const hex = Buffer.from(d, 'ascii').toString('hex').toUpperCase();
    return signAndWait(issuerWallet, {
        TransactionType: 'AccountSet', Account: issuerWallet.address, Domain: hex,
    });
}

// Issue the supply: a Payment of the IOU from issuer → distributor. The
// distributor MUST already have a TrustSet with limit ≥ value (do that first
// with the distributor wallet via trustset.js).
async function issueSupply(issuerWallet, distributorAddress, currency, value) {
    const cur = normalizeCurrency(currency);
    if (!cur) return { ok: false, error: 'invalid_currency' };
    if (!isAddr(distributorAddress)) return { ok: false, error: 'invalid_distributor' };
    const v = String(value ?? '').trim();
    if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) return { ok: false, error: 'invalid_supply' };
    return signAndWait(issuerWallet, {
        TransactionType: 'Payment',
        Account: issuerWallet.address,
        Destination: distributorAddress,
        Amount: { currency: cur, issuer: issuerWallet.address, value: v },
    });
}

// Blackhole the issuer — TWO transactions, IRREVERSIBLE. After this no key can
// ever sign for the issuer, so the supply can never be inflated.
//   1) SetRegularKey → ACCOUNT_ZERO
//   2) AccountSet DisableMaster
async function blackhole(issuerWallet) {
    const r1 = await signAndWait(issuerWallet, {
        TransactionType: 'SetRegularKey', Account: issuerWallet.address, RegularKey: BLACKHOLE_ADDRESS,
    });
    if (!r1.ok) return { ok: false, step: 'set_regular_key', error: r1.error };

    const r2 = await setAccountFlag(issuerWallet, 'DisableMaster');
    if (!r2.ok) return { ok: false, step: 'disable_master', error: r2.error, set_regular_key: r1.tx_hash };

    return { ok: true, set_regular_key: r1.tx_hash, disable_master: r2.tx_hash };
}

// Fund a wallet from the TESTNET faucet (rehearsal only — no-op on mainnet).
async function faucetFund(wallet) {
    if (Conn.getNetwork && Conn.getNetwork() !== 'testnet') {
        return { ok: false, error: 'faucet_testnet_only' };
    }
    try {
        const client = await Conn.getClient();
        const r = await client.fundWallet(wallet);
        return { ok: true, balance_xrp: Number(r?.balance ?? 0), address: wallet.address };
    } catch (e) {
        return { ok: false, error: (e && (e.message || String(e))) || 'faucet_failed' };
    }
}

// Generate the xrp-ledger.toml content for the issuer (hosted at the Domain to
// earn the verified badge). The user hosts this at:
//   https://<domain>/.well-known/xrp-ledger.toml
function buildToml({ issuer, currencyCode, name = '', desc = '', domain = '', weblinks = [] } = {}) {
    const cur = normalizeCurrency(currencyCode) || currencyCode;
    const safe = (s) => String(s || '').replace(/"/g, '\\"');
    const lines = [
        '# xrp-ledger.toml — generated by XRPSync Wallet',
        `# Host at: https://${String(domain).replace(/^https?:\/\//, '')}/.well-known/xrp-ledger.toml`,
        '',
        '[[ISSUERS]]',
        `address = "${issuer}"`,
        name ? `name = "${safe(name)}"` : null,
        desc ? `desc = "${safe(desc)}"` : null,
        '',
        '[[TOKENS]]',
        `issuer = "${issuer}"`,
        `currency = "${cur}"`,
        name ? `name = "${safe(name)}"` : null,
        desc ? `desc = "${safe(desc)}"` : null,
    ].filter((l) => l !== null);
    if (Array.isArray(weblinks)) {
        for (const w of weblinks) {
            if (w && w.url) lines.push('', '[[METADATA.WEBLINKS]]', `url = "${safe(w.url)}"`, `type = "${safe(w.type || 'website')}"`);
        }
    }
    return lines.join('\n') + '\n';
}

module.exports = {
    BLACKHOLE_ADDRESS,
    normalizeCurrency,
    accountState,
    setAccountFlag,
    setDomain,
    issueSupply,
    blackhole,
    faucetFund,
    buildToml,
};
