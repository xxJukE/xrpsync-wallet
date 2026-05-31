// renderer.js — UI logic for the main wallet window. Talks to main only via window.labs.*

'use strict';

// ── State ───────────────────────────────────────────────────────────────────
const state = {
    wallets: [],
    activeAddress: null,
    pane: 'welcome',
    autoSignRules: {},
    autoSignLog: [],
    autoSignAllowed: undefined, // resolved from account entitlements (Pro = true)
};

const $ = (id) => document.getElementById(id);
const fmtNum = (n, d = 2) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const shortAddr = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';

// ── Lock screen ─────────────────────────────────────────────────────────────
async function bootLockState() {
    const s = await window.labs.lock.status();
    if (typeof s.lockMs === 'number') _lockMs = s.lockMs;
    if (!s.hasMaster) {
        // Brand-new install → auto-generate the master password and walk the
        // user through saving it. We don't ever expose the legacy "type your
        // own password" form on a fresh install — eliminating weak passwords.
        await startFirstLaunchFlow();
        return;
    }
    if (s.locked) {
        $('lockOverlay').classList.add('is-open');
        setLockUI(true);
    } else {
        setLockUI(false);
    }
}

async function startFirstLaunchFlow() {
    $('lockCardStd').classList.add('hidden');
    $('lockCardGen').classList.remove('hidden');
    $('lockOverlay').classList.add('is-open');
    let r;
    try { r = await window.labs.lock.firstLaunchSetup(); }
    catch (e) { $('genPwErr').textContent = String(e?.message || e); return; }
    if (!r.ok) {
        // Edge case — master appeared between status() and here. Fall back to standard unlock.
        $('lockCardGen').classList.add('hidden');
        $('lockCardStd').classList.remove('hidden');
        return;
    }
    const pw = r.password;
    $('genPwOut').textContent = pw;

    const updateCta = () => {
        $('genPwContinue').disabled = !($('genPwAck1').checked && $('genPwAck2').checked);
    };
    $('genPwAck1').addEventListener('change', updateCta);
    $('genPwAck2').addEventListener('change', updateCta);

    $('genPwCopy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(pw); $('genPwCopy').textContent = 'COPIED'; setTimeout(() => $('genPwCopy').textContent = 'COPY', 1500); } catch (_) {}
    });

    $('genPwContinue').addEventListener('click', async () => {
        if ($('genPwContinue').disabled) return;
        // Wipe the displayed password from DOM before closing — no need to keep it visible.
        $('genPwOut').textContent = '••••••••••••••••••••••••';
        $('lockOverlay').classList.remove('is-open');
        $('lockCardGen').classList.add('hidden');
        $('lockCardStd').classList.remove('hidden');
        await refreshAll();
    });
}

$('lockSubmit').addEventListener('click', async () => {
    const pw = $('lockPw').value;
    if (!pw || pw.length < 8) { $('lockErr').textContent = 'min 8 characters'; return; }
    $('lockErr').textContent = '';

    const s = await window.labs.lock.status();
    try {
        if (!s.hasMaster) {
            const conf = $('lockPwConfirm').value;
            if (conf !== pw) { $('lockErr').textContent = 'passwords do not match'; return; }
            await window.labs.lock.setMaster(pw);
        } else {
            const r = await window.labs.lock.unlock(pw);
            if (!r.ok) {
                $('lockErr').textContent = r.error === 'engine_unavailable'
                    ? 'Wallet engine failed to load. Your funds are safe — this is an app bug, not a wrong password. Do not reinstall or reset the wallet. Contact support.'
                    : 'wrong password';
                return;
            }
        }
        $('lockOverlay').classList.remove('is-open');
        $('lockPw').value = ''; $('lockPwConfirm').value = '';
        await refreshAll();
    } catch (e) { $('lockErr').textContent = String(e.message || e); }
});

$('lockPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lockSubmit').click(); });
$('lockPwConfirm')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lockSubmit').click(); });

// ── Lock-state chip + auto-lock countdown ──────────────────────────────────
let _lockMs = 300000;          // mirrors main.js lockMs; refreshed from lock:status / ui:unlocked / set-timeout
let _lockDeadline = 0;
let _lockTick = null;

function fmtCountdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function stopLockCountdown() {
    if (_lockTick) { clearInterval(_lockTick); _lockTick = null; }
    const c = $('lockCountdown'); if (c) c.textContent = '';
}
function startLockCountdown() {
    _lockDeadline = Date.now() + _lockMs;
    if (_lockTick) clearInterval(_lockTick);
    const render = () => { const c = $('lockCountdown'); if (c) c.textContent = 'auto-locks in ' + fmtCountdown(_lockDeadline - Date.now()); };
    render();
    _lockTick = setInterval(render, 1000);
}
// Reset the countdown only while it's running (i.e. unlocked), matching main.js noteActivity.
function bumpLockCountdown() { if (_lockTick) _lockDeadline = Date.now() + _lockMs; }

function setLockUI(locked) {
    const dot = $('lockDot'), lbl = $('lockStateLabel'), nowBtn = $('lockNowBtn');
    if (locked) {
        if (dot) dot.className = 'dot warn';
        if (lbl) lbl.textContent = 'LOCKED';
        if (nowBtn) nowBtn.style.display = 'none';
        stopLockCountdown();
    } else {
        if (dot) dot.className = 'dot on';
        if (lbl) lbl.textContent = 'UNLOCKED';
        if (nowBtn) nowBtn.style.display = '';
        startLockCountdown();
    }
}

// Reset the countdown on the same activity the main process watches for auto-lock.
window.addEventListener('mousemove', bumpLockCountdown, { passive: true });
window.addEventListener('keydown',  bumpLockCountdown, { passive: true });

$('lockNowBtn').addEventListener('click', async () => {
    await window.labs.lock.lockNow();
    $('lockOverlay').classList.add('is-open');
    setLockUI(true);
});

window.labs.on.locked(() => {
    $('lockOverlay').classList.add('is-open');
    setLockUI(true);
});
window.labs.on.unlocked((payload) => {
    if (payload && typeof payload.lockMs === 'number') _lockMs = payload.lockMs;
    setLockUI(false);
});

// ── Pane navigation ─────────────────────────────────────────────────────────
function showPane(name) {
    state.pane = name;
    document.querySelectorAll('.pane').forEach(p => p.classList.add('hidden'));
    const map = {
        welcome: 'paneWelcome',
        wallet: 'paneWallet',
        'auto-sign': 'paneAutoSign',
        backup: 'paneBackup',
        settings: 'paneSettings',
        'new-wallet': 'paneNewWallet',
        'import-wallet': 'paneImportWallet',
        send: 'paneSend',
        'account-login':  'paneAccountLogin',
        'account-manage': 'paneAccountManage',
    };
    const el = $(map[name] || 'paneWelcome');
    if (el) el.classList.remove('hidden');
    document.querySelectorAll('.lw-side .item, .lw-side .add-btn[data-pane]').forEach(i => i.classList.toggle('is-active', i.dataset.pane === name));
    if (name === 'account-manage') refreshAccountManage();
}

document.querySelectorAll('.lw-side .item, .lw-side .add-btn[data-pane]').forEach(i => i.addEventListener('click', () => {
    if (!i.dataset.pane) return;
    showPane(i.dataset.pane);
    if (i.dataset.pane === 'auto-sign') refreshAutoSign();
    if (i.dataset.pane === 'settings') refreshSettings();
}));

$('newWalletBtn').addEventListener('click', () => showPane('new-wallet'));
$('importWalletBtn').addEventListener('click', () => showPane('import-wallet'));

window.labs.on.nav((target) => {
    showPane(target);
    if (target === 'auto-sign') refreshAutoSign();
});

// ── Wallet list ─────────────────────────────────────────────────────────────
async function refreshWallets() {
    state.wallets = await window.labs.wallet.list();
    const el = $('walletList');
    el.innerHTML = '';
    if (!state.wallets.length) {
        const empty = document.createElement('div');
        empty.className = 'mut';
        empty.style.cssText = 'padding:8px 14px;font-size:10px';
        empty.textContent = 'no wallets yet';
        el.appendChild(empty);
        updateTransferAvailability();
        return;
    }
    state.wallets.forEach(w => {
        const item = document.createElement('div');
        item.className = 'item' + (w.address === state.activeAddress ? ' is-active' : '');
        item.innerHTML = `<div>${w.label || 'Wallet'}</div><small class="mut">${shortAddr(w.address)}</small>`;
        item.addEventListener('click', () => { state.activeAddress = w.address; openWallet(w.address); refreshWallets(); });
        el.appendChild(item);
    });
    updateTransferAvailability();
}

