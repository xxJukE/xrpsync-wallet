// approval.js — renderer logic for the Approve-transaction modal.
// Extracted from an inline <script> in approval.html: Electron's CSP
// "script-src 'self'" blocks inline scripts, which left the REQUEST /
// TRANSACTION sections empty. As an external same-origin file it is allowed.
// The IPC response shape (status/signed_blob/tx_hash/reason via approval.respond)
// is unchanged.

'use strict';

let _req = null;

window.labs.approval.on((req) => {
    _req = req;
    document.getElementById('apvSite').textContent = req.source || '—';
    document.getElementById('apvType').textContent = req.transaction?.TransactionType || '—';
    document.getElementById('apvTxJson').textContent = JSON.stringify(req.transaction, null, 2);

    const kv = document.getElementById('apvKv');
    kv.innerHTML = '';
    const add = (k, v) => {
        const ke = document.createElement('div'); ke.className = 'k'; ke.textContent = k;
        const ve = document.createElement('div'); ve.className = 'v'; ve.textContent = v;
        kv.appendChild(ke); kv.appendChild(ve);
    };
    add('Description', req.description || '—');
    add('Source', req.source || '—');
    add('Account', req.transaction?.Account || '—');
    add('Type', req.transaction?.TransactionType || '—');
    add('Urgency', req.urgency || 'normal');
    add('Request ID', req.id || '—');
});

document.getElementById('apvReject').addEventListener('click', async () => {
    if (!_req) return;
    await window.labs.approval.respond({ id: _req.id, approved: false });
    window.close();
});

document.getElementById('apvApprove').addEventListener('click', async () => {
    if (!_req) return;
    const pw = document.getElementById('apvPw').value;
    if (!pw) { document.getElementById('apvErr').textContent = 'enter master password'; return; }
    document.getElementById('apvErr').textContent = '';
    try {
        await window.labs.approval.respond({ id: _req.id, approved: true, password: pw, allWalletsAddress: _req.transaction?.Account });
        window.close();
    } catch (err) {
        document.getElementById('apvErr').textContent = String(err.message || err);
    }
});

document.getElementById('apvPw').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('apvApprove').click();
});

// Auto-sign timer buttons: approve THIS tx and arm a time-boxed auto-sign window
// for this site. After the window passes, auto-sign turns OFF automatically.
document.querySelectorAll('#apvAutoTimers .as-t').forEach((btn) => {
    btn.addEventListener('click', async () => {
        if (!_req) return;
        const pw = document.getElementById('apvPw').value;
        if (!pw) { document.getElementById('apvErr').textContent = 'enter master password to arm auto-sign'; return; }
        const ms = Number(btn.dataset.ms) || 0;
        document.getElementById('apvErr').textContent = '';
        try {
            await window.labs.approval.respond({
                id: _req.id, approved: true, password: pw,
                allWalletsAddress: _req.transaction?.Account,
                autoSign: true, durationMs: ms, site: _req.source,
            });
            window.close();
        } catch (err) {
            document.getElementById('apvErr').textContent = String(err.message || err);
        }
    });
});
