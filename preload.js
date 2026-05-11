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
        status:       ()         => invoke('lock:status'),
        setMaster:    (password) => invoke('lock:set-master', password),
        unlock:       (password) => invoke('lock:unlock', password),
        lockNow:      ()         => invoke('lock:lock'),
        setTimeout:   (ms)       => invoke('lock:set-timeout', ms),
    },

    // ── Wallet management ──
    wallet: {
        list:           ()                    => invoke('wallet:list'),
        generate:       (opts)                => invoke('wallet:generate', opts || {}),
        importWallet:   (kind, value, label)  => invoke('wallet:import', { kind, value, label }),
        rename:         (address, label)      => invoke('wallet:rename', { address, label }),
        revealSecret:   (address, password)   => invoke('wallet:reveal-secret', { address, password }),
        deleteWallet:   (address, confirm)    => invoke('wallet:delete', { address, confirm }),
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
        // Sign-and-submit must be user-initiated (password required each time for non-auto-sign flows).
        signAndSubmit: (address, transaction, password) =>
            invoke('xrpl:sign-and-submit', { address, transaction, password }),
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

    // ── Labs account / subscription ──
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
        autoSigned:  (handler) => ipcRenderer.on('ui:auto-signed', (_e, payload) => handler(payload)),
        nav:         (handler) => ipcRenderer.on('ui:nav', (_e, target) => handler(target)),
    },
});