async function openWallet(address) {
    showPane('wallet');
    const w = state.wallets.find(x => x.address === address);
    $('wDetailLabel').textContent = (w?.label || 'Wallet');
    $('wDetailAddr').textContent = address;   // exact case — addresses are case-sensitive, never uppercased
    // If the receive-QR modal is open for a different address, close it. The
    // QR is address-specific and stale-ness here is confusing.
    closeQrModalIfOpen();
    state.unfunded = false;
    $('wXrp').textContent = '…';
    $('wRlusd').textContent = '…';
    $('wTxBody').innerHTML = '<tr><td colspan="6" class="empty-state">loading…</td></tr>';
    $('wTrBody').innerHTML = '<tr><td colspan="5" class="empty-state">Loading…</td></tr>';

    // Balances — balances.fetch returns { unfunded:true } for an un-activated account.
    try {
        const bal = await window.labs.xrpl.balances(address);
        if (bal.unfunded) {
            state.unfunded = true;
            $('wXrp').textContent = '—';
            $('wRlusd').textContent = '—';
        } else {
            $('wXrp').textContent = fmtNum(bal.xrp, 2);
            const rlusd = (bal.tokens || []).find(t => t.currency === 'RLUSD');
            $('wRlusd').textContent = rlusd ? fmtNum(rlusd.value, 4) : '—';
        }
    } catch (e) {
        $('wXrp').textContent = '!';
        $('wRlusd').textContent = '!';
    }

    // Recent activity — an un-activated account has no transaction history.
    if (state.unfunded) {
        $('wTxBody').innerHTML = '<tr><td colspan="6" class="empty-state">No transactions yet — account not activated.</td></tr>';
        $('wTxMeta').textContent = '—';
    } else {
        try {
            const h = await window.labs.xrpl.history(address, 30);
            const tb = $('wTxBody');
            if (!h.txs.length) { tb.innerHTML = '<tr><td colspan="6" class="empty-state">No recent activity</td></tr>'; }
            else {
                tb.innerHTML = h.txs.map(t => `<tr>
                    <td>${t.hash ? shortAddr(t.hash) : '—'}</td>
                    <td>${t.type || '—'}</td>
                    <td>${shortAddr(t.destination || t.account)}</td>
                    <td class="num">${typeof t.amount === 'string' ? fmtNum(Number(t.amount)/1_000_000, 2) + ' XRP' : '—'}</td>
                    <td class="mut">${t.date ? new Date(t.date).toLocaleString() : '—'}</td>
                    <td class="${t.result === 'tesSUCCESS' ? 'fg-profit' : 'fg-danger'}">${t.result || '—'}</td>
                </tr>`).join('');
            }
            $('wTxMeta').textContent = h.txs.length + ' loaded';
        } catch (_) {
            $('wTxBody').innerHTML = '<tr><td colspan="6" class="fg-danger empty-state">failed to load</td></tr>';
        }
    }

    await renderTrustlines(address);
}

// ── Trustlines panel ────────────────────────────────────────────────────────
// XRPL currency codes >3 chars come back from account_lines as 40-char hex.
// Decode to ASCII for display; the RAW code is what we pass back to TrustSet.
function humanCurrency(c) {
    if (!c) return '';
    if (c.length === 3) return c;
    if (/^[0-9A-Fa-f]{40}$/.test(c)) {
        let s = '';
        for (let i = 0; i < c.length; i += 2) { const code = parseInt(c.substr(i, 2), 16); if (code) s += String.fromCharCode(code); }
        s = s.replace(/[^\x20-\x7E]/g, '');
        return s || c;
    }
    return c;
}
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

async function renderTrustlines(address) {
    const tb = $('wTrBody');
    if (state.unfunded) {
        tb.innerHTML = `<tr><td colspan="5" class="empty-state">
            <div class="lead">Account not yet activated</div>
            Send XRP to this address to activate it (the network base reserve), then add trustlines to hold tokens.
            <div class="cta"><button class="btn sm" id="wTrFundCta">Copy address to fund</button></div>
        </td></tr>`;
        $('wTrMeta').textContent = '0 lines';
        $('wTrFundCta')?.addEventListener('click', copyActiveAddress);
        return;
    }
    tb.innerHTML = '<tr><td colspan="5" class="empty-state">Loading…</td></tr>';
    try {
        const lines = await window.labs.xrpl.trustlines(address);
        if (!lines.length) {
            tb.innerHTML = `<tr><td colspan="5" class="empty-state">
                <div class="lead">No trustlines yet</div>Add one to hold tokens like RLUSD.</td></tr>`;
        } else {
            tb.innerHTML = lines.map((l, i) => `<tr>
                <td>${esc(humanCurrency(l.currency))}</td>
                <td>${shortAddr(l.issuer)}</td>
                <td class="num">${esc(l.balance)}</td>
                <td class="num">${esc(l.limit)}</td>
                <td class="num"><button class="btn ghost sm" data-tl-remove="${i}">Remove</button></td>
            </tr>`).join('');
            tb.querySelectorAll('[data-tl-remove]').forEach((btn) =>
                btn.addEventListener('click', () => removeTrustline(lines[Number(btn.dataset.tlRemove)])));
        }
        $('wTrMeta').textContent = lines.length + ' lines';
    } catch (_) {
        tb.innerHTML = '<tr><td colspan="5" class="fg-danger empty-state">failed to load</td></tr>';
    }
}

$('wRefresh').addEventListener('click', () => { if (state.activeAddress) openWallet(state.activeAddress); });

// ── Click-to-copy address (preserves exact case) ────────────────────────────
async function copyActiveAddress() {
    if (!state.activeAddress) return;
    try { await navigator.clipboard.writeText(state.activeAddress); } catch (_) { /* clipboard blocked — selection still works */ }
    const chip = $('wCopyAddr');
    if (chip) { chip.classList.add('copied'); setTimeout(() => chip.classList.remove('copied'), 1500); }
}
$('wCopyAddr')?.addEventListener('click', copyActiveAddress);
$('wCopyAddr')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyActiveAddress(); } });

// ── Add / remove trustline ──────────────────────────────────────────────────
const RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';   // RLUSD DEX issuer (config('xrpl.rlusd_dex_issuer'))

function openTrustlineModal() {
    if (!state.activeAddress) return;
    $('tlCur').value = ''; $('tlIssuer').value = ''; $('tlLimit').value = ''; $('tlPw').value = '';
    $('tlErr').textContent = '';
    $('tlSubmit').disabled = false; $('tlSubmit').textContent = 'Add Trustline';
    $('trustlineModal').classList.add('is-open');
    setTimeout(() => $('tlCur').focus(), 30);
}
function closeTrustlineModal() { $('trustlineModal').classList.remove('is-open'); }

$('wAddTrustlineBtn')?.addEventListener('click', openTrustlineModal);
$('tlCancel')?.addEventListener('click', closeTrustlineModal);
$('tlPresetRlusd')?.addEventListener('click', () => {
    $('tlCur').value = 'RLUSD';            // main encodes RLUSD → 40-hex for the ledger
    $('tlIssuer').value = RLUSD_ISSUER;
    $('tlLimit').value = '1000';
});
$('tlPw')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitTrustline(); });
$('tlSubmit')?.addEventListener('click', submitTrustline);

async function submitTrustline() {
    const currency = $('tlCur').value.trim();
    const issuer = $('tlIssuer').value.trim();
    const limit = $('tlLimit').value.trim();
    const password = $('tlPw').value;
    const err = $('tlErr');
    err.textContent = '';
    if (!currency) { err.textContent = 'Enter a currency code (e.g. RLUSD).'; return; }
    if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(issuer)) { err.textContent = 'Enter a valid issuer address (rXXX…).'; return; }
    if (!/^\d+(\.\d+)?$/.test(limit) || Number(limit) < 0) { err.textContent = 'Enter a limit — a number ≥ 0.'; return; }
    if (!password) { err.textContent = 'Master password is required to sign.'; return; }

    $('tlSubmit').disabled = true; $('tlSubmit').textContent = 'Submitting…';
    let r;
    try { r = await window.labs.xrpl.setTrustline({ currency, issuer, limit, password }); }
    catch (e) { r = { ok: false, error: e?.message || 'failed' }; }

    if (r && r.ok) {
        closeTrustlineModal();
        await infoModal({ title: 'Trustline added', message: 'TrustSet confirmed on the XRPL.\n\ntx: ' + (r.tx_hash || '—') });
        if (state.activeAddress) openWallet(state.activeAddress);
    } else {
        $('tlSubmit').disabled = false; $('tlSubmit').textContent = 'Add Trustline';
        err.textContent = (r && r.error === 'wrong_password') ? 'Wrong master password.' : ('Failed: ' + ((r && r.error) || 'unknown'));
    }
}

