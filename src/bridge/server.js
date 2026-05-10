// server.js — local WebSocket server (loopback only).
// The KyOpSec website (running in the user's browser) connects to ws://127.0.0.1:17760
// to send sign requests. Refuses any non-loopback connection.

'use strict';

const { WebSocketServer } = require('ws');
const Protocol = require('./protocol');

let wss = null;
let listening = false;
let onSignRequestCb = null;

function start({ port = 17760, onSignRequest }) {
    if (wss) return;
    onSignRequestCb = onSignRequest;
    wss = new WebSocketServer({
        host: '127.0.0.1',
        port,
        verifyClient: (info, done) => {
            const ip = info.req.socket.remoteAddress;
            if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return done(true);
            return done(false, 403, 'Forbidden');
        },
    });
    wss.on('listening', () => { listening = true; });
    wss.on('error', () => { listening = false; });
    wss.on('connection', (ws) => onConnection(ws));
}

function onConnection(ws) {
    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

        if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
            return;
        }

        if (msg.type === 'sign_request') {
            // Track so we can reply on this socket later
            Protocol.trackRequest(msg, 'local', (response) => {
                try { ws.send(JSON.stringify(response)); } catch (_) {}
            });
            if (typeof onSignRequestCb === 'function') onSignRequestCb(msg);
            return;
        }
    });

    ws.on('error', () => {});
}

function stop() {
    if (!wss) return;
    try { wss.close(); } catch (_) {}
    wss = null;
    listening = false;
}

function status() {
    return {
        listening,
        port: 17760,
        connections: wss ? wss.clients.size : 0,
    };
}

module.exports = { start, stop, status };
