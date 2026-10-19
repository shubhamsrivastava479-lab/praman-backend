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

// Turns Meta's error reply into a plain sentence that says what to fix.
const HINTS = {
  132001: 'Template not found for this language. Open WhatsApp Manager > Message templates and check the template name and that its status is Approved.',
  132000: 'The template needs exactly one variable {{1}} in its body (it carries the customer link).',
  132005: 'The template text is too long after filling in the variable.',
  132007: 'Meta rejected the template content (policy).',
  132012: 'Template variable format is wrong.',
  132015: 'This template is paused by Meta (low quality). Create a new one.',
  132016: 'This template is disabled by Meta. Create a new one.',
  131030: 'This number is not allowed to receive messages yet. While the Meta app is not Live, add the number as a recipient in the Meta app, or make the app Live.',
  131047: 'More than 24 hours since the customer last wrote: only an approved template can be sent.',
  131026: 'The message could not be delivered. Check the customer number (with country code 91) and that it is on WhatsApp.',
  131042: 'WhatsApp payment method problem. Check the payment method in Meta Business settings.',
  131056: 'Too many messages to this number in a short time. Try again later.',
  133010: 'This phone number is not registered on WhatsApp Cloud API yet. Finish Register phone number in Meta > Step 2. Production setup.',
  130429: 'Too many messages per second. Try again in a minute.',
  190: 'The access token is invalid or expired. Create a new System user token and reconnect the number.',
  10: 'The token does not have permission. It needs whatsapp_business_messaging and whatsapp_business_management.',
  200: 'The token does not have permission for this WhatsApp account. Assign the WhatsApp account to the System user (Full control).',
  100: 'Meta did not accept the request (wrong Phone Number ID or number format).'
};
async function metaError(res, what) {
  const raw = await res.text();
  let code, msg = raw;
  try { const e = JSON.parse(raw).error || {}; code = e.code; msg = [e.message, e.error_data && e.error_data.details].filter(Boolean).join(' - '); } catch {}
  const err = new Error(`${what}: ${HINTS[code] || 'WhatsApp refused the message.'} (Meta code ${code || res.status}: ${String(msg).slice(0, 300)})`);
  err.metaCode = code;
  return err;
}

async function sendTextMessage(to, body, { token, phoneNumberId }) {
  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } })
  });
  if (!res.ok) throw await metaError(res, 'Could not send message');
  return res.json();
}

async function sendTemplateMessage(to, templateName, { token, phoneNumberId }, languageCode = 'en', components = []) {
  const post = lang => fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: templateName, language: { code: lang }, components }
    })
  });
  let res = await post(languageCode);
  // Templates are often saved as English (US); try the other English code once if "not found".
  if (!res.ok && (languageCode === 'en' || languageCode === 'en_US')) {
    const err = await metaError(res.clone(), 'x');
    if (err.metaCode === 132001) {
      const alt = await post(languageCode === 'en' ? 'en_US' : 'en');
      if (alt.ok) return alt.json();
      throw await metaError(alt, `Could not send template "${templateName}"`);
    }
  }
  if (!res.ok) throw await metaError(res, `Could not send template "${templateName}"`);
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