async function removeTrustline(line) {
    if (!line) return;
    const cur = humanCurrency(line.currency);
    const pw = await promptModal({
        title: 'Remove trustline',
        message: 'Re-enter your master password to remove the ' + cur + ' trustline.\n\nThis sets its limit to 0 (the line clears once its balance is also 0).',
        okText: 'Remove',
    });
    if (!pw) return;
    let r;
    try { r = await window.labs.xrpl.setTrustline({ currency: line.currency, issuer: line.issuer, limit: '0', password: pw }); }
    catch (e) { r = { ok: false, error: e?.message || 'failed' }; }
    if (r && r.ok) {
        await infoModal({ title: 'Trustline removed', message: 'TrustSet confirmed.\n\ntx: ' + (r.tx_hash || '—') });
        if (state.activeAddress) openWallet(state.activeAddress);
    } else {
        await infoModal({ title: 'Remove failed', message: (r && r.error === 'wrong_password') ? 'Wrong master password.' : ('Failed: ' + ((r && r.error) || 'unknown')) });
    }
}

// ── Modals (Electron's renderer has no window.prompt) ───────────────────────
// promptModal: password/text input → Promise<string|null> (null = cancelled).
function promptModal({ title = 'Confirm', message = '', type = 'password', placeholder = '', okText = 'OK' } = {}) {
    return new Promise((resolve) => {
        const overlay = $('pwModal'), input = $('pwModalInput');
        $('pwModalTitle').textContent = title;
        $('pwModalMsg').textContent   = message;
        input.type = type === 'password' ? 'password' : 'text';
        input.placeholder = placeholder || '';
        input.value = '';
        $('pwModalErr').textContent = '';
        $('pwModalOk').textContent = okText;
        overlay.classList.add('is-open');
        setTimeout(() => input.focus(), 30);
        const cleanup = () => {
            overlay.classList.remove('is-open');
            $('pwModalOk').removeEventListener('click', onOk);
            $('pwModalCancel').removeEventListener('click', onCancel);
            input.removeEventListener('keydown', onKey);
        };
        const onOk = () => { const v = input.value; cleanup(); resolve(v); };
        const onCancel = () => { cleanup(); resolve(null); };
        const onKey = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); onOk(); }
            else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        };
        $('pwModalOk').addEventListener('click', onOk);
        $('pwModalCancel').addEventListener('click', onCancel);
        input.addEventListener('keydown', onKey);
    });
}

// infoModal: OK-only message → Promise<void> (replaces window.alert in flows we own).
function infoModal({ title = 'Notice', message = '', okText = 'OK' } = {}) {
    return new Promise((resolve) => {
        const overlay = $('infoModal'), ok = $('infoModalOk');
        $('infoModalTitle').textContent = title;
        $('infoModalMsg').textContent   = message;
        ok.textContent = okText;
        overlay.classList.add('is-open');
        setTimeout(() => ok.focus(), 30);
        const cleanup = () => {
            overlay.classList.remove('is-open');
            ok.removeEventListener('click', onOk);
            document.removeEventListener('keydown', onKey);
        };
        const onOk = () => { cleanup(); resolve(); };
        const onKey = (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); onOk(); } };
        ok.addEventListener('click', onOk);
        document.addEventListener('keydown', onKey);
    });
}

// showSeedModal: displays a secret with copy + 60s auto-clear countdown. The
// seed is wiped from the DOM on Done or on timeout.
function showSeedModal(seed) {
    const overlay = $('seedModal'), out = $('seedModalValue'), timerEl = $('seedModalTimer'), copyBtn = $('seedModalCopy');
    out.textContent = seed;
    copyBtn.textContent = 'Copy seed';
    overlay.classList.add('is-open');
    let remaining = 60, done = false, interval = null;
    timerEl.textContent = String(remaining);
    const close = () => {
        if (done) return; done = true;
        if (interval) { clearInterval(interval); interval = null; }
        out.textContent = '';                       // wipe seed from the DOM
        overlay.classList.remove('is-open');
        $('seedModalDone').removeEventListener('click', close);
        copyBtn.removeEventListener('click', onCopy);
    };
    const onCopy = async () => {
        try {
            await navigator.clipboard.writeText(seed);
            copyBtn.textContent = 'Copied';
            setTimeout(() => { if (!done) copyBtn.textContent = 'Copy seed'; }, 1500);
        } catch (_) { /* clipboard blocked — manual selection still works */ }
    };
    interval = setInterval(() => {
        remaining -= 1;
        timerEl.textContent = String(remaining);
        if (remaining <= 0) close();
    }, 1000);
    $('seedModalDone').addEventListener('click', close);
    copyBtn.addEventListener('click', onCopy);
}

$('wRevealBtn').addEventListener('click', async () => {
    if (!state.activeAddress) return;
    const pw = await promptModal({ title: 'Reveal Seed', message: 'Re-enter master password to reveal seed:' });
    if (!pw) return;
    try {
        const seed = await window.labs.wallet.revealSecret(state.activeAddress, pw);
        showSeedModal(seed);
    } catch (e) {
        await infoModal({ title: 'Reveal Failed', message: e.message || 'unknown' });
    }
});

$('wDeleteBtn').addEventListener('click', async () => {
    if (!state.activeAddress) return;
    const conf = await promptModal({ title: 'Delete Wallet', message: 'Type DELETE to remove this wallet from the device:', type: 'text', placeholder: 'DELETE', okText: 'Delete' });
    if (conf !== 'DELETE') return;
    await window.labs.wallet.deleteWallet(state.activeAddress, 'DELETE');
    state.activeAddress = null;
    await refreshWallets();
    showPane('welcome');
    await infoModal({ title: 'Wallet Deleted', message: 'The wallet was removed from this device.' });
});

$('wSendBtn').addEventListener('click', () => {
    if (!state.activeAddress) return;
    $('sndFrom').textContent = shortAddr(state.activeAddress);
    $('sndResult').textContent = '';
    $('sndTo').value = ''; $('sndAmt').value = ''; $('sndTag').value = ''; $('sndPw').value = '';
    showPane('send');
});

// Fund Wallet — open xrpsync.com/buy-xrp in the default browser with the
// active wallet address pre-filled. Settlement happens on-ramp side; the
// wallet just refreshes balances when the user comes back.
$('wFundBtn')?.addEventListener('click', async () => {
    try { await window.labs.onramp.open(state.activeAddress); }
    catch (e) { console.error('fund-wallet open failed', e); }
});

$('sndCancel').addEventListener('click', () => showPane('wallet'));

$('sndSubmit').addEventListener('click', async () => {
    const to = $('sndTo').value.trim();
    const amt = Number($('sndAmt').value);
    const tag = $('sndTag').value ? Number($('sndTag').value) : null;
    const pw = $('sndPw').value;
    if (!to || !amt || amt <= 0 || !pw) { $('sndResult').textContent = 'fill all required fields'; return; }
    $('sndResult').textContent = 'signing…';
    try {
        const tx = {
            TransactionType: 'Payment',
            Account: state.activeAddress,
            Destination: to,
            Amount: String(Math.round(amt * 1_000_000)),
        };
        if (tag !== null) tx.DestinationTag = tag;
        const r = await window.labs.xrpl.signAndSubmit(state.activeAddress, tx, pw);
        $('sndResult').innerHTML = `<span class="fg-profit">submitted</span> · hash: ${r.hash} · result: ${r.result?.engine_result || '—'}`;
        setTimeout(() => openWallet(state.activeAddress), 1500);
    } catch (e) {
        $('sndResult').innerHTML = `<span class="fg-danger">failed: ${e.message || e}</span>`;
    }
});

// ── Transfer: move XRP between this device's own wallets ────────────────────
// Reuses the standard Payment + xrpl:sign-and-submit IPC. Form → confirmation
// → sign-and-submit. The single-wallet guard is applied inside refreshWallets()
// below (see updateTransferAvailability()).
const XRPL_BASE_RESERVE_XRP = 10;

// utf8 → uppercase hex, used to build the XRPL Memo.MemoData field. Buffer is
// not available in the renderer's main world (contextIsolation: true), so we
// roll our own with TextEncoder.
function utf8ToHexUpper(s) {
    const bytes = new TextEncoder().encode(s);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out.toUpperCase();
}

const XFER_RESULT_HINTS = {
    tecNO_DST_INSUF_XRP: 'destination is unactivated and the amount is below the 10 XRP activation reserve',
    tecUNFUNDED_PAYMENT: 'source wallet does not have enough spendable XRP after reserve + fee',
    tecDST_TAG_NEEDED:   'destination requires a tag — this transfer UI does not support tags (use Send)',
    tecPATH_DRY:         'no liquidity path available for this payment',
    temBAD_AMOUNT:       'amount is malformed',
    temREDUNDANT:        'source and destination cannot be the same',
};

function updateTransferAvailability() {
    const btn = $('wTransferBtn');
    if (!btn) return;
    if (state.wallets.length < 2) {
        btn.disabled = true;
        btn.title = 'Add another wallet to enable transfers';
    } else {
        btn.disabled = false;
        btn.title = 'Move XRP between your own wallets';
    }
}

function transferOptionsHtml(excludeAddress) {
    return state.wallets
        .filter(w => w.address !== excludeAddress)
        .map(w => `<option value="${w.address}">${(w.label || 'Wallet').replace(/</g, '&lt;')} — ${shortAddr(w.address)}</option>`)
        .join('');
}

