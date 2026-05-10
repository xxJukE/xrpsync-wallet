// Labs Wallet — Electron main process.
// Owns BrowserWindow, IPC handlers, and the local site bridge.
// All cryptographic operations happen in the main process via the modules in src/wallet/.
// The renderer (UI) speaks to main only through the contextBridge API exposed in preload.js.

'use strict';

const { app, BrowserWindow, ipcMain, Menu, dialog, shell, Tray, nativeImage } = require('electron');
const path = require('path');

// Defer requires that touch electron-store / xrpl until after app.whenReady to keep startup snappy.
let WalletStore, WalletGenerate, WalletImport, WalletSign, WalletBackup, AutoSign;
let XrplConnection, XrplBalances, XrplHistory, XrplTrustlines, XrplSubmit;
let BridgeServer, BridgeRemote, BridgeProtocol;

let mainWindow = null;
let approvalWindow = null;
let tray = null;
let lockTimer = null;
let isLocked = true;

// User-tunable lock timeout (ms). Default 5 minutes. Persisted via WalletStore.
let lockMs = 5 * 60 * 1000;

const isDev = !app.isPackaged;

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 820,
        minWidth: 960,
        minHeight: 640,
        backgroundColor: '#0a0e14',
        title: 'Labs Wallet',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    mainWindow.loadFile(path.join(__dirname, 'src', 'ui', 'index.html'));
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

