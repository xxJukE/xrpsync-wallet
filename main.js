// XRPSync Wallet — Electron main process.
// Owns BrowserWindow, IPC handlers, and the local site bridge.
// All cryptographic operations happen in the main process via the modules in src/wallet/.
// The renderer (UI) speaks to main only through the contextBridge API exposed in preload.js.

'use strict';

const { app, BrowserWindow, ipcMain, Menu, dialog, shell, Tray, nativeImage, systemPreferences } = require('electron');
const path = require('path');

// Defer requires that touch electron-store / xrpl until after app.whenReady to keep startup snappy.
let WalletStore, WalletGenerate, WalletImport, WalletSign, WalletBackup, AutoSign;
let WalletSync;
let XrplConnection, XrplBalances, XrplHistory, XrplTrustlines, XrplTrustSet, XrplTokenIssuer, XrplSubmit;
let BridgeServer, BridgeRemote, BridgeProtocol;
let AccountApi, AccountSession, AccountPayment;

// keytar is a native module; load lazily and degrade gracefully if libsecret
// (Linux) or the system keychain isn't available — the password-recovery
// feature is opt-in so its absence is non-fatal.
let keytar = null;
const KEYTAR_SERVICE = 'labs-wallet';
const KEYTAR_ACCOUNT = 'master-password';

const LABS_API_BASE = process.env.LABS_API_BASE || 'https://xrpsync.com';
// Bump on each release build so a running binary can be identified vs older
// installs (logged at startup + surfaced in the wallet footer / app:info IPC).
const BUILD_STAMP = '2026-06-09';
let pendingSyncTimer = null;

let mainWindow = null;
let approvalWindow = null;
let tray = null;
let lockTimer = null;
let isLocked = true;
let Updater = null;          // src/update/updater (packaged builds only)
let updateCheckTimer = null;

// ── Single-instance lock ────────────────────────────────────────────────────
// Prevents multiple wallet instances from running at once. Without this, extra
// launches spawn rival processes that fight over the bridge port (17760) and
// silently break it with EADDRINUSE. A second launch focuses the existing
// window instead. Must run before any app.on() handlers or window creation.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
    return;
}
app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
});

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
        title: 'XRPSync Wallet',
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
                { label: 'About XRPSync Wallet', click: () => dialog.showMessageBox(mainWindow, { title: 'XRPSync Wallet', message: 'XRPSync Wallet ' + app.getVersion(), detail: 'XRPL desktop wallet · keys never leave your device.' }) },
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
    try { mainWindow?.flashFrame(true); } catch (_) {}        // flash taskbar so a backgrounded lock is noticed
    try { BridgeServer?.broadcastWalletInfo(); } catch (_) {} // tell connected sites the wallet just locked
    if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
}
// Single entry point for "the wallet just became unlocked": stop the flash,
// restart the auto-lock timer, notify the renderer (ui:unlocked) and any
// connected site. Routes every unlock path through one place.
function markUnlocked() {
    isLocked = false;
    resetLockTimer();
    try { mainWindow?.flashFrame(false); } catch (_) {}
    try { mainWindow?.webContents.send('ui:unlocked', { lockMs }); } catch (_) {}
    try { BridgeServer?.broadcastWalletInfo(); } catch (_) {}
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
    WalletSync      = require('./src/wallet/sync');
    AutoSign        = require('./src/wallet/auto-sign');
    try { keytar = require('keytar'); }
    catch (e) { console.warn('[main] keytar unavailable, password recovery disabled:', e?.message || e); }
    XrplConnection  = require('./src/xrpl/connection');
    XrplBalances    = require('./src/xrpl/balances');
    XrplHistory     = require('./src/xrpl/history');
    XrplTrustlines  = require('./src/xrpl/trustlines');
    XrplTrustSet    = require('./src/xrpl/trustset');
    XrplTokenIssuer = require('./src/xrpl/token-issuer');
    XrplSubmit      = require('./src/xrpl/submit');
    BridgeServer    = require('./src/bridge/server');
    BridgeRemote    = require('./src/bridge/remote');
    BridgeProtocol  = require('./src/bridge/protocol');
    AccountApi      = require('./src/account/api');
    AccountSession  = require('./src/account/session');
    AccountPayment  = require('./src/account/payment');

    WalletStore.init({ name: 'labs-wallet-data' });
    AccountSession.init();
    lockMs = (WalletStore.getPref('lock_ms') || 5 * 60 * 1000);

    // Build-identity marker — makes "which build am I running?" unambiguous.
    console.log('[main] XRPSync Wallet startup', {
        version:   app.getVersion(),
        build:     BUILD_STAMP,
        startedAt: new Date().toISOString(),
        electron:  process.versions.electron,
        platform:  process.platform,
    });

    createMainWindow();
    buildMenu();
    registerIpc();
    startBridges();
    startUpdater();

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { try { BridgeServer?.stop(); BridgeRemote?.disconnect(); XrplConnection?.disconnect(); } catch (_) {} });

