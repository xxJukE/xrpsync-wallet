// auto-sign.js — rules engine that decides whether an inbound sign request can be
// auto-approved without user interaction.
//
// Rules are stored per-site (e.g. "xrpsync.com" or "xrpsync.com"). Each site has its
// own caps. A request is auto-signed only if EVERY check passes.
//
// HARD-BLOCKS (never auto-signed regardless of rules):
//   AccountDelete, SetRegularKey, SignerListSet, SetFee, EnableAmendment, UNLModify
//
// Cap accounting: daily totals are tracked per site per asset (XRP / IssuedCurrency).
// `getTodayKey()` rolls at UTC midnight. Resetting daily totals is exposed via the API.

'use strict';

const Store = require('./storage');

// Normalize a site key so "www.xrpsync.com" and "xrpsync.com" share ONE rule
// (and one daily cap). Without this, a rule added for one host silently misses
// the other.
function normSite(s) { return String(s || '').replace(/^www\./i, '').toLowerCase(); }

const NEVER_AUTO_TYPES = new Set([
    'AccountDelete',
    'SetRegularKey',
    'SignerListSet',
    'SetFee',
    'EnableAmendment',
    'UNLModify',
]);

const DEFAULT_RULES = {
    enabled: false,                              // legacy persistent flag (kept for back-compat)
    enabledUntil: 0,                             // ms epoch — time-boxed session expiry (0 = OFF)
    allowedTypes: ['OfferCreate'],               // auto-sign = terminal BUY/SELL trades ONLY — never Payments/transfers
    maxPerTransaction: 100,                      // XRP per single tx
    maxPerDay: 500,                              // XRP per UTC day
    maxPerDayRLUSD: 1000,                        // RLUSD per UTC day
    allowedPairs: ['XRP/RLUSD'],                 // for OfferCreate
    allowedDestinations: [],                     // for Payment — empty = always prompt
    networkMainnetOnly: true,
    notifyOnSign: true,
    dailySummary: true,
};

function getAllRules() { return Store.getAutoSignRules(); }

function getRules(site) {
    const all = Store.getAutoSignRules();
    return all[normSite(site)] || null;
}

function setRules(site, rules) {
    if (!site) throw new Error('site_required');
    const merged = { ...DEFAULT_RULES, ...(rules || {}) };
    const all = Store.getAutoSignRules();
    all[normSite(site)] = merged;
    Store.setAutoSignRules(all);
    return merged;
}

function removeRules(site) {
    const all = Store.getAutoSignRules();
    delete all[normSite(site)];
    Store.setAutoSignRules(all);
}

function defaultRules() { return { ...DEFAULT_RULES }; }

// ── Decision ────────────────────────────────────────────────────────────────
function canAutoSign(site, transaction) {
    const rules = getRules(site);
    // Auto-sign is live if the site is persistently ENABLED (rules panel toggle)
    // OR a time-boxed session is still active (armed from the approval modal — it
    // auto-expires to OFF). Either way, the caps / pairs / hard-blocks below apply.
    const sessionActive = rules && rules.enabledUntil && Date.now() < rules.enabledUntil;
    const persistOn = rules && rules.enabled === true;
    if (!rules || (!persistOn && !sessionActive)) {
        return { allowed: false, reason: 'auto_sign_disabled' };
    }

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

    // Allowed pairs (OfferCreate only). A market is symmetric: arming "XRP/RLUSD"
    // permits BOTH a buy and a sell of that market. `pairLabel` is
    // TakerGets/TakerPays, which flips between the two sides, so match either
    // orientation against the allow-list.
    if (txType === 'OfferCreate') {
        const pair = pairLabel(transaction);
        if (!pair || !pairAllowed(pair, rules.allowedPairs)) {
            return { allowed: false, reason: `pair_not_allowed:${pair || 'unknown'}` };
        }
    }

    // Payments send value OUT to an address — riskier than trades. Auto-sign a
    // Payment only to an allow-listed destination the user pre-approved. An empty
    // allow-list means Payments are never auto-signed (always prompt).
    if (txType === 'Payment') {
        const dest = transaction?.Destination;
        const allow = Array.isArray(rules.allowedDestinations) ? rules.allowedDestinations : [];
        if (!dest || !allow.includes(dest)) {
            return { allowed: false, reason: 'payment_destination_not_allowed' };
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
    const key = `${normSite(site)}::${getTodayKey()}`;
    if (!all[key]) all[key] = { xrp: 0, rlusd: 0 };
    return all[key];
}
function setTodayTotals(site, totals) {
    const all = Store.getAutoSignDailyTotals();
    const key = `${normSite(site)}::${getTodayKey()}`;
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
    // Canonical 'RLUSD' (standard ≤3-char path never applies here, but allow it)
    // OR the on-ledger hex form. XRPL encodes any non-standard (>3 char) currency
    // as a 160-bit code = 40 hex chars, zero-padded on the RIGHT. "RLUSD" =
    // 524C555344, padded → 524C555344000000000000000000000000000000. We tolerate
    // the unpadded 10-char form too in case a caller hands us a trimmed code.
    const c = String(currency).toUpperCase();
    return c === 'RLUSD'
        || c === '524C555344'
        || c === '524C555344000000000000000000000000000000';
}

// Match a TakerGets/TakerPays pair label against the allow-list, ignoring side
// (a market is symmetric — "XRP/RLUSD" covers "RLUSD/XRP" too).
function pairAllowed(pair, allowed) {
    if (!pair || !Array.isArray(allowed)) return false;
    const [a, b] = pair.split('/');
    const reversed = `${b}/${a}`;
    return allowed.includes(pair) || allowed.includes(reversed);
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

// ── Time-boxed session ───────────────────────────────────────────────────────
// Auto-sign is OFF by default. The user explicitly ARMS it for a chosen window
// (5m … 3d); it auto-expires to OFF when the window passes. Existing caps,
// allowed pairs, allowed Payment destinations, and hard-blocked types all still
// apply WITHIN the window — the timer only bounds *when* auto-sign is live.
function armSession(site, durationMs, overrides) {
    if (!site) throw new Error('site_required');
    const dur = Math.max(0, Number(durationMs) || 0);
    const existing = getRules(site) || {};
    const merged = { ...DEFAULT_RULES, ...existing, ...(overrides || {}) };
    merged.allowedTypes = ['OfferCreate'];   // hard rule: a timed session auto-signs TRADES only — never a Payment/transfer
    merged.enabledUntil = dur > 0 ? Date.now() + dur : 0;
    const all = Store.getAutoSignRules();
    all[normSite(site)] = merged;
    Store.setAutoSignRules(all);
    return merged;
}

function disarm(site) {
    const all = Store.getAutoSignRules();
    const key = normSite(site);
    if (all[key]) { all[key].enabledUntil = 0; Store.setAutoSignRules(all); }
}

function sessionStatus(site) {
    const rules = getRules(site);
    const until = rules?.enabledUntil || 0;
    const remainingMs = Math.max(0, until - Date.now());
    return { active: remainingMs > 0, enabledUntil: until, remainingMs };
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
    armSession,
    disarm,
    sessionStatus,
};
