// auto-sign.js — rules engine that decides whether an inbound sign request can be
// auto-approved without user interaction.
//
// Rules are stored per-site (e.g. "kyopsec.com" or "lab.kyopsec.com"). Each site has its
// own caps. A request is auto-signed only if EVERY check passes.
//
// HARD-BLOCKS (never auto-signed regardless of rules):
//   AccountDelete, SetRegularKey, SignerListSet, SetFee, EnableAmendment, UNLModify
//
// Cap accounting: daily totals are tracked per site per asset (XRP / IssuedCurrency).
// `getTodayKey()` rolls at UTC midnight. Resetting daily totals is exposed via the API.

'use strict';

const Store = require('./storage');

const NEVER_AUTO_TYPES = new Set([
    'AccountDelete',
    'SetRegularKey',
    'SignerListSet',
    'SetFee',
    'EnableAmendment',
    'UNLModify',
]);

const DEFAULT_RULES = {
    enabled: false,                              // user must explicitly enable per site
    allowedTypes: ['OfferCreate', 'Payment'],
    maxPerTransaction: 100,                      // XRP per single tx
    maxPerDay: 500,                              // XRP per UTC day
    maxPerDayRLUSD: 1000,                        // RLUSD per UTC day
    allowedPairs: ['XRP/RLUSD'],                 // for OfferCreate
    networkMainnetOnly: true,
    notifyOnSign: true,
    dailySummary: true,
};

function getAllRules() { return Store.getAutoSignRules(); }

function getRules(site) {
    const all = Store.getAutoSignRules();
    return all[site] || null;
}

function setRules(site, rules) {
    if (!site) throw new Error('site_required');
    const merged = { ...DEFAULT_RULES, ...(rules || {}) };
    const all = Store.getAutoSignRules();
    all[site] = merged;
    Store.setAutoSignRules(all);
    return merged;
}

function removeRules(site) {
    const all = Store.getAutoSignRules();
    delete all[site];
    Store.setAutoSignRules(all);
}

function defaultRules() { return { ...DEFAULT_RULES }; }

// ── Decision ────────────────────────────────────────────────────────────────
function canAutoSign(site, transaction) {
    const rules = getRules(site);
    if (!rules || !rules.enabled) return { allowed: false, reason: 'auto_sign_disabled' };

    const txType = transaction?.TransactionType;
    if (!txType) return { allowed: false, reason: 'missing_tx_type' };
    if (NEVER_AUTO_TYPES.has(txType)) return { allowed: false, reason: 'dangerous_tx_type' };
    if (!rules.allowedTypes.includes(txType)) return { allowed: false, reason: `type_not_allowed:${txType}` };

    // Per-transaction amount cap (in XRP equivalents)
    const amount = extractXrpAmount(transaction);
    if (amount > rules.maxPerTransaction) {
        return { allowed: false, reason: `exceeds_per_tx_limit:${amount}>${rules.maxPerTransaction}` };
    }

    // Daily caps
    const today = getTodayTotals(site);
    if (today.xrp + amount > rules.maxPerDay) {
        return { allowed: false, reason: `exceeds_daily_xrp:${today.xrp + amount}>${rules.maxPerDay}` };
    }
    const rlusd = extractRlusdAmount(transaction);
    if (rlusd && (today.rlusd + rlusd) > rules.maxPerDayRLUSD) {
        return { allowed: false, reason: `exceeds_daily_rlusd:${today.rlusd + rlusd}>${rules.maxPerDayRLUSD}` };
    }

    // Allowed pairs (OfferCreate only)
    if (txType === 'OfferCreate') {
        const pair = pairLabel(transaction);
        if (!pair || !rules.allowedPairs.includes(pair)) {
            return { allowed: false, reason: `pair_not_allowed:${pair || 'unknown'}` };
        }
    }

    // All checks passed — record provisional cap usage. Caller will call logAutoSign on success.
    return { allowed: true, reason: 'all_rules_passed', amountXrp: amount, amountRlusd: rlusd };
}

function logAutoSign(site, transaction, result) {
    // Log entry
    const log = Store.getAutoSignLog();
    log.push({
        ts: new Date().toISOString(),
        site,
        type: transaction?.TransactionType,
        account: transaction?.Account,
        amount_xrp: extractXrpAmount(transaction),
        amount_rlusd: extractRlusdAmount(transaction),
        result,
    });
    Store.setAutoSignLog(log.slice(-1000));

    // Increment daily totals only if signed (not for failures)
    if (result?.result === 'auto_signed') {
        const today = getTodayTotals(site);
        today.xrp += extractXrpAmount(transaction) || 0;
        today.rlusd += extractRlusdAmount(transaction) || 0;
        setTodayTotals(site, today);
    }
}

function recentLog(limit) {
    const log = Store.getAutoSignLog();
    return log.slice(-Math.max(1, Math.min(1000, limit || 100))).reverse();
}

function resetDailyTotals(site) {
    const all = Store.getAutoSignDailyTotals();
    delete all[`${site}::${getTodayKey()}`];
    Store.setAutoSignDailyTotals(all);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function getTodayKey() { return new Date().toISOString().slice(0, 10); }

function getTodayTotals(site) {
    const all = Store.getAutoSignDailyTotals();
    const key = `${site}::${getTodayKey()}`;
    if (!all[key]) all[key] = { xrp: 0, rlusd: 0 };
    return all[key];
}
function setTodayTotals(site, totals) {
    const all = Store.getAutoSignDailyTotals();
    const key = `${site}::${getTodayKey()}`;
    all[key] = totals;
    Store.setAutoSignDailyTotals(all);
}

// Extract XRP amount in whole XRP (not drops). Looks at TakerGets / Amount when those are XRP.
function extractXrpAmount(tx) {
    if (!tx) return 0;
    let drops = 0;
    if (typeof tx.Amount === 'string') drops += Number(tx.Amount);
    if (typeof tx.TakerGets === 'string') drops += Number(tx.TakerGets);
    return drops > 0 ? drops / 1_000_000 : 0;
}

function extractRlusdAmount(tx) {
    if (!tx) return 0;
    const candidates = [tx.Amount, tx.TakerPays, tx.TakerGets].filter(v => v && typeof v === 'object');
    let total = 0;
    for (const c of candidates) {
        if (isRlusd(c.currency, c.issuer)) total += Number(c.value || 0);
    }
    return total;
}

function isRlusd(currency, issuer) {
    if (!currency || !issuer) return false;
    // Hex-encoded RLUSD or canonical 'RLUSD'
    const c = String(currency).toUpperCase();
    return c === 'RLUSD' || c === '524C555344' /* "RLUSD" hex padded length is 40 chars */;
}

function pairLabel(tx) {
    const gets = tx.TakerGets, pays = tx.TakerPays;
    const g = currencyOf(gets);
    const p = currencyOf(pays);
    if (!g || !p) return null;
    return `${g}/${p}`;
}
function currencyOf(v) {
    if (typeof v === 'string') return 'XRP';
    if (v && typeof v === 'object') {
        if (isRlusd(v.currency, v.issuer)) return 'RLUSD';
        return String(v.currency || '').toUpperCase();
    }
    return null;
}

module.exports = {
    canAutoSign,
    logAutoSign,
    getRules,
    setRules,
    removeRules,
    getAllRules,
    defaultRules,
    recentLog,
    resetDailyTotals,
};
