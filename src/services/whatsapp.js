const crypto = require('crypto');

const GRAPH_BASE = 'https://graph.facebook.com/v20.0';

// The verify token is the ONE thing shared across all vendors — every vendor
// enters this same string into their own Meta app's webhook config. It's
// just used to prove to Meta that this endpoint is really ours; it carries
// no per-vendor identity.
function verifySubscription(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return challenge;
  }
  return null;
}

// Validates X-Hub-Signature-256 using the SPECIFIC vendor's app secret.
// Which vendor's secret to use is determined by phone_number_id in the
// payload — see routes/whatsapp.js for how this is looked up before calling.
function isValidSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return true; // vendor hasn't set an app secret yet (dev-only leniency)
  if (!signatureHeader) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

// Pulls the phone_number_id out of a raw webhook body WITHOUT assuming which
// vendor it belongs to yet — this is the lookup key used to find the vendor.
function extractPhoneNumberId(body) {
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const id = change.value?.metadata?.phone_number_id;
      if (id) return id;
    }
  }
  return null;
}

function extractMessages(body) {
  const out = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contactByWaId = {};
      for (const c of value.contacts || []) contactByWaId[c.wa_id] = c.profile?.name;
      for (const msg of value.messages || []) {
        out.push({
          from: msg.from,
          fromName: contactByWaId[msg.from] || null,
          id: msg.id,
          timestamp: msg.timestamp,
          type: msg.type,
          text: msg.text?.body,
          media: msg.image || msg.video || msg.audio || msg.document || null,
          phoneNumberId: value.metadata?.phone_number_id
        });
      }
    }
  }
  return out;
}

// Two-step download: media_id -> short-lived URL -> binary bytes.
// `token` is the SPECIFIC vendor's WhatsApp access token.
async function downloadMedia(mediaId, token) {
  const metaRes = await fetch(`${GRAPH_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!metaRes.ok) throw new Error(`Failed to resolve media ${mediaId}: ${await metaRes.text()}`);
  const meta = await metaRes.json();

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) throw new Error(`Failed to download media ${mediaId}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, mimeType: meta.mime_type, sha256: meta.sha256 };
}

async function sendTextMessage(to, body, { token, phoneNumberId }) {
  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } })
  });
  if (!res.ok) throw new Error(`Failed to send message: ${await res.text()}`);
  return res.json();
}

async function sendTemplateMessage(to, templateName, { token, phoneNumberId }, languageCode = 'en', components = []) {
  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: templateName, language: { code: languageCode }, components }
    })
  });
  if (!res.ok) throw new Error(`Failed to send template: ${await res.text()}`);
  return res.json();
}

// Quick way for a vendor to confirm their credentials work when they connect
// their WhatsApp account from the dashboard, before they rely on it.
async function verifyCredentials({ token, phoneNumberId }) {
  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}?fields=display_phone_number,verified_name`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error((await res.json())?.error?.message || 'Invalid token or phone number ID');
  return res.json(); // { display_phone_number, verified_name, id }
}

module.exports = {
  verifySubscription,
  isValidSignature,
  extractPhoneNumberId,
  extractMessages,
  downloadMedia,
  sendTextMessage,
  sendTemplateMessage,
  verifyCredentials
};