function transferWalletLabel(address) {
    const w = state.wallets.find(x => x.address === address);
    return (w?.label || 'Wallet') + ' (' + shortAddr(address) + ')';
}

async function updateTransferAvailable() {
    const from = $('xferFrom').value;
    if (!from) { $('xferAvail').textContent = 'Available: —'; return; }
    $('xferAvail').textContent = 'Available: …';
    try {
        const bal = await window.labs.xrpl.balances(from);
        if (bal.unfunded) {
            $('xferAvail').innerHTML = '<span class="fg-danger">source wallet is unactivated — cannot send</span>';
            return;
        }
        const spendable = Math.max(0, Number(bal.xrp) - XRPL_BASE_RESERVE_XRP);
        $('xferAvail').textContent = 'Available: ' + fmtNum(spendable, 6) + ' XRP (' + fmtNum(bal.xrp, 6) + ' − 10 reserve)';
    } catch (e) {
        $('xferAvail').innerHTML = '<span class="fg-danger">balance fetch failed</span>';
    }
}

function openTransferModal() {
    if (state.wallets.length < 2) return;
    // Reset form
    const from = state.activeAddress && state.wallets.some(w => w.address === state.activeAddress)
        ? state.activeAddress
        : state.wallets[0].address;
    $('xferFrom').innerHTML = state.wallets
        .map(w => `<option value="${w.address}">${(w.label || 'Wallet').replace(/</g, '&lt;')} — ${shortAddr(w.address)}</option>`)
        .join('');
    $('xferFrom').value = from;
    $('xferTo').innerHTML = transferOptionsHtml(from);
    $('xferAmt').value = '';
    $('xferMemo').value = '';
    $('xferPw').value = '';
    $('xferFormErr').textContent = '';
    $('xferConfirmErr').textContent = '';
    $('xferConfirmStatus').textContent = '';
    $('xferStepConfirm').classList.add('hidden');
    $('xferStepForm').classList.remove('hidden');
    $('transferModal').classList.add('is-open');
    updateTransferAvailable();
}

function closeTransferModal() {
    $('transferModal').classList.remove('is-open');
    $('xferPw').value = '';
}

$('wTransferBtn')?.addEventListener('click', openTransferModal);
$('xferCancel')?.addEventListener('click', closeTransferModal);
$('xferBack')?.addEventListener('click', () => {
    $('xferStepConfirm').classList.add('hidden');
    $('xferStepForm').classList.remove('hidden');
});

$('xferFrom')?.addEventListener('change', () => {
    const from = $('xferFrom').value;
    $('xferTo').innerHTML = transferOptionsHtml(from);
    updateTransferAvailable();
});

$('xferContinue')?.addEventListener('click', async () => {
    const from = $('xferFrom').value;
    const to = $('xferTo').value;
    const amt = Number($('xferAmt').value);
    const memo = $('xferMemo').value.trim();
    const pw = $('xferPw').value;
    $('xferFormErr').textContent = '';
    if (!from || !to)        { $('xferFormErr').textContent = 'pick a source and destination wallet'; return; }
    if (from === to)         { $('xferFormErr').textContent = 'source and destination must differ'; return; }
    if (!amt || amt <= 0)    { $('xferFormErr').textContent = 'enter an amount greater than zero'; return; }
    if (!Number.isFinite(amt)) { $('xferFormErr').textContent = 'amount is not a number'; return; }
    if (!pw)                 { $('xferFormErr').textContent = 'enter your master password to sign'; return; }
    if (memo.length > 120)   { $('xferFormErr').textContent = 'memo is too long (max 120 chars)'; return; }

    // Warn if destination is unactivated AND amount under activation reserve.
    try {
        const destBal = await window.labs.xrpl.balances(to);
        if (destBal.unfunded && amt < XRPL_BASE_RESERVE_XRP) {
            $('xferFormErr').innerHTML = `destination is unactivated — first payment must be ≥ ${XRPL_BASE_RESERVE_XRP} XRP to create the account`;
            return;
        }
    } catch (_) { /* fall through — submit-side error will surface */ }

    $('xferConfirmMsg').textContent =
        `Send ${fmtNum(amt, 6)} XRP from ${transferWalletLabel(from)} to ${transferWalletLabel(to)}?`;
    $('xferConfirmAddr').textContent = to;
    $('xferConfirmErr').textContent = '';
    $('xferConfirmStatus').textContent = '';
    $('xferStepForm').classList.add('hidden');
    $('xferStepConfirm').classList.remove('hidden');
});

$('xferSign')?.addEventListener('click', async () => {
    const from = $('xferFrom').value;
    const to = $('xferTo').value;
    const amt = Number($('xferAmt').value);
    const memo = $('xferMemo').value.trim();
    const pw = $('xferPw').value;
    if (!from || !to || !amt || !pw) {
        // Should not happen — form-stage guard already enforced this.
        $('xferConfirmErr').textContent = 'missing required fields — go back and retry';
        return;
    }
    $('xferSign').disabled = true;
    $('xferBack').disabled = true;
    $('xferConfirmErr').textContent = '';
    $('xferConfirmStatus').textContent = 'signing…';
    try {
        const tx = {
            TransactionType: 'Payment',
            Account: from,
            Destination: to,
            Amount: String(Math.round(amt * 1_000_000)),
        };
        if (memo) {
            tx.Memos = [{ Memo: { MemoData: utf8ToHexUpper(memo) } }];
        }
        const r = await window.labs.xrpl.signAndSubmit(from, tx, pw);
        const engine = r?.result?.engine_result || '';
        const ok = engine === 'tesSUCCESS' || engine === 'terQUEUED';
        if (ok) {
            $('xferConfirmStatus').innerHTML = `<span class="fg-profit">submitted</span> · ${engine} · hash: ${r.hash}`;
            // Repaint balances for the currently-viewed wallet (covers the
            // common case where From == active). Both sides will reconcile
            // once the ledger validates and the user refreshes.
            if (state.activeAddress) openWallet(state.activeAddress);
            setTimeout(() => {
                closeTransferModal();
                infoModal({
                    title: 'Transfer submitted',
                    message: `Sent ${fmtNum(amt, 6)} XRP to ${transferWalletLabel(to)}.\n\nResult: ${engine}\nHash: ${r.hash}`,
                });
            }, 800);
        } else {
            const hint = XFER_RESULT_HINTS[engine];
            $('xferConfirmStatus').textContent = '';
            $('xferConfirmErr').innerHTML = `<span class="fg-danger">failed: ${engine || 'unknown'}</span>${hint ? ' — ' + hint : ''}`;
            $('xferSign').disabled = false;
            $('xferBack').disabled = false;
        }
    } catch (e) {
        $('xferConfirmStatus').textContent = '';
        $('xferConfirmErr').innerHTML = `<span class="fg-danger">failed: ${(e && e.message) || e}</span>`;
        $('xferSign').disabled = false;
        $('xferBack').disabled = false;
    }
});

// ── New wallet ──────────────────────────────────────────────────────────────
$('nwGenerate').addEventListener('click', async () => {
    const label = $('nwLabel').value.trim() || null;
    try {
        const r = await window.labs.wallet.generate({ label });
        $('nwResult').innerHTML = `<span class="fg-profit">created</span> · ${r.address}`;
        await refreshWallets();
    } catch (e) {
        $('nwResult').innerHTML = `<span class="fg-danger">${e.message || e}</span>`;
    }
});

// ── Import wallet ───────────────────────────────────────────────────────────
$('iwImport').addEventListener('click', async () => {
    const kind = $('iwKind').value;
    const value = $('iwSecret').value.trim();
    const label = $('iwLabel').value.trim() || null;
    if (!value) { $('iwResult').textContent = 'paste a seed or mnemonic'; return; }
    try {
        const r = await window.labs.wallet.importWallet(kind, value, label);
        $('iwResult').innerHTML = `<span class="fg-profit">imported</span> · ${r.address}`;
        $('iwSecret').value = '';
        await refreshWallets();
    } catch (e) {
        $('iwResult').innerHTML = `<span class="fg-danger">${e.message || e}</span>`;
    }
});

// ── Auto-sign ───────────────────────────────────────────────────────────────
async function refreshAutoSign() {
    state.autoSignRules = await window.labs.autosign.all();
    state.autoSignLog = await window.labs.autosign.log(50);
    // Auto-sign is a Pro feature. Resolve the live entitlement so the pane
    // renders unlocked (Pro+) or visible-but-locked (Free / logged-out).
    try {
        const acct = await window.labs.account.status();
        const u = acct && acct.user;
        const flag = u && u.entitlements && u.entitlements.flags ? u.entitlements.flags.auto_sign : undefined;
        state.autoSignAllowed = (typeof flag === 'boolean') ? flag : !!(u && u.is_pro);
    } catch (_) { state.autoSignAllowed = false; }
    renderAutoSignList();
    renderAutoSignLog();
}

