const express = require('express');
const crypto = require('crypto');
const { db, uid } = require('../db');
const wa = require('../services/whatsapp');
const gemini = require('../services/gemini');
const storage = require('../services/storage');
const { requireAuth } = require('../middleware/auth');
const engine = require('../services/ai-call-engine');
const docReader = require('../services/doc-reader');
const { caseFileKey, unassignedFileKey, normRef } = require('../services/ids');

// Which case does a WhatsApp message from this number belong to?
//  1. the case whose AI call is waiting for documents right now
//  2. any case with an AI call in progress
//  3. a case whose claim no. or case no. (PRM26-…) is written in the message
//  4. the only open case for this number
//  5. several open cases: the one we contacted most recently (link sent,
//     live call…), else the newest — and the item is marked for review
// No case for this number at all -> saved as 'unassigned' for the firm, so
// nothing is ever lost; the executive attaches it to a case from the dashboard.
const CLOSED = ['completed', 'closed'];
function matchCase(vendorId, senderDigits, text) {
  const sameNumber = db.data.cases.filter(c => c.vendorId === vendorId && c.whatsappNumber === senderDigits);
  if (!sameNumber.length) return { c: null, how: 'no case for this number' };
  const step = c => c.aiCall && c.aiCall.status === 'in_progress' && c.aiCall.queue && c.aiCall.queue[c.aiCall.i];
  let c = sameNumber.find(x => step(x) && step(x).type === 'docs');
  if (c) return { c, how: 'AI call waiting for documents' };
  c = sameNumber.find(x => x.aiCall && x.aiCall.status === 'in_progress');
  if (c) return { c, how: 'AI call in progress' };
  const t = normRef(text);
  if (t) {
    c = sameNumber.find(x => (normRef(x.claimNo).length >= 4 && t.includes(normRef(x.claimNo))) || (x.caseRef && t.includes(normRef(x.caseRef))));
    if (c) return { c, how: 'claim/case number in the message' };
  }
  const open = sameNumber.filter(x => !CLOSED.includes(x.status));
  if (open.length === 1) return { c: open[0], how: 'only open case for this number' };
  const pool = open.length ? open : sameNumber;
  const sorted = pool.slice().sort((a, b) => String(b.lastContactAt || b.createdAt).localeCompare(String(a.lastContactAt || a.createdAt)));
  return {
    c: sorted[0],
    how: pool.length > 1 ? 'most recently contacted case' : 'only case for this number',
    review: pool.length > 1 ? `This number has ${pool.length} ${open.length ? 'open ' : ''}cases (${pool.map(x => x.caseRef || x.claimNo).join(', ')}). Filed under the most recently contacted one — move it if wrong.` : null
  };
}

const router = express.Router();

