// Bind to loopback and put Tailscale Serve in front of this listener.
// Serve strips client-supplied identity headers and adds its verified login.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { agendaProxyMessage } from '../src/agenda-proxy-auth.js';

const upstream = 'https://calendar-sync-ljbw-w.fly.dev';
const account = process.env.PENELOPE_CALENDAR_LOGIN;
if (!account) throw new Error('PENELOPE_CALENDAR_LOGIN is required');
const key = createPrivateKey(readFileSync(process.env.PENELOPE_CALENDAR_KEY_FILE));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 signing key is required');
const assets = new Set(['/agenda', '/agenda.webmanifest', '/agenda-icon.png']);

createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.headers['tailscale-user-login'] !== account) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Calendar access requires your Tailscale account.');
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' });
    return res.end();
  }

  const request = new URL(req.url, 'http://localhost');
  if (request.pathname === '/') {
    res.writeHead(302, { Location: '/agenda' });
    return res.end();
  }
  const isAgendaData = request.pathname === '/api/agenda';
  if (!isAgendaData && !assets.has(request.pathname)) {
    res.writeHead(404);
    return res.end();
  }

  const target = new URL(request.pathname, upstream);
  const headers = {};
  if (isAgendaData) {
    for (const name of ['days', 'refresh']) {
      if (request.searchParams.has(name)) target.searchParams.set(name, request.searchParams.get(name));
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign(null, agendaProxyMessage('GET', target.pathname + target.search, timestamp), key);
    headers['X-Agenda-Proxy-Proof'] = `${timestamp}.${signature.toString('base64url')}`;
  }

  try {
    const response = await fetch(target, { headers, redirect: 'error', signal: AbortSignal.timeout(45_000) });
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Calendar Sync is temporarily unavailable.');
  }
}).listen(8768, '127.0.0.1');