// Shown when the user tries to enable auto-sign — irreversibility + no liability.
// Returns true only if the user explicitly accepts.
function confirmAutoSignEnable(site) {
    return window.confirm(
        'Enable auto-sign for ' + site + '?\n\n' +
        '⚠ One-click / auto-signing submits REAL XRPL transactions from your wallet ' +
        'WITHOUT a per-trade prompt, up to the limits you set.\n\n' +
        'Trades are irreversible. A wrong price, amount, or pair CANNOT be undone, ' +
        'and XRPSync takes no responsibility for transactions you authorize this way.\n\n' +
        'It stays OFF by default and you can disable it at any time. Continue?'
    );
}

function renderAutoSignList() {
    const el = $('asList');
    const rules = state.autoSignRules;
    const sites = Object.keys(rules);
    const allowed = state.autoSignAllowed !== false; // undefined → treat as allowed until resolved

    // Pro gate banner. Free/logged-out users see the pane but locked.
    const lockBanner = allowed ? '' :
        '<div class="card" style="border-color:#3b3f51;margin-bottom:10px">' +
        '<div class="card-b" style="display:flex;align-items:center;gap:10px">' +
        '<span style="font-size:16px">🔒</span>' +
        '<div><div style="font-weight:600">Auto-sign is a Pro feature</div>' +
        '<small class="mut">Upgrade to Pro to enable one-click trading. You can still approve each trade manually.</small></div>' +
        '<button class="btn" data-pane="account-manage" style="margin-left:auto" id="asUpgradeBtn">Upgrade</button>' +
        '</div></div>';

    if (!sites.length) {
        el.innerHTML = lockBanner + '<div class="mut" style="text-align:center;padding:14px;font-size:10px">no sites configured</div>';
        wireAutoSignUpgrade(el);
        return;
    }
    el.innerHTML = lockBanner + sites.map(site => {
        const r = rules[site];
        return `<div class="card" data-site="${site}">
            <div class="card-h"><span class="t">${site}</span>
                <span class="m">
                    <span class="pill ${r.enabled ? 'on' : ''}" style="cursor:pointer;margin-right:6px" data-action="toggle" data-site="${site}">${r.enabled ? 'ENABLED' : 'DISABLED'}</span>
                    <button class="btn ghost" data-action="remove" data-site="${site}" style="padding:2px 8px;font-size:9px">REMOVE</button>
                </span>
            </div>
            <div class="card-b">
                <div class="row" style="gap:14px;flex-wrap:wrap">
                    <div class="field" style="flex:1 1 140px"><label>Allowed types</label><input data-key="allowedTypes" value="${(r.allowedTypes || []).join(', ')}" /></div>
                    <div class="field" style="flex:1 1 140px"><label>Per tx (XRP)</label><input data-key="maxPerTransaction" type="number" value="${r.maxPerTransaction}" /></div>
                    <div class="field" style="flex:1 1 140px"><label>Per day (XRP)</label><input data-key="maxPerDay" type="number" value="${r.maxPerDay}" /></div>
                    <div class="field" style="flex:1 1 140px"><label>Per day (RLUSD)</label><input data-key="maxPerDayRLUSD" type="number" value="${r.maxPerDayRLUSD}" /></div>
                    <div class="field" style="flex:1 1 140px"><label>Allowed pairs</label><input data-key="allowedPairs" value="${(r.allowedPairs || []).join(', ')}" /></div>
                </div>
                <div class="row" style="gap:8px"><button class="btn" data-action="save" data-site="${site}">Save</button><button class="btn ghost" data-action="reset-day" data-site="${site}">Reset daily totals</button></div>
            </div>
        </div>`;
    }).join('');

    el.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', async (e) => {
        e.preventDefault();
        const site = b.dataset.site;
        const action = b.dataset.action;
        const rules = state.autoSignRules[site] || {};
        if (action === 'toggle') {
            const turningOn = !rules.enabled;
            if (turningOn) {
                if (state.autoSignAllowed === false) {
                    window.alert('Auto-sign is a Pro feature. Upgrade to Pro to enable one-click trading.');
                    return;
                }
                if (!confirmAutoSignEnable(site)) return; // irreversibility warning
            }
            rules.enabled = turningOn;
            await window.labs.autosign.set(site, rules);
            await refreshAutoSign();
        } else if (action === 'remove') {
            if (!window.confirm('Remove auto-sign rules for ' + site + '?')) return;
            await window.labs.autosign.remove(site);
            await refreshAutoSign();
        } else if (action === 'save') {
            const card = b.closest('.card');
            const next = { ...rules };
            card.querySelectorAll('[data-key]').forEach(inp => {
                const k = inp.dataset.key;
                if (['maxPerTransaction','maxPerDay','maxPerDayRLUSD'].includes(k)) next[k] = Number(inp.value);
                else next[k] = inp.value.split(',').map(s => s.trim()).filter(Boolean);
            });
            await window.labs.autosign.set(site, next);
            await refreshAutoSign();
        } else if (action === 'reset-day') {
            await window.labs.autosign.resetDay(site);
            await refreshAutoSign();
        }
    }));

    wireAutoSignUpgrade(el);
}

// Bind the "Upgrade" button in the Pro-gate banner to the account pane.
function wireAutoSignUpgrade(el) {
    const btn = el.querySelector('#asUpgradeBtn');
    if (btn) btn.addEventListener('click', () => showPane('account-manage'));
}

function renderAutoSignLog() {
    const tb = $('asLogBody');
    if (!state.autoSignLog.length) { tb.innerHTML = '<tr><td colspan="7" class="mut" style="text-align:center;padding:18px">no auto-signs yet</td></tr>'; return; }
    tb.innerHTML = state.autoSignLog.map(e => `<tr>
        <td class="mut">${new Date(e.ts).toLocaleString()}</td>
        <td>${e.site}</td>
        <td>${e.type || '—'}</td>
        <td>${shortAddr(e.account)}</td>
        <td class="num">${fmtNum(e.amount_xrp, 2)}</td>
        <td class="num">${fmtNum(e.amount_rlusd, 2)}</td>
        <td class="${e.result?.result === 'auto_signed' ? 'fg-profit' : 'fg-danger'}">${e.result?.result || '—'}</td>
    </tr>`).join('');
    $('asLogMeta').textContent = state.autoSignLog.length + ' entries';
}

$('asAddSite').addEventListener('click', async () => {
    const site = $('asNewSite').value.trim();
    if (!site) return;
    await window.labs.autosign.set(site, {});
    $('asNewSite').value = '';
    await refreshAutoSign();
});

// ── Backup ──────────────────────────────────────────────────────────────────
$('bkExport').addEventListener('click', async () => {
    const pw = $('bkPw').value;
    if (!pw || pw.length < 8) { $('bkStatus').textContent = 'min 8 char password'; return; }
    $('bkStatus').textContent = 'exporting…';
    const r = await window.labs.backup.exportAll(pw);
    $('bkStatus').textContent = r.ok ? ('saved → ' + r.path) : ('canceled: ' + (r.reason || ''));
});
$('bkImport').addEventListener('click', async () => {
    const pw = $('bkPwImp').value;
    if (!pw) { $('bkStatus').textContent = 'enter the backup password'; return; }
    $('bkStatus').textContent = 'importing…';
    try {
        const r = await window.labs.backup.importAll(pw);
        $('bkStatus').textContent = r.ok ? ('imported ' + r.imported + ' wallets') : ('canceled: ' + r.reason);
        await refreshWallets();
    } catch (e) {
        $('bkStatus').innerHTML = `<span class="fg-danger">${e.message || e}</span>`;
    }
});

// ── Settings ────────────────────────────────────────────────────────────────
async function refreshSettings() {
    const status = await window.labs.bridge.status();
    if (status.remote?.url) $('setBridgeUrl').value = status.remote.url;
    await refreshPasswordRecoverySettings();
    await refreshSyncSettings();
}

// Password recovery toggle / reveal block
let recRevealTimer = null;
async function refreshPasswordRecoverySettings() {
    const s = await window.labs.settings.getPasswordRecovery();
    const t = $('setRecToggle'), reveal = $('setRecReveal'), meta = $('setRecMeta');
    t.checked = !!s.enabled;
    reveal.disabled = !s.enabled || !s.stored;
    if (!s.keytar_available) {
        t.disabled = true;
        meta.textContent = 'unavailable on this system';
        $('setRecStatus').textContent = 'OS keychain not available — install libsecret on Linux, or use macOS Keychain / Windows Credential Manager.';
        return;
    }
    meta.textContent = s.enabled ? (s.stored ? 'enabled' : 'enabled (no password cached yet)') : 'off';
}