// --- Step 1: Meta's one-time verification handshake (GET) ---
// Every vendor's Meta app points at this same URL and uses the same shared
// WHATSAPP_VERIFY_TOKEN when registering their webhook.
router.get('/webhook', (req, res) => {
  const challenge = wa.verifySubscription(req.query);
  if (challenge) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// --- Step 2: Incoming messages (POST) ---
// NOTE: server.js captures the raw body for signature verification.
router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ack fast; Meta retries aggressively otherwise

  try {
    await db.read();

    // Figure out WHICH vendor this message belongs to, using the
    // phone_number_id Meta includes in every payload — this is what makes
    // one shared webhook URL work for unlimited vendors.
    const phoneNumberId = wa.extractPhoneNumberId(req.body);
    if (!phoneNumberId) return;

    const account = db.data.whatsappAccounts.find(a => a.phoneNumberId === phoneNumberId);
    if (!account) {
      console.warn(`No vendor has connected WhatsApp phone_number_id=${phoneNumberId}`);
      return;
    }

    // Validate the signature using THIS vendor's own app secret.
    const signature = req.get('X-Hub-Signature-256');
    if (!wa.isValidSignature(req.rawBody, signature, account.appSecret)) {
      console.warn(`Invalid webhook signature for vendor ${account.vendorId}, dropping payload`);
      return;
    }

    const messages = wa.extractMessages(req.body);

    // Phase 1 — slow work with NO database writes: match the case, download
    // the file, read it with Gemini (text, ID fields, Aadhaar masking) and
    // put it in storage. A live AI call may be writing to the same case in
    // the meantime, so we only touch the database in phase 2.
    const prepared = [];
    for (const msg of messages) {
      // Match the sender to one of THIS vendor's cases only. If the same
      // number has several cases, prefer the one whose AI call is waiting
      // for documents right now, otherwise the newest case.
      const senderDigits = msg.from.replace(/\D/g, '');
      // Meta sometimes delivers the same message twice — keep only one copy.
      if (msg.id && db.data.evidence.some(e => e.waMessageId === msg.id)) continue;
      const m = matchCase(account.vendorId, senderDigits, `${msg.text || ''} ${(msg.media && msg.media.caption) || ''}`);
      const matchedCase = m.c;
      if (!matchedCase) console.warn(`WhatsApp item from ${msg.from}: no case for this number — saved as unassigned.`);

      const item = {
        msg, caseId: matchedCase ? matchedCase.id : null, vendorId: account.vendorId, match: m, evidenceId: uid('ev'),
        fileUrl: null, mimeType: null, sha256: null, storedSha256: null, size: null, fileName: null,
        caption: msg.text || null, analysis: null, idExtract: null, idBuffer: null, transcript: null,
        aiActive: !!(matchedCase && matchedCase.aiCall && matchedCase.aiCall.status === 'in_progress')
      };

      if (msg.media) {
        try {
          const { buffer, mimeType: mt, sha256: hash } = await wa.downloadMedia(msg.media.id, account.token);
          item.mimeType = mt;
          item.size = buffer.length;
          item.fileName = msg.media.filename || null;
          item.sha256 = hash || crypto.createHash('sha256').update(buffer).digest('hex'); // hash of the file exactly as received
          item.caption = msg.media.caption || item.caption;

          const read = await docReader.processMedia({ buffer, mimeType: mt, msgType: msg.type });
          item.analysis = read.analysis;
          item.transcript = read.transcript;
          if (item.aiActive && read.idExtract) { item.idExtract = read.idExtract; item.idBuffer = buffer; }

          const ext = (String(read.storeMime || mt).split('/')[1] || 'bin').split(';')[0].replace('jpeg', 'jpg');
          item.mimeType = read.storeMime || mt;
          if (read.storeBuffer !== buffer) item.storedSha256 = crypto.createHash('sha256').update(read.storeBuffer).digest('hex');
          const key = item.caseId ? caseFileKey(item.caseId, item.evidenceId, ext) : unassignedFileKey(item.vendorId, item.evidenceId, item.mimeType);
          item.fileUrl = await storage.saveFile(read.storeBuffer, key, item.mimeType);
          if (read.storeBuffer !== buffer) require('../services/file-facts').recordBuffer(item.fileUrl, buffer, mt); // facts of the file exactly as the customer sent it
        } catch (e) {
          console.warn('WhatsApp media could not be downloaded/saved:', e.message);
          item.analysis = { documentType: 'other', extractedText: '', note: 'The file could not be downloaded from WhatsApp.' };
        }
      }
      prepared.push(item);
    }

    // Phase 2 — quick save on a fresh copy of the database.
    await db.read();
    for (const it of prepared) {
      const msg = it.msg;
      if (msg.id && db.data.evidence.some(e => e.waMessageId === msg.id)) continue;
      const fresh = it.caseId ? db.data.cases.find(x => x.id === it.caseId) : null;
      const receivedAt = new Date(Number(msg.timestamp) * 1000).toISOString();
      if (!fresh) {
        // No case: keep it for the firm, attach later from the dashboard.
        db.data.evidence.push({
          id: it.evidenceId, caseId: null, vendorId: it.vendorId, unassigned: true,
          source: 'whatsapp', type: msg.type, sender: msg.from, senderName: msg.fromName, waMessageId: msg.id || null,
          fileUrl: it.fileUrl, mimeType: it.mimeType, fileName: it.fileName, size: it.size, caption: it.caption,
          sha256: it.sha256, storedSha256: it.storedSha256, analysis: it.analysis,
          transcript: it.transcript || null, receivedAt
        });
        continue;
      }
      fresh.lastContactAt = receivedAt;

      if (it.transcript) {
        db.data.transcripts.push({
          id: uid('tr'), caseId: fresh.id, source: 'whatsapp_voice_note', evidenceId: it.evidenceId,
          speaker: msg.fromName || msg.from, original: it.transcript.original, english: it.transcript.english,
          language: it.transcript.language, timestamp: receivedAt
        });
      }

      db.data.evidence.push({
        id: it.evidenceId,
        caseId: fresh.id,
        vendorId: fresh.vendorId,
        waMessageId: msg.id || null,
        matchedBy: it.match ? it.match.how : null,
        needsReview: it.match && it.match.review ? it.match.review : null,
        source: 'whatsapp',
        type: msg.type,
        sender: msg.from,
        senderName: msg.fromName,
        fileUrl: it.fileUrl,
        mimeType: it.mimeType,
        fileName: it.fileName,
        size: it.size,
        caption: it.caption,
        sha256: it.sha256,
        storedSha256: it.storedSha256,
        analysis: it.analysis,
        receivedAt
      });

      db.data.custody.push({
        id: uid('cust'),
        caseId: fresh.id,
        event: `WhatsApp ${msg.type} received from ${msg.fromName || msg.from}${it.analysis && it.analysis.title ? ' — ' + it.analysis.title : ''}${it.analysis && it.analysis.maskedAadhaar ? ' (Aadhaar number masked before storing)' : ''}`,
        actor: 'whatsapp_webhook',
        hash: it.sha256,
        timestamp: new Date().toISOString()
      });

      // Live AI verification call waiting for Aadhaar / PAN: hand it the fields.
      if (it.idExtract && fresh.aiCall && fresh.aiCall.status === 'in_progress') {
        try { engine.applyIdMedia(fresh, it.idExtract, it.idBuffer, { analysis: it.analysis, evidenceId: it.evidenceId }); }
        catch (e) { console.warn('AI ID document apply failed:', e.message); }
      }
    }
    await db.write();
  } catch (err) {
    console.error('Error processing WhatsApp webhook:', err);
  }
});

