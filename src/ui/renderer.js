// renderer.js — UI logic for the main wallet window. Talks to main only via window.labs.*

'use strict';

// ── State ───────────────────────────────────────────────────────────────────
const state = {
    wallets: [],
    activeAddress: null,
    pane: 'welcome',
    autoSignRules: {},
    autoSignLog: [],
};

const $ = (id) => document.getElementById(id);
const fmtNum = (n, d = 2) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const shortAddr = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';

// ── Lock screen ─────────────────────────────────────────────────────────────
async function bootLockState() {
    const s = await window.labs.lock.status();
    if (!s.hasMaster) {
        // Brand-new install → auto-generate the master password and walk the
        // user through saving it. We don't ever expose the legacy "type your
        // own password" form on a fresh install — eliminating weak passwords.
        await startFirstLaunchFlow();
        return;
    }
    if (s.locked) {
        $('lockOverlay').classList.add('is-open');
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
            if (!r.ok) { $('lockErr').textContent = 'wrong password'; return; }
        }
        $('lockOverlay').classList.remove('is-open');
        $('lockPw').value = ''; $('lockPwConfirm').value = '';
        await refreshAll();
    } catch (e) { $('lockErr').textContent = String(e.message || e); }
});

$('lockPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lockSubmit').click(); });
$('lockPwConfirm')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lockSubmit').click(); });

$('lockBtn').addEventListener('click', async () => {
    await window.labs.lock.lockNow();
    $('lockOverlay').classList.add('is-open');
});

window.labs.on.locked(() => {
    $('lockOverlay').classList.add('is-open');
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
        return;
    }
    state.wallets.forEach(w => {
        const item = document.createElement('div');
        item.className = 'item' + (w.address === state.activeAddress ? ' is-active' : '');
        item.innerHTML = `<div>${w.label || 'Wallet'}</div><small class="mut">${shortAddr(w.address)}</small>`;
        item.addEventListener('click', () => { state.activeAddress = w.address; openWallet(w.address); refreshWallets(); });
        el.appendChild(item);
    });
}

async function openWallet(address) {
    showPane('wallet');
    const w = state.wallets.find(x => x.address === address);
    $('wDetailLabel').textContent = (w?.label || 'Wallet');
    $('wDetailAddr').textContent = address;
    $('wXrp').textContent = '…';
    $('wRlusd').textContent = '…';
    $('wTxBody').innerHTML = '<tr><td colspan="6" class="mut" style="text-align:center;padding:18px">loading…</td></tr>';
    $('wTrBody').innerHTML = '<tr><td colspan="4" class="mut" style="text-align:center;padding:18px">loading…</td></tr>';

    try {
        const bal = await window.labs.xrpl.balances(address);
        $('wXrp').textContent = fmtNum(bal.xrp, 2);
        const rlusd = (bal.tokens || []).find(t => t.currency === 'RLUSD');
        $('wRlusd').textContent = rlusd ? fmtNum(rlusd.value, 4) : '—';
    } catch (e) {
        $('wXrp').textContent = '!';
        $('wRlusd').textContent = '!';
    }

    try {
        const h = await window.labs.xrpl.history(address, 30);
        const tb = $('wTxBody');
        if (!h.txs.length) { tb.innerHTML = '<tr><td colspan="6" class="mut" style="text-align:center;padding:18px">no recent activity</td></tr>'; }
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
        $('wTxBody').innerHTML = '<tr><td colspan="6" class="fg-danger" style="text-align:center;padding:18px">failed to load</td></tr>';
    }

    try {
        const lines = await window.labs.xrpl.trustlines(address);
        const tb = $('wTrBody');
        if (!lines.length) { tb.innerHTML = '<tr><td colspan="4" class="mut" style="text-align:center;padding:18px">no trustlines</td></tr>'; }
        else {
            tb.innerHTML = lines.map(l => `<tr>
                <td>${l.currency}</td>
                <td>${shortAddr(l.issuer)}</td>
                <td class="num">${l.balance}</td>
                <td class="num">${l.limit}</td>
            </tr>`).join('');
        }
        $('wTrMeta').textContent = lines.length + ' lines';
    } catch (_) {
        $('wTrBody').innerHTML = '<tr><td colspan="4" class="fg-danger" style="text-align:center;padding:18px">failed to load</td></tr>';
    }
}