async function setPasswordRecovery(enabled) {
    const status = $('setRecStatus');
    status.textContent = '';
    if (enabled) {
        const pw = await promptModal({ title: 'Enable Password Recovery', message: 'Enter your current master password to enable password recovery:' });
        if (!pw) { $('setRecToggle').checked = false; return; }
        const r = await window.labs.settings.setPasswordRecovery(true, pw);
        if (!r.ok) {
            $('setRecToggle').checked = false;
            status.innerHTML = '<span class="fg-danger">' + (r.error || 'failed') + '</span>';
            return;
        }
        status.innerHTML = '<span class="fg-profit">enabled — your master password is now stored in this device\'s OS keychain</span>';
    } else {
        const r = await window.labs.settings.setPasswordRecovery(false);
        if (!r.ok) status.innerHTML = '<span class="fg-danger">' + (r.error || 'failed') + '</span>';
        else status.textContent = 'disabled — removed from keychain';
    }
    await refreshPasswordRecoverySettings();
}

async function revealMasterPassword() {
    const status = $('setRecStatus');
    status.textContent = 'authenticating…';
    let r = await window.labs.settings.revealMasterPassword();
    if (!r.ok && r.reason === 'prompt_password') {
        // OS prompt isn't available on this platform — verify by master pw re-entry.
        const pw = await promptModal({ title: 'Reveal Master Password', message: 'Re-enter your master password to reveal:' });
        if (!pw) { status.textContent = ''; return; }
        r = await window.labs.settings.revealMasterPassword(pw);
    }
    if (!r.ok) {
        status.innerHTML = '<span class="fg-danger">' + ({
            recovery_disabled: 'password recovery is off',
            keytar_unavailable: 'OS keychain not available on this system',
            no_password_in_keychain: 'no password stored — re-enable recovery to seed it',
            os_auth_failed: 'OS authentication canceled or failed',
            wrong_password: 'wrong password',
        }[r.reason] || r.reason || 'reveal failed') + '</span>';
        return;
    }
    status.textContent = '';
    $('setRecRevealValue').textContent = r.password;
    $('setRecRevealOut').classList.remove('hidden');
    let secs = 30;
    $('setRecRevealTimer').textContent = secs;
    if (recRevealTimer) clearInterval(recRevealTimer);
    recRevealTimer = setInterval(() => {
        secs--;
        if (secs <= 0) { hideRevealedPassword(); return; }
        $('setRecRevealTimer').textContent = secs;
    }, 1000);
}

function hideRevealedPassword() {
    if (recRevealTimer) { clearInterval(recRevealTimer); recRevealTimer = null; }
    $('setRecRevealValue').textContent = '—';
    $('setRecRevealOut').classList.add('hidden');
}

// Cloud sync block
async function refreshSyncSettings() {
    const s = await window.labs.sync.status();
    $('setSyncToggle').checked = !!s.enabled;
    $('setSyncToggle').disabled = !s.logged_in;
    $('setSyncUploadNow').disabled = !s.enabled || !s.logged_in;
    const meta = $('setSyncMeta');
    if (!s.logged_in) meta.textContent = 'log in to enable';
    else if (!s.enabled) meta.textContent = 'off';
    else if (s.has_backup) meta.textContent = 'v' + (s.version || s.last_version || '?') + ' · ' + relTime(s.updated_at || s.last_uploaded_at);
    else meta.textContent = 'enabled · no backup yet';

    const status = $('setSyncStatus');
    if (s.error) status.innerHTML = '<span class="fg-danger">' + s.error + '</span>';
    else if (s.has_backup) status.textContent = 'Cloud backup: v' + s.version + ', uploaded ' + relTime(s.updated_at) + (s.device_label ? ' from ' + s.device_label : '');
    else if (s.enabled) status.textContent = 'Sync enabled — your next wallet change will upload silently.';
    else status.textContent = '';
    updateSyncSidebar(s);
}

function updateSyncSidebar(s) {
    const row = $('syncSidebarRow'), label = $('syncSidebarLabel');
    if (!row || !label) return;
    if (!s.logged_in) { row.style.display = 'none'; return; }
    row.style.display = '';
    if (!s.enabled) { label.innerHTML = '☁ Not synced · <span style="color:var(--term-fg-2)">Enable</span>'; return; }
    if (s.syncing) { label.textContent = '☁ Syncing…'; return; }
    if (s.has_backup) label.textContent = '☁ Synced · v' + (s.version || '?') + ' · ' + relTime(s.updated_at || s.last_uploaded_at);
    else label.textContent = '☁ Enabled · no backup yet';
}

function relTime(iso) {
    if (!iso) return '—';
    const t = new Date(iso).getTime(); if (!t) return '—';
    const diff = Math.max(0, Date.now() - t);
    const m = Math.floor(diff / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' h ago';
    return Math.floor(h / 24) + ' d ago';
}

async function toggleSync(enabled) {
    const status = $('setSyncStatus');
    if (enabled) {
        status.textContent = 'enabling sync — uploading first backup…';
        const r = await window.labs.sync.enable();
        if (!r.ok) {
            $('setSyncToggle').checked = false;
            status.innerHTML = '<span class="fg-danger">' + (r.error || 'enable failed') + '</span>';
            return;
        }
        status.innerHTML = '<span class="fg-profit">cloud sync enabled — backup uploaded</span>';
    } else {
        const deleteRemote = window.confirm('Disable cloud sync.\n\nAlso DELETE the existing backup from the server?\n(If you click Cancel, the server copy stays — useful if you\'re reinstalling.)');
        const r = await window.labs.sync.disable(deleteRemote);
        if (!r.ok) status.innerHTML = '<span class="fg-danger">' + (r.error || 'disable failed') + '</span>';
        else status.textContent = 'cloud sync disabled' + (deleteRemote ? ' · server copy deleted' : ' · server copy retained');
    }
    await refreshSyncSettings();
}

async function syncUploadNow() {
    const status = $('setSyncStatus');
    status.textContent = 'uploading…';
    const r = await window.labs.sync.uploadNow();
    if (!r.ok) status.innerHTML = '<span class="fg-danger">' + (r.error || 'upload failed') + '</span>';
    else status.innerHTML = '<span class="fg-profit">uploaded · v' + r.version + '</span>';
    await refreshSyncSettings();
}

async function syncRestoreFromCloud(password) {
    const status = $('setSyncRestoreStatus');
    status.textContent = 'downloading & decrypting…';
    const r = await window.labs.sync.restoreFromCloud(password);
    if (!r.ok) { status.innerHTML = '<span class="fg-danger">' + (r.error || 'restore failed') + '</span>'; return false; }
    status.innerHTML = '<span class="fg-profit">restored ' + r.imported + ' wallet' + (r.imported === 1 ? '' : 's') + ' from cloud backup</span>';
    await refreshWallets();
    await refreshSyncSettings();
    return true;
}

$('setSave').addEventListener('click', async () => {
    const ms = Number($('setLock').value);
    const r = await window.labs.lock.setTimeout(ms);
    if (r && r.ms) { _lockMs = r.ms; if (_lockTick) startLockCountdown(); }   // re-arm countdown with the new interval
    const url = $('setBridgeUrl').value.trim();
    const tok = $('setBridgeToken').value.trim();
    await window.labs.bridge.configureRemote(url || null, tok || null);
    $('setLock').blur();
    document.body.classList.add('flash-up');
    setTimeout(() => document.body.classList.remove('flash-up'), 320);
});

// Password recovery handlers
$('setRecToggle')?.addEventListener('change', (e) => setPasswordRecovery(e.target.checked));
$('setRecReveal')?.addEventListener('click', () => revealMasterPassword());
$('setRecRevealCopy')?.addEventListener('click', async () => {
    const v = $('setRecRevealValue').textContent;
    if (!v || v === '—') return;
    try { await navigator.clipboard.writeText(v); $('setRecRevealCopy').textContent = 'COPIED'; setTimeout(() => $('setRecRevealCopy').textContent = 'COPY', 1500); } catch (_) {}
});
$('setRecRevealHide')?.addEventListener('click', (e) => { e.preventDefault(); hideRevealedPassword(); });

// Cloud sync handlers
$('setSyncToggle')?.addEventListener('change', (e) => toggleSync(e.target.checked));
$('setSyncUploadNow')?.addEventListener('click', () => syncUploadNow());
$('setSyncRestore')?.addEventListener('click', () => {
    $('setSyncRestoreBlock').classList.remove('hidden');
    $('setSyncRestorePw').value = '';
    $('setSyncRestoreStatus').textContent = '';
    $('setSyncRestorePw').focus();
});
$('setSyncRestoreCancel')?.addEventListener('click', () => $('setSyncRestoreBlock').classList.add('hidden'));
$('setSyncRestoreGo')?.addEventListener('click', async () => {
    const pw = $('setSyncRestorePw').value;
    if (!pw) { $('setSyncRestoreStatus').innerHTML = '<span class="fg-danger">master password required</span>'; return; }
    const ok = await syncRestoreFromCloud(pw);
    if (ok) setTimeout(() => $('setSyncRestoreBlock').classList.add('hidden'), 1500);
});
$('setSyncRestorePw')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('setSyncRestoreGo').click(); });

// Live sync indicator from main
window.labs.on.syncUpdated(async (payload) => {
    if (payload?.syncing) {
        updateSyncSidebar({ logged_in: true, enabled: true, syncing: true });
        return;
    }
    // Always re-fetch to keep the meta fresh (size, version, etc.)
    await refreshSyncSettings();
});

