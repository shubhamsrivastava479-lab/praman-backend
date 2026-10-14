// ICE servers (STUN + TURN) for live video calls.
//
// Mobile networks in India (Jio, Airtel, Vi) often put phones behind
// carrier-grade NAT, where a direct WebRTC connection fails. A TURN server
// relays the call in that case. Supported, in this order:
//   1. Cloudflare Realtime TURN  — Super Admin: TURN key ID + API token
//      (short-lived credentials are generated on demand and cached)
//   2. Any TURN server with fixed credentials (e.g. Metered) — URL, username, password
//   3. TURN_URL / TURN_USERNAME / TURN_CREDENTIAL in the environment
// Without any of these, only free STUN is used (works on most Wi-Fi, may
// fail on some mobile networks).
const { getSetting } = require('./platform-settings');

let cfCache = { key: '', exp: 0, servers: null };

async function cloudflareIce(keyId, apiToken) {
  const cacheKey = keyId + apiToken.slice(-6);
  if (cfCache.key === cacheKey && cfCache.exp > Date.now() && cfCache.servers) return cfCache.servers;
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: 86400 })
  });
  if (!res.ok) throw new Error(`Cloudflare TURN error ${res.status}`);
  const j = await res.json();
  const list = Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers];
  // Browsers block port 53; drop those URLs.
  const servers = list.map(s => ({ ...s, urls: [].concat(s.urls).filter(u => !/:53(\?|$)/.test(u)) })).filter(s => s.urls.length);
  cfCache = { key: cacheKey, exp: Date.now() + 12 * 3600 * 1000, servers };
  return servers;
}

async function getIceServers() {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  const cfKey = await getSetting('cfTurnKeyId', 'CF_TURN_KEY_ID');
  const cfToken = await getSetting('cfTurnApiToken', 'CF_TURN_API_TOKEN');
  if (cfKey && cfToken) {
    try { return { iceServers: [...servers, ...(await cloudflareIce(cfKey, cfToken))], turn: 'cloudflare' }; }
    catch (e) { console.warn('TURN (Cloudflare) unavailable:', e.message); }
  }
  const url = await getSetting('turnUrl', 'TURN_URL');
  if (url) {
    servers.push({
      urls: String(url).split(/[\s,]+/).filter(Boolean),
      username: await getSetting('turnUsername', 'TURN_USERNAME'),
      credential: await getSetting('turnCredential', 'TURN_CREDENTIAL')
    });
    return { iceServers: servers, turn: 'custom' };
  }
  return { iceServers: servers, turn: null };
}

module.exports = { getIceServers };