// ── IPC handlers ────────────────────────────────────────────────────────────
function registerIpc() {
    // Lock state
    ipcMain.handle('lock:status', () => ({
        locked:    isLocked,
        hasMaster: WalletStore.hasMasterPassword(),
        kdf:       WalletStore.masterKdf(),
        lockMs,
    }));

    // First-launch setup. Generates a strong random master password, sets it as
    // the wallet's master, and returns the plaintext exactly once for the UI to
    // display + the user to write down. Never stored to disk on the server, and
    // not pushed to OS keychain unless the user opts into password recovery
    // (see settings IPC below).
    ipcMain.handle('lock:first-launch-setup', async () => {
        if (WalletStore.hasMasterPassword()) {
            return { ok: false, error: 'master_already_set' };
        }
        const password = WalletStore.generateMasterPassword(24);
        await WalletStore.setMasterPassword(password);
        markUnlocked();
        return { ok: true, password };
    });

    // Legacy "user-chosen password" flow. Still callable for existing installs
    // that hit "Set password" before the auto-generation flow shipped; new UI
    // routes through lock:first-launch-setup instead.
    ipcMain.handle('lock:set-master', async (_e, password) => {
        if (WalletStore.hasMasterPassword()) {
            return { ok: false, error: 'master_already_set' };
        }
        // Custom password is opt-in (default flow auto-generates a strong one), so
        // enforce a minimum strength bar: ≥12 chars and ≥3 character classes.
        const pw = String(password || '');
        if (pw.length < 12) return { ok: false, error: 'too_short' };
        const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
        if (classes < 3) return { ok: false, error: 'too_weak' };
        await WalletStore.setMasterPassword(pw);
        markUnlocked();
        return { ok: true };
    });
    ipcMain.handle('lock:unlock', async (_e, password) => {
        const result = await WalletStore.unlock(password);
        if (result.ok) markUnlocked();
        return result;  // { ok, error? } — error='engine_unavailable' drives a distinct UI message
    });
    ipcMain.handle('lock:lock', () => { lockApp(); return { ok: true }; });
    ipcMain.handle('lock:set-timeout', (_e, ms) => { lockMs = Math.max(30_000, Number(ms) || 300_000); WalletStore.setPref('lock_ms', lockMs); resetLockTimer(); return { ok: true, ms: lockMs }; });
    ipcMain.on('activity', noteActivity);

    // Build identity for the renderer (footer version + diagnostics).
    ipcMain.handle('app:info', () => ({
        version:  app.getVersion(),
        build:    BUILD_STAMP,
        electron: process.versions.electron,
        platform: process.platform,
    }));

    // ── Auto-update (pill-driven) ──
    ipcMain.handle('update:check',    () => Updater ? Updater.check()    : { ok: false, error: 'updates disabled (dev build)' });
    ipcMain.handle('update:download', () => Updater ? Updater.download() : { ok: false, error: 'updates disabled (dev build)' });
    ipcMain.handle('update:install',  () => { if (Updater) Updater.install(); return { ok: true }; });

    // ── Settings: password recovery (OS keychain copy of master pw) ──
    // Off by default. When enabled the user can reveal the master password
    // after passing OS authentication. Anyone with access to your unlocked
    // OS session can also extract it, so this is a convenience knob the
    // user must consciously turn on.
    ipcMain.handle('settings:get-password-recovery', async () => {
        const enabled = !!WalletStore.getPref('password_recovery_enabled');
        let stored = false;
        if (enabled && keytar) {
            try { stored = !!(await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT)); } catch (_) {}
        }
        return { enabled, keytar_available: !!keytar, stored };
    });

    ipcMain.handle('settings:set-password-recovery', async (_e, { enabled, password }) => {
        if (!keytar) return { ok: false, error: 'keytar_unavailable_on_this_system' };
        if (enabled) {
            ensureUnlocked();
            // Prefer the password the user just typed (we may not have it cached
            // if they unlocked the app from a previous session without retyping).
            const live = password || WalletStore.getUnlockedPassword();
            if (!live) return { ok: false, error: 'password_required_to_enable' };
            // Re-verify by attempting an unlock with the supplied password — this
            // catches typos so we don't stash a wrong password in the keychain.
            const res = await WalletStore.unlock(live);
            if (!res.ok) return { ok: false, error: 'wrong_password' };
            try { await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, live); }
            catch (e) { return { ok: false, error: 'keychain_write_failed: ' + (e.message || e) }; }
            WalletStore.setPref('password_recovery_enabled', true);
            markUnlocked();
            return { ok: true };
        } else {
            try { await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT); } catch (_) {}
            WalletStore.setPref('password_recovery_enabled', false);
            return { ok: true };
        }
    });

    // Reveal the master password. Requires OS authentication when available;
    // on platforms without a native prompt (most Linux, older Windows) the
    // renderer is told to prompt for master-password re-entry and we verify
    // it before returning the stored copy.
    ipcMain.handle('settings:reveal-master-password', async (_e, { reentered } = {}) => {
        if (!WalletStore.getPref('password_recovery_enabled')) {
            return { ok: false, reason: 'recovery_disabled' };
        }
        if (!keytar) return { ok: false, reason: 'keytar_unavailable' };
        const stored = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT).catch(() => null);
        if (!stored) return { ok: false, reason: 'no_password_in_keychain' };

        if (process.platform === 'darwin' && systemPreferences?.canPromptTouchID?.()) {
            try { await systemPreferences.promptTouchID('reveal XRPSync Wallet master password'); }
            catch (_) { return { ok: false, reason: 'os_auth_failed' }; }
            return { ok: true, password: stored };
        }
        // Windows / Linux fallback — renderer must collect the master password.
        if (!reentered) {
            return { ok: false, reason: 'prompt_password' };
        }
        const verified = await WalletStore.unlock(reentered);
        if (!verified.ok) return { ok: false, reason: 'wrong_password' };
        return { ok: true, password: stored };
    });

    // ── Cloud sync ──
    ipcMain.handle('sync:status', async () => syncStatusForRenderer());

    ipcMain.handle('sync:enable', async (_e, { password } = {}) => {
        ensureUnlocked();
        const token = AccountSession?.getToken();
        if (!token) return { ok: false, error: 'not_logged_in_to_labs_account' };
        const pw = password || WalletStore.getUnlockedPassword();
        if (!pw) return { ok: false, error: 'master_password_required_to_seed_sync' };
        WalletStore.setPref('sync_enabled', true);
        const res = await uploadCurrentBlob(pw).catch(e => ({ ok: false, error: e.message || String(e) }));
        if (!res.ok) WalletStore.setPref('sync_enabled', false);
        return res;
    });

    ipcMain.handle('sync:disable', async (_e, { deleteRemote } = {}) => {
        WalletStore.setPref('sync_enabled', false);
        if (deleteRemote) {
            const token = AccountSession?.getToken();
            if (token) {
                try { await WalletSync.deleteBackup({ baseUrl: LABS_API_BASE, token }); } catch (_) {}
            }
        }
        return { ok: true };
    });

    ipcMain.handle('sync:upload-now', async (_e, { password } = {}) => {
        ensureUnlocked();
        const token = AccountSession?.getToken();
        if (!token) return { ok: false, error: 'not_logged_in_to_labs_account' };
        const pw = password || WalletStore.getUnlockedPassword();
        if (!pw) return { ok: false, error: 'master_password_required' };
        return uploadCurrentBlob(pw);
    });

    // Restore wallets from the server-side blob. Requires the master password
    // that was used when the blob was originally produced. If the local store
    // already has wallets, they're left in place and any non-overlapping
    // addresses from the cloud are added.
    ipcMain.handle('sync:restore-from-cloud', async (_e, { password }) => {
        if (!password) return { ok: false, error: 'master_password_required' };
        const token = AccountSession?.getToken();
        if (!token) return { ok: false, error: 'not_logged_in_to_labs_account' };
        const r = await WalletSync.downloadBlob({ baseUrl: LABS_API_BASE, token });
        if (!r.ok) return { ok: false, error: 'download_failed: HTTP ' + r.status };
        if (!r.body?.has_backup) return { ok: false, error: 'no_backup_on_server' };

        const blob = Buffer.from(r.body.encrypted_blob, 'base64');
        let inner;
        try { inner = await WalletSync.decodeBlob(blob, password); }
        catch (e) { return { ok: false, error: e.message || String(e) }; }

        // If the local store has no master yet, set the one we just verified.
        if (!WalletStore.hasMasterPassword()) {
            await WalletStore.setMasterPassword(password);
            markUnlocked();
        } else if (isLocked) {
            // Unlock with the supplied password — this is also our verification.
            const res = await WalletStore.unlock(password);
            if (!res.ok) return { ok: false, error: 'master_password_does_not_match_local_store' };
            markUnlocked();
        }

        const xrpl = require('xrpl');
        const existing = new Set(WalletStore.listWallets().map(w => w.address));
        let imported = 0;
        for (const w of (inner.wallets || [])) {
            try {
                if (existing.has(w.address)) continue;
                const xw = xrpl.Wallet.fromSeed(w.seed);
                await WalletStore.saveWallet({
                    address: xw.classicAddress,
                    classicAddress: xw.classicAddress,
                    publicKey: xw.publicKey,
                    seed: w.seed,
                }, w.label || null);
                imported++;
            } catch (_) { /* skip malformed entry */ }
        }
        if (inner.rules && typeof inner.rules === 'object') WalletStore.setAutoSignRules(inner.rules);

        WalletStore.setPref('sync_enabled', true);
        BridgeServer?.broadcastWalletInfo();
        return { ok: true, imported, version: r.body.version, updated_at: r.body.updated_at };
    });

    // Wallet management
    ipcMain.handle('wallet:list', () => WalletStore.listWallets());
    ipcMain.handle('wallet:generate', async (_e, opts) => {
        ensureUnlocked();
        const w = WalletGenerate.create();
        await WalletStore.saveWallet(w, (opts && opts.label) || null);
        scheduleAutoSync();
        return { address: w.address, classicAddress: w.classicAddress };
    });
    ipcMain.handle('wallet:import', async (_e, { kind, value, label }) => {
        ensureUnlocked();
        const w = WalletImport.fromInput(kind, value);
        await WalletStore.saveWallet(w, label || null);
        scheduleAutoSync();
        return { address: w.address };
    });
    ipcMain.handle('wallet:rename', async (_e, { address, label }) => {
        ensureUnlocked();
        WalletStore.renameWallet(address, label);
        scheduleAutoSync();
        return { ok: true };
    });
    ipcMain.handle('wallet:reveal-secret', async (_e, { address, password }) => {
        ensureUnlocked();
        return WalletStore.revealSecret(address, password);
    });
    ipcMain.handle('wallet:delete', async (_e, { address, password, confirm }) => {
        ensureUnlocked();
        if (confirm !== 'DELETE') throw new Error('confirmation_required');
        // Removing key material requires the master password — verify before delete.
        const v = await WalletStore.unlock(password);
        if (!v || !v.ok) return { ok: false, error: 'wrong_password' };
        WalletStore.deleteWallet(address);
        scheduleAutoSync();
        return { ok: true };
    });

    // Backup / restore
    ipcMain.handle('backup:export', async (_e, { password }) => {
        ensureUnlocked();
        const blob = await WalletBackup.exportAll(password);
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
            title: 'Save XRPSync Wallet backup',
            defaultPath: `labs-wallet-backup-${new Date().toISOString().slice(0,10)}.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (canceled || !filePath) return { ok: false, reason: 'canceled' };
        require('fs').writeFileSync(filePath, blob);
        return { ok: true, path: filePath };
    });
    ipcMain.handle('backup:import', async (_e, { password }) => {
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
            title: 'Open XRPSync Wallet backup',
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

    // QR code for an address — returns a PNG data URL the renderer can paint
    // onto a canvas. qrcode 1.5+ does not ship a UMD bundle suitable for the
    // contextIsolated renderer, so generation lives here in main where the
    // CommonJS entry works directly.
    ipcMain.handle('xrpl:qr', async (_e, address) => {
        if (!address || typeof address !== 'string') throw new Error('address_required');
        const QRCode = require('qrcode');
        return QRCode.toDataURL(address, { width: 220, margin: 2, errorCorrectionLevel: 'M' });
    });

    // Manual sign + submit (user-initiated, e.g. "Send Payment" form in UI)
    ipcMain.handle('xrpl:sign-and-submit', async (_e, { address, transaction, password }) => {
        ensureUnlocked();
        const seed = await WalletStore.revealSecret(address, password);
        const prepared = await XrplConnection.autofill(transaction);
        const signed = WalletSign.sign(seed, prepared);
        const result = await XrplSubmit.submitSignedBlob(signed.tx_blob);
        return { hash: signed.hash, result };
    });

    // TrustSet — user-initiated, master-password gated like sign-and-submit.
    // The renderer never holds the seed; we resolve it here from the master
    // password, build an unlocked xrpl.js Wallet, and hand it to the adapter.
    ipcMain.handle('xrpl:trustset', async (_e, { currency, issuer, limit, password, address } = {}) => {
        ensureUnlocked();
        const xrpl = require('xrpl');
        const acct = address || WalletStore.defaultAddress();
        if (!acct) return { ok: false, error: 'no_wallet' };
        let seed;
        try { seed = await WalletStore.revealSecret(acct, password); }
        catch (_) { return { ok: false, error: 'wrong_password' }; }
        let wallet;
        try { wallet = xrpl.Wallet.fromSeed(seed); }
        catch (_) { return { ok: false, error: 'key_error' }; }
        return XrplTrustSet.submit({ wallet, currency, issuer, limit });
    });

    // ── Treasury → Create Token (fixed-supply, blackholed) ──
    // Resolve an unlocked xrpl.js Wallet from address+master-password (the
    // renderer never holds the seed) — shared by every issuer-signed step.
    const resolveWallet = async (address, password) => {
        const xrpl = require('xrpl');
        const acct = address || WalletStore.defaultAddress();
        if (!acct) return { ok: false, error: 'no_wallet' };
        let seed;
        try { seed = await WalletStore.revealSecret(acct, password); }
        catch (_) { return { ok: false, error: 'wrong_password' }; }
        try { return { ok: true, wallet: xrpl.Wallet.fromSeed(seed) }; }
        catch (_) { return { ok: false, error: 'key_error' }; }
    };

    ipcMain.handle('token:set-network', async (_e, { net } = {}) => {
        try { return { ok: true, network: await XrplConnection.setNetwork(net) }; }
        catch (e) { return { ok: false, error: (e && e.message) || 'network_error' }; }
    });
    ipcMain.handle('token:get-network', () => ({ ok: true, network: XrplConnection.getNetwork() }));
    ipcMain.handle('token:account-state', async (_e, { address } = {}) => XrplTokenIssuer.accountState(address));

    // Fresh, dedicated issuer wallet (stored so its seed is backed up; blackholed at the end).
    ipcMain.handle('token:create-issuer', async (_e, { label } = {}) => {
        ensureUnlocked();
        const w = WalletGenerate.create();
        await WalletStore.saveWallet(w, label || 'Token Issuer');
        scheduleAutoSync();
        return { ok: true, address: w.address };
    });

    ipcMain.handle('token:faucet', async (_e, { address, password } = {}) => {
        ensureUnlocked();
        const r = await resolveWallet(address, password);
        return r.ok ? XrplTokenIssuer.faucetFund(r.wallet) : r;
    });
    ipcMain.handle('token:set-flag', async (_e, { address, password, flag } = {}) => {
        ensureUnlocked();
        const r = await resolveWallet(address, password);
        return r.ok ? XrplTokenIssuer.setAccountFlag(r.wallet, flag) : r;
    });
    ipcMain.handle('token:set-domain', async (_e, { address, password, domain } = {}) => {
        ensureUnlocked();
        const r = await resolveWallet(address, password);
        return r.ok ? XrplTokenIssuer.setDomain(r.wallet, domain) : r;
    });
    ipcMain.handle('token:issue', async (_e, { address, password, distributor, currency, value } = {}) => {
        ensureUnlocked();
        const r = await resolveWallet(address, password);
        return r.ok ? XrplTokenIssuer.issueSupply(r.wallet, distributor, currency, value) : r;
    });
    ipcMain.handle('token:blackhole', async (_e, { address, password } = {}) => {
        ensureUnlocked();
        const r = await resolveWallet(address, password);
        return r.ok ? XrplTokenIssuer.blackhole(r.wallet) : r;
    });
    ipcMain.handle('token:toml', (_e, opts = {}) => ({ ok: true, toml: XrplTokenIssuer.buildToml(opts) }));

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

    // Fund Wallet — opens xrpsync.com/buy-xrp in the user's default browser.
    // Restricted to the XRPSync host so a compromised renderer can't open arbitrary
    // URLs. Address is passed through unchanged so the on-ramp can pre-fill it.
    ipcMain.handle('onramp:open', async (_e, { address } = {}) => {
        const base = 'https://xrpsync.com/buy-xrp';
        const u = new URL(base);
        if (address && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(String(address))) {
            u.searchParams.set('address', address);
        }
        await shell.openExternal(u.toString());
        return { ok: true };
    });

    // ── XRPSync account (subscription / login) ──
    ipcMain.handle('account:status', () => ({
        logged_in: AccountSession.isLoggedIn(),
        user:      AccountSession.getUser(),
    }));

    ipcMain.handle('account:login', async (_e, { email, password, walletAddress, label }) => {
        const resp = await AccountApi.login(email, password, {
            walletAddress: walletAddress || (WalletStore.hasMasterPassword() && !isLocked ? WalletStore.defaultAddress() : null),
            label,
        });
        if (!resp.ok || !resp.body.ok) {
            return { ok: false, error: (resp.body && resp.body.error) || ('login failed: HTTP ' + resp.status) };
        }
        AccountSession.setSession(resp.body.token, resp.body.user);
        // After login, refresh the user payload — captures any auto-link side-effect.
        try {
            const me = await AccountApi.me(resp.body.token);
            if (me.ok && me.body.user) AccountSession.setSession(null, me.body.user);
        } catch (_) {}
        // Broadcast a fresh greeting so the website sees the tier immediately.
        try { BridgeServer.broadcastWalletInfo(); } catch (_) {}
        return { ok: true, user: AccountSession.getUser() };
    });

    ipcMain.handle('account:logout', async () => {
        const token = AccountSession.getToken();
        if (token) { try { await AccountApi.logout(token); } catch (_) {} }
        AccountSession.clear();
        try { BridgeServer.broadcastWalletInfo(); } catch (_) {}
        return { ok: true };
    });

    ipcMain.handle('account:refresh', async () => {
        const token = AccountSession.getToken();
        if (!token) return { ok: false, error: 'not logged in' };
        const me = await AccountApi.me(token);
        if (me.status === 401) { AccountSession.clear(); return { ok: false, error: 'session expired' }; }
        if (!me.ok || !me.body.ok) return { ok: false, error: (me.body && me.body.error) || 'refresh failed' };
        AccountSession.setSession(null, me.body.user);
        return { ok: true, user: me.body.user };
    });

    ipcMain.handle('account:subscription', async () => {
        const token = AccountSession.getToken();
        if (!token) return { ok: false, error: 'not logged in' };
        const r = await AccountApi.subscription(token);
        if (r.status === 401) { AccountSession.clear(); return { ok: false, error: 'session expired' }; }
        if (!r.ok) return { ok: false, error: (r.body && r.body.error) || 'fetch failed' };
        return r.body;
    });

    ipcMain.handle('account:link-address', async (_e, { address, switchExisting } = {}) => {
        const token = AccountSession.getToken();
        if (!token) return { ok: false, error: 'not logged in' };
        const r = await AccountApi.linkAddress(token, address, { switchExisting: !!switchExisting });
        return r.body || { ok: false, error: 'link failed' };
    });

    ipcMain.handle('account:upgrade', async (_e, { tierSlug, address, password }) => {
        ensureUnlocked();
        const token = AccountSession.getToken();
        if (!token) throw new Error('not logged in to XRPSync');
        const result = await AccountPayment.upgrade({
            token,
            tierSlug,
            address,
            password,
            store:  WalletStore,
            sign:   WalletSign,
            xrpl:   XrplConnection,
            submit: XrplSubmit,
        });
        // Refresh the cached user payload so the sidebar updates without a reload.
        try {
            const me = await AccountApi.me(token);
            if (me.ok && me.body.user) AccountSession.setSession(null, me.body.user);
        } catch (_) {}
        try { BridgeServer.broadcastWalletInfo(); } catch (_) {}
        return result;
    });

    // Approval flow — UI calls back into main with the user's decision
    ipcMain.handle('approval:respond', async (_e, { id, approved, password, allWalletsAddress, autoSign, durationMs, site }) => {
        // Time-boxed auto-sign: the user picked a window in the approval modal. Arm
        // the session BEFORE signing this tx, so this one + any others from this
        // site within the window auto-sign. Still gated by the Pro entitlement +
        // caps + allowed types/pairs + hard-blocks (armSession only sets the timer).
        if (approved && autoSign && site && Number(durationMs) > 0) {
            try { AutoSign.armSession(site, Number(durationMs)); } catch (_) {}
        }
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

// ── Cloud sync helpers ──────────────────────────────────────────────────────
async function syncStatusForRenderer() {
    const enabled = !!WalletStore.getPref('sync_enabled');
    const lastUploaded = WalletStore.getPref('sync_last_uploaded_at') || null;
    const lastVersion  = WalletStore.getPref('sync_last_version') || null;
    const token = AccountSession?.getToken();
    if (!token) return { enabled, logged_in: false, has_backup: false, last_uploaded_at: lastUploaded, last_version: lastVersion };
    try {
        const r = await WalletSync.statusRequest({ baseUrl: LABS_API_BASE, token });
        if (!r.ok) return { enabled, logged_in: true, error: 'status_http_' + r.status, last_uploaded_at: lastUploaded };
        return {
            enabled,
            logged_in:  true,
            has_backup: !!r.body.has_backup,
            version:    r.body.version || null,
            updated_at: r.body.updated_at || null,
            size_bytes: r.body.size_bytes || 0,
            device_label: r.body.device_label || null,
            last_uploaded_at: lastUploaded,
            last_version: lastVersion,
        };
    } catch (e) {
        return { enabled, logged_in: true, error: e.message || String(e), last_uploaded_at: lastUploaded };
    }
}

async function uploadCurrentBlob(masterPassword) {
    const token = AccountSession?.getToken();
    if (!token) return { ok: false, error: 'not_logged_in' };
    const { blob, checksum, version } = await WalletSync.buildBlob(WalletStore, masterPassword);
    const r = await WalletSync.uploadBlob({ baseUrl: LABS_API_BASE, token, blob, checksum, version });
    if (!r.ok) return { ok: false, error: 'upload_http_' + r.status, body: r.body };
    WalletStore.setPref('sync_last_uploaded_at', new Date().toISOString());
    WalletStore.setPref('sync_last_version', version);
    if (mainWindow) mainWindow.webContents.send('ui:sync-updated', { ok: true, version, uploaded_at: r.body?.uploaded_at });
    return { ok: true, version, uploaded_at: r.body?.uploaded_at };
}

// Debounced background upload triggered by wallet:* mutations. Silent — the
// only UI is the small "syncing…" indicator the renderer drives off
// 'ui:sync-updated'. If the user hasn't enabled sync or isn't logged in, no-op.
function scheduleAutoSync() {
    if (!WalletStore.getPref('sync_enabled')) return;
    if (!AccountSession?.getToken()) return;
    if (pendingSyncTimer) clearTimeout(pendingSyncTimer);
    pendingSyncTimer = setTimeout(async () => {
        pendingSyncTimer = null;
        try {
            const pw = WalletStore.getUnlockedPassword();
            if (!pw) return; // can't auto-sync without the password — skipped silently
            if (mainWindow) mainWindow.webContents.send('ui:sync-updated', { syncing: true });
            await uploadCurrentBlob(pw);
        } catch (e) {
            console.warn('[main] auto-sync failed', e?.message || e);
            if (mainWindow) mainWindow.webContents.send('ui:sync-updated', { ok: false, error: e?.message });
        }
    }, 1500);
}

// ── Auto-update ───────────────────────────────────────────────────────────────
// Packaged builds only — electron-updater throws under `electron .` in dev.
// Silent check; the renderer shows a pill when something is available.
function startUpdater() {
    if (!app.isPackaged) {
        console.log('[main] updater disabled (dev / unpackaged)');
        return;
    }
    try {
        Updater = require('./src/update/updater');
        Updater.init({
            logger: console,
            onEvent: (type, data) => {
                try { mainWindow?.webContents.send('ui:update', { type, ...(data || {}) }); } catch (_) {}
            },
        });
        // First check shortly after launch, then every 6 hours.
        setTimeout(() => { Updater.check(); }, 8000);
        updateCheckTimer = setInterval(() => { Updater.check(); }, 6 * 60 * 60 * 1000);
    } catch (e) {
        console.warn('[main] updater unavailable:', e?.message || e);
        Updater = null;
    }
}

// ── Bridges ─────────────────────────────────────────────────────────────────
function startBridges() {
    // Local WS server (browser → wallet) on 127.0.0.1
    BridgeServer.start({
        port: 17760,
        onSignRequest: (req) => onSignRequest(req, 'local'),
        getWalletInfoSync: getWalletInfoSync,
        getBalances:        getWalletBalances,
        getAutoSignStatus:  getAutoSignStatus,
    });

    // Remote relay (wallet → XRPSync server) — only connects when configured
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

    // Attach the XRPSync account tier (if logged in) so the website knows
    // immediately what features to unlock — no extra round-trip needed.
    let account = null;
    try {
        const u = AccountSession?.getUser();
        if (u && AccountSession.isLoggedIn()) {
            account = {
                id: u.id, name: u.name, email: u.email,
                tier: u.tier, is_pro: !!u.is_pro, is_growth: !!u.is_growth,
                // Resolved entitlements so the website gates one-click identically.
                entitlements: u.entitlements || null,
                expires_at: u.expires_at || null,
            };
        }
    } catch (e) { /* swallow — never block the greeting */ }

    return { address, locked: false, account };
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

// Auto-sign is a Pro entitlement. The server asserts it in the authenticated
// me() payload (entitlements.flags.auto_sign); we read the cached copy. Falls
// back to is_pro for older payloads. NOT cryptographically airtight (the user
// owns this binary) — it gates the convenience and stops revenue leakage. A
// Free user can still MANUALLY approve every trade in the approval window.
function accountAllowsAutoSign() {
    try {
        const u = AccountSession?.getUser();
        if (!u || !AccountSession.isLoggedIn()) return false;
        const flag = u.entitlements?.flags?.auto_sign;
        if (typeof flag === 'boolean') return flag;
        return !!u.is_pro; // back-compat for payloads predating entitlements
    } catch (_) { return false; }
}

// Auto-sign arming state for a site — read by the bridge's auto_sign_status
// query so the website's bot executor can HOLD when the time-boxed session
// lapsed (instead of spraying manual approval prompts). `armed` mirrors
// canAutoSign's activation check exactly: legacy persistent enabled flag OR a
// live timed session. remaining_ms = -1 means persistent (no expiry).
function getAutoSignStatus(site) {
    let armed = false, remaining = 0;
    try {
        const rules = AutoSign.getRules(site);
        const sess  = AutoSign.sessionStatus(site);
        const persistent = !!(rules && rules.enabled === true);
        armed = persistent || sess.active;
        remaining = persistent ? -1 : sess.remainingMs;
    } catch (_) { /* default: not armed */ }
    return {
        armed,
        remaining_ms: remaining,
        account_allowed: accountAllowsAutoSign(),
        wallet_unlocked: !isLocked,
    };
}

async function onSignRequest(req, source) {
    const validation = BridgeProtocol.validateSignRequest(req);
    if (!validation.ok) return BridgeProtocol.sendResponse(req, source, { status: 'rejected', reason: 'invalid_request: ' + validation.reason });

    const site = req.source || 'unknown';
    const verdict = AutoSign.canAutoSign(site, req.transaction);

    // Tier gate: even if the local rules allow it, only Pro+ may auto-sign.
    // Free (or logged-out) falls through to manual approval — never silently signs.
    if (verdict.allowed && !isLocked && !accountAllowsAutoSign()) {
        AutoSign.logAutoSign(site, req.transaction, { result: 'auto_sign_blocked_no_pro' });
        return showApprovalWindow({ ...req, source, site });
    }

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

    // Diagnostic: when canAutoSign said NO, log the reason so RECENT AUTO-SIGNS
    // shows it (e.g. "manual:auto_sign_disabled" = no matching/active rule for the
    // site, "manual:pair_not_allowed", etc.). Otherwise a non-match leaves the
    // panel blank and the failure is undebuggable.
    if (!verdict.allowed) {
        AutoSign.logAutoSign(site, req.transaction, { result: 'manual:' + (verdict.reason || 'disabled') });
    }
    // Manual approval — show approval window
    showApprovalWindow({ ...req, source, site });
}

function showApprovalWindow(req) {
    if (approvalWindow) { approvalWindow.focus(); approvalWindow.webContents.send('approval:request', req); return; }
    approvalWindow = new BrowserWindow({
        width: 540,
        height: 640,
        backgroundColor: '#0a0e14',
        title: 'XRPSync Wallet — Approve transaction',
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
