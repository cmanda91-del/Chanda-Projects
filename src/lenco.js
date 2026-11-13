import { config } from './config.js';

export const paymentsEnabled = () => Boolean(config.lencoKey);

async function lenco(method, path, body) {
  const res = await fetch(`${config.lencoBaseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.lencoKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) {
    const err = new Error(data.message || `Lenco request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data.data;
}

// Request a mobile money payment. The learner approves it on their phone.
export function requestMobileMoney({ amount, reference, phone, operator }) {
  return lenco('POST', '/collections/mobile-money', {
    amount, reference, phone, operator, country: 'zm', bearer: 'merchant',
  });
}

// Authoritative status lookup (also used to verify webhooks).
export function collectionStatus(reference) {
  return lenco('GET', `/collections/status/${encodeURIComponent(reference)}`);
}
