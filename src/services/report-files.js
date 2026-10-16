// Shared helpers that put every received file (WhatsApp documents, photos,
// videos, voice notes, uploads) and every call recording into a report, with
// the text read from it and a permanent link (/f/<shareToken>/<evidenceId>).

const TYPE_LABEL = {
  image: 'Photo', document: 'Document', video: 'Video', audio: 'Voice note', text: 'Message',
  call_recording: 'Call recording', liveness_selfie: 'Live face photo', liveness_blink: 'Eye-blink check',
  body_standing: 'Full body — standing', body_sitting: 'Full body — sitting',
  live_photo: 'Photo from live video call'
};
const AI_PHOTO = ['liveness_selfie', 'liveness_blink', 'body_standing', 'body_sitting'];
const MAX_TEXT = 4000;

const clip = t => { const s = String(t || ''); return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + ' …' : s; };
const maskNum = n => (n ? '••••••' + String(n).replace(/\D/g, '').slice(-4) : '');

function fileLink(c, e) {
  return c.shareToken && e && e.fileUrl ? `/f/${c.shareToken}/${e.id}` : null;
}

function documentRows(c, evidence) {
  return evidence
    .filter(e => !AI_PHOTO.includes(e.type) && e.type !== 'call_recording')
    .sort((x, y) => new Date(x.receivedAt) - new Date(y.receivedAt))
    .map(e => {
      const a = e.analysis || {};
      return {
        id: e.id,
        kind: TYPE_LABEL[e.type] || e.type,
        source: e.source === 'whatsapp' ? 'WhatsApp' : e.source === 'ai_call' ? 'AI call' : e.source === 'participant' ? 'Customer upload' : (e.source || 'Upload'),
        from: e.senderName || maskNum(e.sender) || '',
        at: e.receivedAt,
        title: a.title || e.fileName || e.caption || TYPE_LABEL[e.type] || 'File',
        caption: e.caption || '',
        documentType: a.documentType || '',
        language: a.language || '',
        text: clip(a.extractedText || (e.type === 'text' ? e.caption : '') || (!a.extractedText && a.visibleText ? a.visibleText : '')),
        english: clip(a.englishText),
        keyDetails: a.keyDetails || '',
        observations: a.observations || (a.notableDetails && a.notableDetails !== a.note ? a.notableDetails : ''),
        note: a.note || '',
        maskedAadhaar: !!a.maskedAadhaar,
        mimeType: e.mimeType || '',
        hasFile: !!e.fileUrl,
        url: /^image\//.test(e.mimeType || '') ? e.fileUrl || null : null,
        link: fileLink(c, e),
        sha256: e.sha256 || ''
      };
    });
}

function recordingRows(c, evidence) {
  return evidence
    .filter(e => e.type === 'call_recording')
    .sort((x, y) => new Date(x.receivedAt) - new Date(y.receivedAt))
    .map(e => ({
      id: e.id,
      kind: e.source === 'ai_call' ? 'AI verification call' : e.source === 'external_call' ? ((e.analysis && e.analysis.title) || 'Call') + (e.screenShared ? ' with screen share' : '') + ' (recorded by executive)' : 'Executive video call',
      notes: (e.analysis && e.analysis.keyDetails) || '',
      by: e.takenBy || '',
      caption: e.caption || '',
      at: e.receivedAt,
      mimeType: e.mimeType || '',
      link: fileLink(c, e)
    }));
}

// Every message read from WhatsApp search-result screenshots (claim cases),
// with the D-number of the screenshot it came from and a permanent link.
function chatRows(c, evidence) {
  const docs = documentRows(c, evidence);
  const dno = new Map(docs.map((d, i) => [d.id, 'D' + (i + 1)]));
  const rows = [];
  for (const e of evidence) {
    const shot = e.analysis && e.analysis.chatScreenshot;
    if (!shot || !Array.isArray(shot.entries)) continue;
    const base = { searchTerm: shot.searchTerm || '', screenshot: dno.get(e.id) || '', link: fileLink(c, e), receivedAt: e.receivedAt };
    if (!shot.entries.length) rows.push({ ...base, chat: '', date: '', time: '', sender: '', text: '', english: '', noResults: true });
    for (const x of shot.entries) rows.push({ ...base, chat: x.chat || '', date: x.date || '', time: x.time || '', sender: x.sender || '', text: x.text || '', english: x.english || '' });
  }
  return rows.sort((x, y) => String(x.receivedAt).localeCompare(String(y.receivedAt)));
}

module.exports = { fileLink, documentRows, recordingRows, chatRows, AI_PHOTO, TYPE_LABEL };