// ── Status bar ──────────────────────────────────────────────────────────────
async function refreshStatus() {
    try {
        const info = await window.labs.xrpl.serverInfo();
        const ok = info && info.complete_ledgers;
        $('netDot').className = 'dot' + (ok ? ' on' : ' warn');
        $('netLabel').textContent = ok ? 'mainnet · L' + (info.validated_ledger?.seq || '?') : 'connecting…';
    } catch (_) {
        $('netDot').className = 'dot warn';
        $('netLabel').textContent = 'offline';
    }
    try {
        const b = await window.labs.bridge.status();
        const lstn = b.local?.listening, conn = b.local?.connections || 0;
        $('bridgeDot').className = 'dot' + (lstn ? (conn ? ' on' : ' warn') : '');
        $('bridgeLabel').textContent = `bridge: ${lstn ? (conn ? conn + ' connected' : 'listening') : 'idle'}`;
    } catch (_) {}
}

window.labs.on.autoSigned((p) => {
    document.body.classList.add('flash-up');
    setTimeout(() => document.body.classList.remove('flash-up'), 320);
    if (state.pane === 'auto-sign') refreshAutoSign();
});

// ── XRPSync account ────────────────────────────────────────────────────────────
const account = {
    state: { user: null, subscription: null, pendingTier: null, pendingInitiate: null },

    async boot() {
        const s = await window.labs.account.status();
        this.state.user = s.user;
        this.renderSidebar();
        if (s.logged_in) {
            // Confirm token still works — also picks up any tier change since last open.
            const r = await window.labs.account.refresh().catch(() => ({ ok: false }));
            if (r.ok) this.state.user = r.user;
            else { this.state.user = null; }
            this.renderSidebar();
        }
    },

    renderSidebar() {
        const out = $('acctSidebarOut'), inn = $('acctSidebarIn');
        if (!out || !inn) return;
        if (!this.state.user) {
            out.classList.remove('hidden');
            inn.classList.add('hidden');
            return;
        }
        out.classList.add('hidden');
        inn.classList.remove('hidden');
        const u = this.state.user;
        $('acctSidebarName').textContent = u.name || u.email || '—';
        const tierEl = $('acctSidebarTier');
        tierEl.textContent = (u.tier || 'free').toUpperCase();
        tierEl.classList.remove('is-pro', 'is-growth');
        if (u.tier === 'pro') tierEl.classList.add('is-pro');
        if (u.tier === 'growth') tierEl.classList.add('is-growth');
        let meta = u.tier === 'free' ? 'Free tier' : null;
        if (!meta && u.expires_at) {
            const d = new Date(u.expires_at);
            meta = 'Expires ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
        $('acctSidebarMeta').textContent = meta || '—';
        try { document.title = 'XRPSync Wallet — ' + (u.name || u.email) + (u.tier !== 'free' ? ' [' + u.tier.toUpperCase() + ']' : ''); } catch (_) {}
    },

    async login() {
        const email = $('acctEmail').value.trim();
        const pw = $('acctPassword').value;
        if (!email || !pw) { $('acctLoginStatus').innerHTML = '<span class="fg-danger">fill both fields</span>'; return; }
        $('acctLoginStatus').textContent = 'authenticating…';
        const r = await window.labs.account.login(email, pw, { walletAddress: state.activeAddress });
        if (!r.ok) {
            $('acctLoginStatus').innerHTML = '<span class="fg-danger">' + (r.error || 'login failed') + '</span>';
            return;
        }
        this.state.user = r.user;
        $('acctPassword').value = '';
        $('acctLoginStatus').innerHTML = '<span class="fg-profit">welcome, ' + (r.user.name || r.user.email) + '</span>';
        this.renderSidebar();
        // New-device prompt: if there's a server-side backup and local has no
        // wallets yet, offer to restore. Non-blocking — settles into the manage
        // pane regardless of choice.
        await maybeOfferCloudRestore();
        await refreshSyncSettings();
        setTimeout(() => showPane('account-manage'), 600);
    },

    async logout() {
        if (!window.confirm('Log out of your XRPSync account on this device?')) return;
        await window.labs.account.logout();
        this.state.user = null;
        this.state.subscription = null;
        this.renderSidebar();
        showPane('account-login');
    },

    async openManage() {
        await this.refresh();
    },

    async refresh() {
        const r = await window.labs.account.subscription();
        if (!r || !r.ok) {
            $('acctManageMeta').textContent = (r && r.error) || 'fetch failed';
            return;
        }
        this.state.subscription = r;
        const u = r.user;
        this.state.user = u;
        this.renderSidebar();

        $('acctName').textContent = u.name || '—';
        $('acctEmailDisp').textContent = u.email || '—';
        $('acctLinked').textContent = u.linked_wallet ? (u.linked_wallet.slice(0,6) + '…' + u.linked_wallet.slice(-4)) : 'not linked';

        const active = r.active;
        $('acctSubMeta').textContent = active ? (active.tier_slug.toUpperCase() + ' · expires ' + new Date(active.expires_at).toLocaleDateString()) : 'free';
        $('acctCurrentTier').textContent = (u.tier || 'free').toUpperCase();

        // Render tier cards
        const grid = $('acctTierGrid');
        grid.innerHTML = '';
        (r.tiers || []).forEach(t => {
            const isCurrent = t.slug === u.tier;
            const isRecommended = t.slug === 'pro' && !isCurrent;
            const isPaid = (+t.price_xrp) > 0;
            const usd = r.xrp_usd ? (t.price_xrp * r.xrp_usd) : (t.price_usd || 0);
            const feats = (t.features || {});
            const include = [
                feats.bot_detection && 'Bot Detection',
                feats.wall_tracker && 'Wall Tracking',
                feats.external_prices && 'External Prices',
                feats.momentum && 'Momentum',
                feats.auto_sign && 'Auto-Sign',
                feats.priority_alerts && 'Priority Alerts',
                feats.bot_alerts && 'Bot Alerts',
            ].filter(Boolean);
            const featsHtml = t.slug === 'free'
                ? '<li>XRP News</li><li>Ecosystem Map</li><li>Community</li><li>Full Chart</li><li>Full Orderbook</li><li>XRPSync Wallet</li><li>Manual Trade</li>'
                : (t.slug === 'pro'
                    ? '<li>Everything Free +</li>' + include.slice(0,4).map(f => `<li>${f}</li>`).join('')
                    : '<li>Everything Pro +</li>' + include.slice(4).map(f => `<li>${f}</li>`).join(''));

            const ribbon = isCurrent ? 'Current' : (isRecommended ? 'Recommended' : '');
            const ctaLabel = isCurrent ? 'Current plan' : (isPaid ? `Pay ${t.price_xrp} XRP` : 'Free');
            const ctaAttrs = isCurrent
                ? 'disabled'
                : (isPaid ? `data-upgrade="${t.slug}" data-xrp="${t.price_xrp}"` : 'disabled');

            const card = document.createElement('div');
            card.className = 'acct-tier-card' + (isCurrent ? ' is-current' : '') + (isRecommended ? ' is-recommended' : '');
            card.innerHTML = `
                ${ribbon ? `<span class="ribbon">${ribbon}</span>` : ''}
                <div class="name">${t.name}</div>
                <div class="price">${isPaid ? t.price_xrp + ' <small>XRP/mo</small>' : 'Free'}</div>
                ${isPaid ? `<div class="usd">≈ $${usd.toFixed(2)}/mo</div>` : '<div class="usd">forever</div>'}
                <ul>${featsHtml}</ul>
                <button class="cta" type="button" ${ctaAttrs}>${ctaLabel}</button>
            `;
            const btn = card.querySelector('button[data-upgrade]');
            if (btn) btn.addEventListener('click', () => this.beginUpgrade(t.slug, t.price_xrp));
            grid.appendChild(card);
        });

        // Payment history
        const tb = $('acctPayBody');
        if (!r.payments || !r.payments.length) {
            tb.innerHTML = '<tr><td colspan="5" class="mut" style="text-align:center;padding:18px">no payments yet</td></tr>';
            $('acctPayMeta').textContent = '—';
        } else {
            tb.innerHTML = r.payments.map(p => {
                const d = p.confirmed_at || p.created_at;
                const status = p.status === 'applied' || p.status === 'confirmed'
                    ? '<span class="fg-profit">' + p.status + '</span>'
                    : (p.status === 'invalid' ? '<span class="fg-danger">invalid</span>' : '<span class="mut">' + p.status + '</span>');
                const tx = p.tx_hash ? p.tx_hash.slice(0,10) + '…' : '—';
                const amt = p.amount_xrp != null ? Number(p.amount_xrp).toFixed(4) + ' XRP' : '—';
                return `<tr><td>${d ? new Date(d).toLocaleString() : '—'}</td><td>${p.tier_slug.toUpperCase()}</td><td class="num">${amt}</td><td>${status}</td><td class="mut">${tx}</td></tr>`;
            }).join('');
            $('acctPayMeta').textContent = r.payments.length + ' total';
        }

        // If a tier change just happened, clear the upgrade block.
        $('acctUpgradeBlock').classList.add('hidden');
    },

    async beginUpgrade(tierSlug, xrp) {
        if (!state.activeAddress) {
            alert('Open a wallet first — that\'s the address the payment will come from.');
            return;
        }
        $('acctUpgradeTitle').textContent = 'UPGRADE TO ' + tierSlug.toUpperCase();
        $('acctPayAmount').textContent = xrp + ' XRP';
        $('acctPayFrom').textContent = state.activeAddress;
        $('acctPayTo').textContent = '— (computed by server)';
        $('acctPayMemo').textContent = 'labs_sub:' + tierSlug + ':…';
        $('acctPayPw').value = '';
        $('acctPayStatus').textContent = '';
        $('acctUpgradeBlock').classList.remove('hidden');
        this.state.pendingTier = tierSlug;
        $('acctUpgradeBlock').scrollIntoView({ behavior: 'smooth', block: 'center' });
    },

    cancelUpgrade() {
        $('acctUpgradeBlock').classList.add('hidden');
        this.state.pendingTier = null;
    },

    async confirmUpgrade() {
        const tierSlug = this.state.pendingTier;
        if (!tierSlug) return;
        const password = $('acctPayPw').value;
        if (!password) { $('acctPayStatus').innerHTML = '<span class="fg-danger">master password required</span>'; return; }

        $('acctPayStatus').textContent = 'signing & submitting to XRPL…';
        $('acctPayConfirm').disabled = true;
        try {
            const r = await window.labs.account.upgrade(tierSlug, state.activeAddress, password);
            if (r && r.tx_hash) {
                const link = `<a href="https://livenet.xrpl.org/transactions/${r.tx_hash}" target="_blank">${r.tx_hash.slice(0,12)}…</a>`;
                if (r.verified) {
                    $('acctPayStatus').innerHTML = `<span class="fg-profit">✓ ${r.tier.toUpperCase()} active until ${new Date(r.expires_at).toLocaleDateString()} — tx ${link}</span>`;
                } else {
                    $('acctPayStatus').innerHTML = `<span class="fg-warn">submitted to XRPL — server will confirm shortly · tx ${link}</span>`;
                }
                $('acctPayPw').value = '';
                this.state.pendingTier = null;
                // Refresh the manage pane so payment history + tier badge update.
                setTimeout(() => this.refresh(), 1500);
            } else {
                $('acctPayStatus').innerHTML = '<span class="fg-danger">no tx hash returned</span>';
            }
        } catch (e) {
            $('acctPayStatus').innerHTML = '<span class="fg-danger">' + (e?.message || e) + '</span>';
        } finally {
            $('acctPayConfirm').disabled = false;
        }
    },
};

async function refreshAccountManage() {
    await account.openManage();
}

async function maybeOfferCloudRestore() {
    let s;
    try { s = await window.labs.sync.status(); }
    catch (_) { return; }
    if (!s.has_backup) return;
    const localCount = (await window.labs.wallet.list()).length;
    if (localCount > 0) return;
    const pw = await promptModal({ title: 'Restore From Cloud', message: 'A wallet backup was found on your XRPSync account.\n\nEnter the master password used when it was created to restore your wallets:' });
    if (!pw) return;
    const r = await window.labs.sync.restoreFromCloud(pw);
    if (r.ok) window.alert('Restored ' + r.imported + ' wallet' + (r.imported === 1 ? '' : 's') + ' from cloud backup.');
    else window.alert('Restore failed: ' + (r.error || 'unknown'));
}

$('acctLoginBtn')?.addEventListener('click', () => account.login());
$('acctPassword')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') account.login(); });
$('acctEmail')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('acctPassword').focus(); });
$('acctRegisterBtn')?.addEventListener('click', () => { try { window.open('https://xrpsync.com/register', '_blank'); } catch (_) {} });
$('acctLogoutBtn')?.addEventListener('click', () => account.logout());
$('acctRefreshBtn')?.addEventListener('click', () => account.refresh());
$('acctPayCancel')?.addEventListener('click', () => account.cancelUpgrade());
$('acctPayConfirm')?.addEventListener('click', () => account.confirmUpgrade());
$('acctPayPw')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') account.confirmUpgrade(); });

