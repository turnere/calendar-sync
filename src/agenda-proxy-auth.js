import { createPublicKey, verify } from 'node:crypto';

const MAX_AGE_SECONDS = 30;

export function agendaProxyMessage(method, url, timestamp) {
  return Buffer.from(`calendar-sync-agenda/v1\n${method}\n${url}\n${timestamp}`);
}

export function agendaProxyAuthorized(req, encodedKey, now = Math.floor(Date.now() / 1000)) {
  const proof = req.get('X-Agenda-Proxy-Proof');
  if (!encodedKey || req.method !== 'GET' || !proof) return false;

  const parts = /^(\d{10})\.([A-Za-z0-9_-]{86})$/.exec(proof);
  if (!parts) return false;
  const [, timestamp, signature] = parts;
  const age = now - Number(timestamp);
  if (age < -5 || age > MAX_AGE_SECONDS) return false;

  try {
    const key = createPublicKey({ key: Buffer.from(encodedKey, 'base64'), type: 'spki', format: 'der' });
    return key.asymmetricKeyType === 'ed25519' && verify(
      null, agendaProxyMessage(req.method, req.originalUrl, timestamp), key, Buffer.from(signature, 'base64url')
    );
  } catch {
    return false;
  }
}
