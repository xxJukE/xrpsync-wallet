// updater.js — thin wrapper around electron-updater.
//
// Model: NO auto-download. We check silently, and when an update exists we tell
// the renderer (which shows a pill). The user clicks the pill → download →
// install-on-quit. This keeps the "click the pill, it updates" UX the operator
// asked for, instead of forcing uninstall/reinstall.
//
// Updates are pulled from GitHub Releases of the public wallet repo (see the
// `publish` block in package.json). Only runs in a packaged build —
// electron-updater throws when run from `electron .` in dev.

'use strict';

let autoUpdater = null;
let emit = () => {};
let wired = false;

function load() {
    if (!autoUpdater) {
        ({ autoUpdater } = require('electron-updater'));
        autoUpdater.autoDownload = false;          // pill-driven, not silent
        autoUpdater.autoInstallOnAppQuit = true;   // apply a downloaded update on next quit
    }
    return autoUpdater;
}

// onEvent(type, data): type ∈ available | none | progress | ready | error
function init({ onEvent, logger } = {}) {
    if (typeof onEvent === 'function') emit = onEvent;
    const u = load();
    if (logger) u.logger = logger;
    if (wired) return;
    wired = true;

    u.on('update-available',     (info) => emit('available', { version: info?.version || null }));
    u.on('update-not-available', ()     => emit('none', {}));
    u.on('download-progress',    (p)    => emit('progress', { percent: Math.round(p?.percent || 0) }));
    u.on('update-downloaded',    (info) => emit('ready', { version: info?.version || null }));
    u.on('error',                (err)  => emit('error', { message: (err && err.message) || String(err) }));
}

async function check() {
    try {
        const r = await load().checkForUpdates();
        return { ok: true, version: r?.updateInfo?.version || null };
    } catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
}

async function download() {
    try {
        await load().downloadUpdate();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
}

function install() {
    // isSilent=false (show installer), isForceRunAfter=true (relaunch after).
    load().quitAndInstall(false, true);
}

module.exports = { init, check, download, install };
