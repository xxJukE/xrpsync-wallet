// preload.js — secure bridge between Electron main and renderer (UI).
// Exposes a narrow, typed API on window.labs.* that calls back to ipcMain.handle().
// The renderer NEVER sees Node APIs, fs, or xrpl.js directly.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, payload) => ipcRenderer.invoke(ch, payload);

// Forward UI activity (mouse/keyboard) to main so the lock timer resets.
window.addEventListener('mousemove', () => ipcRenderer.send('activity'), { passive: true });
window.addEventListener('keydown',  () => ipcRenderer.send('activity'), { passive: true });

contextBridge.exposeInMainWorld('labs', {
    // ── Lock / unlock ──
    lock: {
        status:             ()         => invoke('lock:status'),
        firstLaunchSetup:   ()         => invoke('lock:first-launch-setup'),
        setMaster:          (password) => invoke('lock:set-master', password),
        unlock:             (password) => invoke('lock:unlock', password),
        lockNow:            ()         => invoke('lock:lock'),
        setTimeout:         (ms)       => invoke('lock:set-timeout', ms),
    },

    // ── Settings: password recovery (OS keychain) ──
    settings: {
        getPasswordRecovery: ()                                 => invoke('settings:get-password-recovery'),
        setPasswordRecovery: (enabled, password)                => invoke('settings:set-password-recovery', { enabled, password }),
        revealMasterPassword: (reentered)                       => invoke('settings:reveal-master-password', { reentered }),
    },

    // ── Cloud sync ──
    sync: {
        status:           ()                       => invoke('sync:status'),
        enable:           (password)               => invoke('sync:enable', { password }),
        disable:          (deleteRemote)           => invoke('sync:disable', { deleteRemote: !!deleteRemote }),
        uploadNow:        (password)               => invoke('sync:upload-now', { password }),
        restoreFromCloud: (password)               => invoke('sync:restore-from-cloud', { password }),
    },

    // ── Wallet management ──
    wallet: {
        list:           ()                    => invoke('wallet:list'),
        generate:       (opts)                => invoke('wallet:generate', opts || {}),
        importWallet:   (kind, value, label)  => invoke('wallet:import', { kind, value, label }),
        rename:         (address, label)      => invoke('wallet:rename', { address, label }),
        revealSecret:   (address, password)   => invoke('wallet:reveal-secret', { address, password }),
        deleteWallet:   (address, password)   => invoke('wallet:delete', { address, password, confirm: 'DELETE' }),
    },

    // ── Backup / restore ──
    backup: {
        exportAll: (password) => invoke('backup:export', { password }),
        importAll: (password) => invoke('backup:import', { password }),
    },

    // ── XRPL queries (read-only) ──
    xrpl: {
        balances:   (address)         => invoke('xrpl:balances', address),
        history:    (address, limit)  => invoke('xrpl:history', { address, limit }),
        trustlines: (address)         => invoke('xrpl:trustlines', address),
        serverInfo: ()                => invoke('xrpl:server-info'),
        qr:         (address)         => invoke('xrpl:qr', address),
        // Sign-and-submit must be user-initiated (password required each time for non-auto-sign flows).
        signAndSubmit: (address, transaction, password) =>
            invoke('xrpl:sign-and-submit', { address, transaction, password }),
        // TrustSet — master password required (gated in main like signAndSubmit).
        setTrustline: ({ currency, issuer, limit, password, address }) =>
            invoke('xrpl:trustset', { currency, issuer, limit, password, address }),
    },

    // ── Treasury → Create Token (fixed-supply, blackholed) ──
    token: {
        getNetwork:    ()                       => invoke('token:get-network'),
        setNetwork:    (net)                    => invoke('token:set-network', { net }),
        accountState:  (address)                => invoke('token:account-state', { address }),
        createIssuer:  (label)                  => invoke('token:create-issuer', { label }),
        faucet:        (address, password)      => invoke('token:faucet', { address, password }),
        setFlag:       (address, password, flag)   => invoke('token:set-flag', { address, password, flag }),
        setDomain:     (address, password, domain) => invoke('token:set-domain', { address, password, domain }),
        issue:         (p)                      => invoke('token:issue', p),   // {address,password,distributor,currency,value}
        blackhole:     (address, password)      => invoke('token:blackhole', { address, password }),
        toml:          (opts)                   => invoke('token:toml', opts),
    },

    // ── Auto-sign rules ──
    autosign: {
        all:        ()                  => invoke('autosign:rules'),
        set:        (site, rules)       => invoke('autosign:set', { site, rules }),
        remove:     (site)              => invoke('autosign:remove', { site }),
        log:        (limit)             => invoke('autosign:log', { limit }),
        resetDay:   (site)              => invoke('autosign:reset-day', { site }),
    },

    // ── Site bridge ──
    bridge: {
        status:           () => invoke('bridge:status'),
        configureRemote:  (url, token) => invoke('bridge:configure-remote', { url, token }),
    },

    // ── Fiat on-ramp deep-link ──
    onramp: {
        open: (address) => invoke('onramp:open', { address }),
    },

    // ── Build identity (footer version + diagnostics) ──
    appInfo: () => invoke('app:info'),

    // ── Auto-update (pill-driven) ──
    update: {
        check:    () => invoke('update:check'),
        download: () => invoke('update:download'),
        install:  () => invoke('update:install'),
    },

    // ── XRPSync account / subscription ──
    account: {
        status:       ()                          => invoke('account:status'),
        login:        (email, password, opts)     => invoke('account:login', { email, password, ...(opts || {}) }),
        logout:       ()                          => invoke('account:logout'),
        refresh:      ()                          => invoke('account:refresh'),
        subscription: ()                          => invoke('account:subscription'),
        linkAddress:  (address, switchExisting)   => invoke('account:link-address', { address, switchExisting }),
        upgrade:      (tierSlug, address, password) => invoke('account:upgrade', { tierSlug, address, password }),
    },

    // ── Approval flow ──
    approval: {
        respond: (payload) => invoke('approval:respond', payload),
        on: (handler) => {
            const fn = (_e, req) => handler(req);
            ipcRenderer.on('approval:request', fn);
            return () => ipcRenderer.removeListener('approval:request', fn);
        },
    },

    // ── UI events from main → renderer ──
    on: {
        locked:      (handler) => ipcRenderer.on('ui:locked', handler),
        unlocked:    (handler) => ipcRenderer.on('ui:unlocked', (_e, payload) => handler(payload)),
        autoSigned:  (handler) => ipcRenderer.on('ui:auto-signed', (_e, payload) => handler(payload)),
        nav:         (handler) => ipcRenderer.on('ui:nav', (_e, target) => handler(target)),
        syncUpdated: (handler) => ipcRenderer.on('ui:sync-updated', (_e, payload) => handler(payload)),
        // Auto-update lifecycle: payload = { type: 'available'|'none'|'progress'|'ready'|'error', ... }
        update:      (handler) => ipcRenderer.on('ui:update', (_e, payload) => handler(payload)),
    },
});
