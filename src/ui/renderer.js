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
        $('lockMode').textContent = 'Welcome — set a master password to encrypt your wallets';
        $('lockSubmit').textContent = 'Set password';
        $('lockConfirmField').classList.remove('hidden');
    }
    if (s.locked) {
        $('lockOverlay').classList.add('is-open');
    }
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
    };
    const el = $(map[name] || 'paneWelcome');
    if (el) el.classList.remove('hidden');
    document.querySelectorAll('.lw-side .item').forEach(i => i.classList.toggle('is-active', i.dataset.pane === name));
}

document.querySelectorAll('.lw-side .item').forEach(i => i.addEventListener('click', () => {
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

// ── Boot ────────────────────────────────────────────────────────────────────
async function refreshAll() {
    await refreshWallets();
    if (state.wallets.length && !state.activeAddress) {
        state.activeAddress = state.wallets[0].address;
        await openWallet(state.activeAddress);
    }
    refreshStatus();
}

bootLockState();
setInterval(refreshStatus, 15_000);