// Send the intake template using the CASE's linked WhatsApp account.
router.post('/send-intake/:caseId', requireAuth, async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.caseId && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const account = db.data.whatsappAccounts.find(a => a.id === c.whatsappAccountId);
  if (!account) return res.status(400).json({ error: 'This case has no WhatsApp account linked. Connect one first.' });

  try {
    const templateName = req.body.templateName || 'claim_investigation_intake';
    const { customerLink, baseUrlFor } = require('./cases');
    const link = customerLink(c, baseUrlFor(req));
    const components = (req.body.components && req.body.components.length)
      ? req.body.components
      : [{ type: 'body', parameters: [{ type: 'text', text: link }] }];
    await wa.sendTemplateMessage(c.whatsappNumber, templateName, account, 'en', components);
    c.lastContactAt = new Date().toISOString();
    db.data.custody.push({
      id: uid('cust'),
      caseId: c.id,
      event: `Intake template "${templateName}" sent`,
      actor: 'agent',
      timestamp: new Date().toISOString()
    });
    await db.write();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claim cases: ask the customer (by WhatsApp text) to search their own WhatsApp
// and send screenshots of the results. A free-text message only reaches the
// customer if they messaged this number in the last 24 hours (WhatsApp rule).
router.post('/request-history/:caseId', requireAuth, async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.caseId && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const account = db.data.whatsappAccounts.find(a => a.id === c.whatsappAccountId);
  if (!account) return res.status(400).json({ error: 'This case has no WhatsApp account linked. Connect one first.' });
  const v = String(c.vehicleNo || '').replace(/\s/g, '');
  const words = ['accident / एक्सीडेंट', 'theft / चोरी', 'police / पुलिस', ...(v.length >= 4 ? [v.slice(-4)] : [])];
  const body = `नमस्ते${c.insuredName ? ' ' + c.insuredName : ''}। आपके क्लेम (${c.claimNo}) की जाँच के लिए, अपनी मर्ज़ी से, कृपया WhatsApp में ऊपर सर्च में ये शब्द एक-एक करके लिखें और हर बार नतीजों का स्क्रीनशॉट इसी चैट पर भेजें:\n${words.map(w => '• ' + w).join('\n')}\n\nFor your claim (${c.claimNo}): if you agree, please search your WhatsApp for the words above and send a screenshot of the results for each word on this chat. You decide what to send.`;
  try {
    await wa.sendTextMessage(c.whatsappNumber, body, account);
    c.lastContactAt = new Date().toISOString();
    db.data.custody.push({ id: uid('cust'), caseId: c.id, event: 'Customer asked on WhatsApp to search their chats (accident, theft, police) and send screenshots', actor: 'agent', timestamp: new Date().toISOString() });
    await db.write();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: /24|window|re-engage|131047/i.test(err.message) ? 'WhatsApp allows a normal message only within 24 hours of the customer\'s last message. Ask the customer to send any message first, or use the AI call.' : err.message });
  }
});

module.exports = router;