// ── Boot ────────────────────────────────────────────────────────────────────
async function refreshAll() {
    await refreshWallets();
    if (state.wallets.length && !state.activeAddress) {
        state.activeAddress = state.wallets[0].address;
        await openWallet(state.activeAddress);
    }
    refreshStatus();
    account.boot().then(() => refreshSyncSettings().catch(() => {}));
}

bootLockState();

// Surface build identity in the footer so the running binary is identifiable.
window.labs.appInfo().then((info) => {
    const f = $('footMeta');
    if (f && info && info.version) f.textContent = 'v' + info.version + ' · build ' + (info.build || '?');
}).catch(() => {});
setInterval(refreshStatus, 15_000);

// ── Auto-update pill ──────────────────────────────────────────────────────────
// Main checks silently and emits ui:update events. Pill states:
//   available → click to download · downloading → progress · ready → click to restart.
// Lets the user update in-place instead of uninstall/reinstall.
(function initUpdatePill() {
    const pill = $('updatePill');
    if (!pill) return;
    let st = 'idle'; // idle | available | downloading | ready | error

    const show = (text, bg) => { pill.textContent = text; pill.style.background = bg || '#1652f0'; pill.style.display = ''; };
    const hide = () => { pill.style.display = 'none'; };

    window.labs.on.update((p) => {
        if (!p) return;
        if (p.type === 'available')      { st = 'available';   show('⬆ Update' + (p.version ? ' v' + p.version : '') + ' — click to install'); }
        else if (p.type === 'progress')  { st = 'downloading'; show('Downloading… ' + (p.percent || 0) + '%', '#3b3f51'); }
        else if (p.type === 'ready')     { st = 'ready';       show('✔ Update ready — click to restart', '#16a34a'); }
        else if (p.type === 'error')     { if (st !== 'idle') { st = 'error'; show('Update failed — click to retry', '#b91c1c'); } }
        // 'none' → leave whatever is showing (usually nothing)
    });

    pill.addEventListener('click', async () => {
        if (st === 'available') {
            st = 'downloading'; show('Downloading… 0%', '#3b3f51');
            const r = await window.labs.update.download();
            if (!r || !r.ok) { st = 'error'; show('Download failed — click to retry', '#b91c1c'); }
        } else if (st === 'ready') {
            await window.labs.update.install(); // quits + relaunches into the new version
        } else if (st === 'error' || st === 'idle') {
            st = 'idle'; show('Checking…', '#3b3f51');
            const r = await window.labs.update.check();
            if (!r || !r.ok || !r.version) hide();
        }
    });
})();

// ── Receive QR ──────────────────────────────────────────────────────────────
// QR is generated in main (qrcode npm package) and returned as a PNG data URL.
// We paint that onto the existing #qrCanvas so the brief's canvas-based UX is
// preserved without bundling a UMD QR lib for the renderer.
function closeQrModalIfOpen() {
    const overlay = $('qrModal');
    if (overlay && overlay.classList.contains('is-open')) overlay.classList.remove('is-open');
}

function clearQrCanvas() {
    const canvas = $('qrCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

async function openQrModal() {
    const address = state.activeAddress;
    if (!address) return;
    $('qrAddr').textContent = address;       // exact case — never uppercase
    $('qrErr').textContent = '';
    clearQrCanvas();
    $('qrModal').classList.add('is-open');
    try {
        const dataUrl = await window.labs.xrpl.qr(address);
        // The active wallet may have changed while the IPC was in flight.
        if (state.activeAddress !== address) return;
        await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = $('qrCanvas');
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve();
            };
            img.onerror = () => reject(new Error('image_decode_failed'));
            img.src = dataUrl;
        });
    } catch (e) {
        $('qrErr').textContent = 'QR generation failed: ' + ((e && e.message) || e) + ' — address shown below is still valid';
    }
}

$('wQrBtn')?.addEventListener('click', openQrModal);
$('qrCloseBtn')?.addEventListener('click', closeQrModalIfOpen);

$('qrCopyBtn')?.addEventListener('click', async () => {
    const address = $('qrAddr').textContent;
    if (!address || address === '—') return;
    const btn = $('qrCopyBtn');
    const original = btn.textContent;
    try {
        await navigator.clipboard.writeText(address);
        btn.textContent = 'Copied!';
    } catch (_) {
        btn.textContent = 'Copy failed';
    }
    setTimeout(() => { btn.textContent = original; }, 1200);
});

// Escape closes the modal — mirrors the trustline / transfer modals' UX.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('qrModal')?.classList.contains('is-open')) {
        e.preventDefault();
        closeQrModalIfOpen();
    }
});