function buildMenu() {
    const tpl = [
        {
            label: 'Wallet',
            submenu: [
                { label: 'Lock now', accelerator: 'CmdOrCtrl+L', click: () => lockApp() },
                { type: 'separator' },
                { label: 'New Wallet…', accelerator: 'CmdOrCtrl+N', click: () => mainWindow?.webContents.send('ui:nav', 'new-wallet') },
                { label: 'Import Wallet…', accelerator: 'CmdOrCtrl+I', click: () => mainWindow?.webContents.send('ui:nav', 'import-wallet') },
                { label: 'Backup…', click: () => mainWindow?.webContents.send('ui:nav', 'backup') },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
            ],
        },
        {
            label: 'Help',
            submenu: [
                { label: 'About Labs Wallet', click: () => dialog.showMessageBox(mainWindow, { title: 'Labs Wallet', message: 'Labs Wallet ' + app.getVersion(), detail: 'XRPL desktop wallet · keys never leave your device.' }) },
                { label: 'Open data folder', click: () => shell.showItemInFolder(app.getPath('userData')) },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ── App lock state ──────────────────────────────────────────────────────────
function resetLockTimer() {
    if (lockTimer) clearTimeout(lockTimer);
    if (isLocked) return;
    lockTimer = setTimeout(() => lockApp(), lockMs);
}
function lockApp() {
    isLocked = true;
    WalletStore?.lock();
    if (mainWindow) mainWindow.webContents.send('ui:locked');
    if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
}
function noteActivity() { if (!isLocked) resetLockTimer(); }

// ── Lifecycle ───────────────────────────────────────────────────────────────
app.whenReady().then(() => {
    // Lazy-load heavy modules now that Electron is ready.
    WalletStore     = require('./src/wallet/storage');
    WalletGenerate  = require('./src/wallet/generate');
    WalletImport    = require('./src/wallet/import');
    WalletSign      = require('./src/wallet/sign');
    WalletBackup    = require('./src/wallet/backup');
    AutoSign        = require('./src/wallet/auto-sign');
    XrplConnection  = require('./src/xrpl/connection');
    XrplBalances    = require('./src/xrpl/balances');
    XrplHistory     = require('./src/xrpl/history');
    XrplTrustlines  = require('./src/xrpl/trustlines');
    XrplSubmit      = require('./src/xrpl/submit');
    BridgeServer    = require('./src/bridge/server');
    BridgeRemote    = require('./src/bridge/remote');
    BridgeProtocol  = require('./src/bridge/protocol');

    WalletStore.init({ name: 'labs-wallet-data' });
    lockMs = (WalletStore.getPref('lock_ms') || 5 * 60 * 1000);

    createMainWindow();
    buildMenu();
    registerIpc();
    startBridges();

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { try { BridgeServer?.stop(); BridgeRemote?.disconnect(); XrplConnection?.disconnect(); } catch (_) {} });

// ── IPC handlers ────────────────────────────────────────────────────────────
function registerIpc() {
    // Lock state
    ipcMain.handle('lock:status', () => ({ locked: isLocked, hasMaster: WalletStore.hasMasterPassword() }));
    ipcMain.handle('lock:set-master', async (_e, password) => {
        await WalletStore.setMasterPassword(password);
        isLocked = false;
        resetLockTimer();
        BridgeServer?.broadcastWalletInfo();
        return { ok: true };
    });
    ipcMain.handle('lock:unlock', async (_e, password) => {
        const ok = await WalletStore.unlock(password);
        if (ok) { isLocked = false; resetLockTimer(); BridgeServer?.broadcastWalletInfo(); }
        return { ok };
    });
    ipcMain.handle('lock:lock', () => { lockApp(); return { ok: true }; });
    ipcMain.handle('lock:set-timeout', (_e, ms) => { lockMs = Math.max(30_000, Number(ms) || 300_000); WalletStore.setPref('lock_ms', lockMs); resetLockTimer(); return { ok: true, ms: lockMs }; });
    ipcMain.on('activity', noteActivity);

    // Wallet management
    ipcMain.handle('wallet:list', () => WalletStore.listWallets());
    ipcMain.handle('wallet:generate', async (_e, opts) => {
        ensureUnlocked();
        const w = WalletGenerate.create();
        await WalletStore.saveWallet(w, (opts && opts.label) || null);
        return { address: w.address, classicAddress: w.classicAddress };
    });
    ipcMain.handle('wallet:import', async (_e, { kind, value, label }) => {
        ensureUnlocked();
        const w = WalletImport.fromInput(kind, value);
        await WalletStore.saveWallet(w, label || null);
        return { address: w.address };
    });
    ipcMain.handle('wallet:rename', async (_e, { address, label }) => { ensureUnlocked(); WalletStore.renameWallet(address, label); return { ok: true }; });
    ipcMain.handle('wallet:reveal-secret', async (_e, { address, password }) => {
        ensureUnlocked();
        return WalletStore.revealSecret(address, password);
    });
    ipcMain.handle('wallet:delete', async (_e, { address, confirm }) => {
        ensureUnlocked();
        if (confirm !== 'DELETE') throw new Error('confirmation_required');
        WalletStore.deleteWallet(address);
        return { ok: true };
    });

    // Backup / restore
    ipcMain.handle('backup:export', async (_e, { password }) => {
        ensureUnlocked();
        const blob = await WalletBackup.exportAll(password);
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
            title: 'Save Labs Wallet backup',
            defaultPath: `labs-wallet-backup-${new Date().toISOString().slice(0,10)}.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (canceled || !filePath) return { ok: false, reason: 'canceled' };
        require('fs').writeFileSync(filePath, blob);
        return { ok: true, path: filePath };
    });
    ipcMain.handle('backup:import', async (_e, { password }) => {
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
            title: 'Open Labs Wallet backup',
            filters: [{ name: 'JSON', extensions: ['json'] }],
            properties: ['openFile'],
        });
        if (canceled || !filePaths.length) return { ok: false, reason: 'canceled' };
        const blob = require('fs').readFileSync(filePaths[0], 'utf8');
        const count = await WalletBackup.importAll(blob, password);
        return { ok: true, imported: count };
    });

    // XRPL queries (read-only — no signing here)
    ipcMain.handle('xrpl:balances', async (_e, address) => XrplBalances.fetch(address));
    ipcMain.handle('xrpl:history',  async (_e, { address, limit }) => XrplHistory.fetch(address, limit || 50));
    ipcMain.handle('xrpl:trustlines', async (_e, address) => XrplTrustlines.fetch(address));
    ipcMain.handle('xrpl:server-info', async () => XrplConnection.serverInfo());

    // Manual sign + submit (user-initiated, e.g. "Send Payment" form in UI)
    ipcMain.handle('xrpl:sign-and-submit', async (_e, { address, transaction, password }) => {
        ensureUnlocked();
        const seed = await WalletStore.revealSecret(address, password);
        const prepared = await XrplConnection.autofill(transaction);
        const signed = WalletSign.sign(seed, prepared);
        const result = await XrplSubmit.submitSignedBlob(signed.tx_blob);
        return { hash: signed.hash, result };
    });

    // Auto-sign rules
    ipcMain.handle('autosign:rules', () => AutoSign.getAllRules());
    ipcMain.handle('autosign:set', (_e, { site, rules }) => AutoSign.setRules(site, rules));
    ipcMain.handle('autosign:remove', (_e, { site }) => AutoSign.removeRules(site));
    ipcMain.handle('autosign:log', (_e, { limit }) => AutoSign.recentLog(limit || 100));
    ipcMain.handle('autosign:reset-day', (_e, { site }) => AutoSign.resetDailyTotals(site));

    // Bridge state
    ipcMain.handle('bridge:status', () => ({
        local: BridgeServer.status(),
        remote: BridgeRemote.status(),
    }));
    ipcMain.handle('bridge:configure-remote', (_e, { url, token }) => BridgeRemote.configure({ url, token }));

    // Approval flow — UI calls back into main with the user's decision
    ipcMain.handle('approval:respond', async (_e, { id, approved, password, allWalletsAddress }) => {
        await BridgeProtocol.handleApproval({
            id,
            approved,
            password,
            address: allWalletsAddress,
            sign: WalletSign,
            store: WalletStore,
            xrpl: XrplConnection,
        });
        return { ok: true };
    });
}

function ensureUnlocked() {
    if (isLocked) {
        const e = new Error('app_locked'); e.code = 'LOCKED'; throw e;
    }
    noteActivity();
}

// ── Bridges ─────────────────────────────────────────────────────────────────
function startBridges() {
    // Local WS server (browser → wallet) on 127.0.0.1
    BridgeServer.start({
        port: 17760,
        onSignRequest: (req) => onSignRequest(req, 'local'),
        getWalletInfoSync: getWalletInfoSync,
        getBalances:        getWalletBalances,
    });

    // Remote relay (wallet → KyOpSec server) — only connects when configured
    BridgeRemote.start({
        onSignRequest: (req) => onSignRequest(req, 'remote'),
    });
}

// Synchronous wallet identity — used for the immediate greeting on browser connect.
// MUST NOT throw, MUST NOT block. XRPL is not consulted here.
function getWalletInfoSync() {
    console.log('[main] getWalletInfoSync: isLocked=' + isLocked);
    if (isLocked) return { locked: true };
    let address = null;
    try { address = WalletStore.defaultAddress(); }
    catch (e) { console.warn('[main] defaultAddress threw', e?.message || e); }
    console.log('[main] getWalletInfoSync: address=' + (address || 'null'));
    if (!address) return null;
    return { address, locked: false };
}

// Async balance fetch — runs fire-and-forget after the greeting goes out. Failure
// is normal for unfunded (0 XRP) wallets; the bridge logs and moves on.
async function getWalletBalances(address) {
    if (!address) throw new Error('address_required');
    const bal = await XrplBalances.fetch(address);
    const rlusd = (bal.tokens || []).find(t => t.currency === 'RLUSD');
    const out = {
        XRP:   bal.xrp || '0',
        RLUSD: rlusd ? rlusd.value : '0',
    };
    console.log('[main] getWalletBalances:', address, out);
    return out;
}

async function onSignRequest(req, source) {
    const validation = BridgeProtocol.validateSignRequest(req);
    if (!validation.ok) return BridgeProtocol.sendResponse(req, source, { status: 'rejected', reason: 'invalid_request: ' + validation.reason });

    const site = req.source || 'unknown';
    const verdict = AutoSign.canAutoSign(site, req.transaction);

    if (verdict.allowed && !isLocked) {
        // Auto-sign path
        try {
            const seed = WalletStore.revealAutoSignSecret(req.transaction.Account || (await WalletStore.defaultAddress()));
            const prepared = await XrplConnection.autofill(req.transaction);
            const signed = WalletSign.sign(seed, prepared);
            AutoSign.logAutoSign(site, req.transaction, { result: 'auto_signed', tx_hash: signed.hash });
            BridgeProtocol.sendResponse(req, source, {
                status: 'approved',
                signed_blob: signed.tx_blob,
                tx_hash: signed.hash,
                address: req.transaction.Account,
                auto: true,
            });
            if (mainWindow) mainWindow.webContents.send('ui:auto-signed', { site, tx_hash: signed.hash });
            return;
        } catch (err) {
            AutoSign.logAutoSign(site, req.transaction, { result: 'auto_sign_failed', reason: err.message });
            // fall through to manual approval
        }
    }

    // Manual approval — show approval window
    showApprovalWindow({ ...req, source });
}

function showApprovalWindow(req) {
    if (approvalWindow) { approvalWindow.focus(); approvalWindow.webContents.send('approval:request', req); return; }
    approvalWindow = new BrowserWindow({
        width: 540,
        height: 640,
        backgroundColor: '#0a0e14',
        title: 'Labs Wallet — Approve transaction',
        parent: mainWindow,
        modal: false,
        alwaysOnTop: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    approvalWindow.loadFile(path.join(__dirname, 'src', 'ui', 'approval.html'));
    approvalWindow.webContents.once('did-finish-load', () => approvalWindow.webContents.send('approval:request', req));
    approvalWindow.on('closed', () => { approvalWindow = null; });
}