$('wRefresh').addEventListener('click', () => { if (state.activeAddress) openWallet(state.activeAddress); });

$('wRevealBtn').addEventListener('click', async () => {
    if (!state.activeAddress) return;
    const pw = window.prompt('Re-enter master password to reveal seed:');
    if (!pw) return;
    try {
        const seed = await window.labs.wallet.revealSecret(state.activeAddress, pw);
        const ok = window.confirm('SHOW SEED?\n\nAnyone with this seed can spend your wallet.\nClick OK only if you are alone.');
        if (ok) window.alert('Seed:\n\n' + seed);
    } catch (e) { window.alert('Reveal failed: ' + (e.message || 'unknown')); }
});

$('wDeleteBtn').addEventListener('click', async () => {
    if (!state.activeAddress) return;
    const conf = window.prompt('Type DELETE to remove this wallet from the device:');
    if (conf !== 'DELETE') return;
    await window.labs.wallet.deleteWallet(state.activeAddress, 'DELETE');
    state.activeAddress = null;
    await refreshWallets();
    showPane('welcome');
});

$('wSendBtn').addEventListener('click', () => {
    if (!state.activeAddress) return;
    $('sndFrom').textContent = shortAddr(state.activeAddress);
    $('sndResult').textContent = '';
    $('sndTo').value = ''; $('sndAmt').value = ''; $('sndTag').value = ''; $('sndPw').value = '';
    showPane('send');
});

// Fund Wallet — open lab.kyopsec.com/buy-xrp in the default browser with the
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
    renderAutoSignList();
    renderAutoSignLog();
}

function renderAutoSignList() {
    const el = $('asList');
    const rules = state.autoSignRules;
    const sites = Object.keys(rules);
    if (!sites.length) {
        el.innerHTML = '<div class="mut" style="text-align:center;padding:14px;font-size:10px">no sites configured</div>';
        return;
    }
    el.innerHTML = sites.map(site => {
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
            rules.enabled = !rules.enabled;
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
        const pw = window.prompt('Enter your current master password to enable password recovery:');
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
        const pw = window.prompt('Re-enter your master password to reveal:');
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
    await window.labs.lock.setTimeout(ms);
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

// ── Labs account ────────────────────────────────────────────────────────────
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
        try { document.title = 'Labs Wallet — ' + (u.name || u.email) + (u.tier !== 'free' ? ' [' + u.tier.toUpperCase() + ']' : ''); } catch (_) {}
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
        if (!window.confirm('Log out of your Labs account on this device?')) return;
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
                feats.growth_engine && 'Growth Engine',
                feats.auto_sign && 'Auto-Sign',
                feats.priority_alerts && 'Priority Alerts',
                feats.bot_alerts && 'Bot Alerts',
            ].filter(Boolean);
            const featsHtml = t.slug === 'free'
                ? '<li>XRP News</li><li>Ecosystem Map</li><li>Community</li><li>Full Chart</li><li>Full Orderbook</li><li>Labs Wallet</li><li>Manual Trade</li>'
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
    const pw = window.prompt('A wallet backup was found on your Labs account.\n\nEnter the master password used when it was created to restore your wallets:');
    if (!pw) return;
    const r = await window.labs.sync.restoreFromCloud(pw);
    if (r.ok) window.alert('Restored ' + r.imported + ' wallet' + (r.imported === 1 ? '' : 's') + ' from cloud backup.');
    else window.alert('Restore failed: ' + (r.error || 'unknown'));
}

$('acctLoginBtn')?.addEventListener('click', () => account.login());
$('acctPassword')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') account.login(); });
$('acctEmail')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('acctPassword').focus(); });
$('acctRegisterBtn')?.addEventListener('click', () => { try { window.open('https://lab.kyopsec.com/register', '_blank'); } catch (_) {} });
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
setInterval(refreshStatus, 15_000);
