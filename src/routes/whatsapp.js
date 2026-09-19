const express = require('express');
const crypto = require('crypto');
const { db, uid } = require('../db');
const wa = require('../services/whatsapp');
const gemini = require('../services/gemini');
const storage = require('../services/storage');
const { requireAuth } = require('../middleware/auth');

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

    for (const msg of messages) {
      // Match the sender to one of THIS vendor's cases only.
      const matchedCase = db.data.cases.find(
        c => c.vendorId === account.vendorId && c.whatsappNumber === msg.from.replace(/\D/g, '')
      );
      if (!matchedCase) {
        console.warn(`No case linked to WhatsApp number ${msg.from} for this vendor, evidence not filed.`);
        continue;
      }

      const evidenceId = uid('ev');
      let fileUrl = null;
      let mimeType = null;
      let sha256 = null;
      let caption = msg.text || null;
      let analysis = null;

      if (msg.media) {
        const { buffer, mimeType: mt, sha256: hash } = await wa.downloadMedia(msg.media.id, account.token);
        mimeType = mt;
        sha256 = hash || crypto.createHash('sha256').update(buffer).digest('hex');
        const ext = (mimeType.split('/')[1] || 'bin').split(';')[0];
        fileUrl = await storage.saveFile(buffer, `${evidenceId}.${ext}`, mimeType);
        caption = msg.media.caption || caption;

        if (msg.type === 'image') {
          try {
            analysis = await gemini.analyzeImage(buffer.toString('base64'), mimeType);
          } catch (e) {
            console.warn('Gemini image analysis failed:', e.message);
          }
        }
        if (msg.type === 'audio') {
          try {
            const t = await gemini.transcribeAndTranslateAudio(buffer.toString('base64'), mimeType);
            db.data.transcripts.push({
              id: uid('tr'),
              caseId: matchedCase.id,
              source: 'whatsapp_voice_note',
              speaker: msg.fromName || msg.from,
              original: t.original,
              english: t.english,
              language: t.language,
              timestamp: new Date().toISOString()
            });
          } catch (e) {
            console.warn('Gemini audio transcription failed:', e.message);
          }
        }
      }

      db.data.evidence.push({
        id: evidenceId,
        caseId: matchedCase.id,
        source: 'whatsapp',
        type: msg.type,
        sender: msg.from,
        senderName: msg.fromName,
        fileUrl,
        mimeType,
        caption,
        sha256,
        analysis,
        receivedAt: new Date(Number(msg.timestamp) * 1000).toISOString()
      });

      db.data.custody.push({
        id: uid('cust'),
        caseId: matchedCase.id,
        event: `WhatsApp ${msg.type} received from ${msg.fromName || msg.from}`,
        actor: 'whatsapp_webhook',
        hash: sha256,
        timestamp: new Date().toISOString()
      });
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
    await wa.sendTemplateMessage(c.whatsappNumber, templateName, account, 'en', req.body.components || []);
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

module.exports = router;
