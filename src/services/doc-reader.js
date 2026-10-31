// Turns any file a customer sends on WhatsApp into stored evidence + text.
//
//   photo / scanned paper / PDF  -> full text (original + English), key details
//   Aadhaar photo                -> first 8 digits blacked out BEFORE storing
//   video (up to ~18 MB)         -> description + what people say
//   voice note                   -> transcript (original + English)
//
// No database access here (it is slow, Gemini work); the webhook saves the
// result afterwards. Full Aadhaar / PAN numbers in the text are masked to the
// last 4 digits before anything is returned for storage.

const gemini = require('./gemini');
const { redactIdsInText } = require('./security');

let sharp = null;
try { sharp = require('sharp'); } catch { sharp = null; }
// Photo handling can use a lot of memory on a small server: one picture at a time, small cache.
try { if (sharp) { sharp.cache({ memory: 32, files: 0, items: 20 }); sharp.concurrency(1); } } catch { /* older sharp */ }

const GEMINI_INLINE_MAX = 18 * 1024 * 1024; // keep the request under Gemini's inline limit
const r = t => redactIdsInText(String(t || '').trim());

async function normaliseImage(buffer) {
  if (!sharp) return buffer;
  try { return await sharp(buffer).rotate().jpeg({ quality: 88 }).toBuffer(); } catch { return buffer; }
}

// Black out the first 8 digits of every Aadhaar number box (UIDAI's masked-Aadhaar style).
async function maskAadhaar(jpegBuffer, boxes) {
  if (!sharp || !Array.isArray(boxes) || !boxes.length) return null;
  const meta = await sharp(jpegBuffer).metadata();
  const W = meta.width, H = meta.height;
  const rects = [];
  for (const b of boxes) {
    if (!Array.isArray(b) || b.length !== 4) continue;
    let [ymin, xmin, ymax, xmax] = b.map(Number);
    if (![ymin, xmin, ymax, xmax].every(isFinite) || ymax <= ymin || xmax <= xmin) continue;
    const padY = (ymax - ymin) * 0.25, padX = (xmax - xmin) * 0.03;
    const top = Math.max(0, Math.floor((ymin - padY) / 1000 * H));
    const left = Math.max(0, Math.floor((xmin - padX) / 1000 * W));
    const height = Math.min(H - top, Math.ceil((ymax - ymin + 2 * padY) / 1000 * H));
    // "XXXX XXXX 1234": the first 8 digits + 2 spaces are ~72% of the printed width
    const width = Math.min(W - left, Math.ceil(((xmax - xmin) * 0.70 + padX) / 1000 * W));
    if (width > 2 && height > 2) rects.push({ top, left, width, height });
  }
  if (!rects.length) return null;
  const overlays = rects.map(x => ({
    input: { create: { width: x.width, height: x.height, channels: 3, background: { r: 0, g: 0, b: 0 } } },
    top: x.top, left: x.left
  }));
  return sharp(jpegBuffer).composite(overlays).jpeg({ quality: 88 }).toBuffer();
}

/**
 * @returns {Promise<{ storeBuffer, storeMime, analysis, idExtract, transcript }>}
 */
async function processMedia({ buffer, mimeType, msgType }) {
  const out = { storeBuffer: buffer, storeMime: mimeType, analysis: null, idExtract: null, transcript: null };
  const mt = String(mimeType || '').toLowerCase();

  try {
    // ---- photos, scans and PDFs ----
    if (msgType === 'image' || /^image\//.test(mt) || mt === 'application/pdf') {
      const isImage = /^image\//.test(mt);
      const forAi = isImage ? await normaliseImage(buffer) : buffer;
      if (forAi.length > GEMINI_INLINE_MAX) {
        out.analysis = { documentType: 'other', title: 'Large file', extractedText: '', note: 'File too large to read automatically — open the file to view it.' };
        return out;
      }
      const d = await gemini.readDocument(forAi.toString('base64'), isImage ? 'image/jpeg' : mt);
      out.idExtract = {
        documentType: d.documentType, side: d.side || 'unknown', name: d.name || '', idNumber: d.idNumber || '',
        dob: d.dob || '', gender: d.gender || '', fatherName: d.fatherName || '', address: d.address || '',
        hasPhoto: !!d.hasPhoto, readable: d.readable !== false
      };
      const analysis = {
        documentType: d.documentType || 'other',
        title: d.title || '',
        language: d.language || '',
        extractedText: r(d.extractedText),
        englishText: r(d.englishText),
        keyDetails: r(d.keyDetails),
        observations: r(d.observations),
        readable: d.readable !== false
      };
      if (d.chatScreenshot && Array.isArray(d.chatScreenshot.entries)) {
        analysis.chatScreenshot = {
          app: d.chatScreenshot.app || '', searchTerm: r(d.chatScreenshot.searchTerm || ''),
          entries: d.chatScreenshot.entries.slice(0, 60).map(e => ({ chat: r(e.chat), date: r(e.date), time: r(e.time), sender: r(e.sender), text: r(e.text), english: r(e.english) }))
        };
      }
      if (d.documentType === 'aadhaar') {
        if (isImage) {
          const masked = await maskAadhaar(forAi, d.aadhaarNumberBoxes).catch(() => null);
          if (masked) { out.storeBuffer = masked; out.storeMime = 'image/jpeg'; analysis.maskedAadhaar = true; }
          else if (d.idNumber || (d.aadhaarNumberBoxes || []).length || /\d{4}\s?\d{4}\s?\d{4}/.test(d.extractedText || '')) analysis.note = 'The Aadhaar number could not be blacked out automatically on this image. Handle this file carefully.';
          else analysis.note = 'No Aadhaar number was found on this side of the card, so nothing needed to be blacked out.';
        } else {
          analysis.note = 'Aadhaar received as a PDF; the number in the file is not masked. Handle this file carefully.';
        }
      }
      // legacy fields used by older screens
      analysis.visibleText = analysis.keyDetails || analysis.extractedText.slice(0, 500);
      analysis.notableDetails = analysis.observations || analysis.note || '';
      out.analysis = analysis;
      return out;
    }

    // ---- videos ----
    if (msgType === 'video' || /^video\//.test(mt)) {
      if (buffer.length > GEMINI_INLINE_MAX) {
        out.analysis = { documentType: 'video', title: 'Video', extractedText: '', note: 'Video too large to read automatically — open the file to watch it.' };
        return out;
      }
      const v = await gemini.describeVideo(buffer.toString('base64'), mt || 'video/mp4');
      out.analysis = {
        documentType: 'video', title: v.title || 'Video',
        keyDetails: r(v.description), extractedText: r(v.speech), englishText: r(v.speechEnglish),
        observations: r(v.observations),
        visibleText: r(v.description), notableDetails: r(v.observations)
      };
      return out;
    }

    // ---- voice notes ----
    if (msgType === 'audio' || /^audio\//.test(mt)) {
      const t = await gemini.transcribeAndTranslateAudio(buffer.toString('base64'), mt || 'audio/ogg');
      out.transcript = t;
      out.analysis = {
        documentType: 'voice_note', title: 'Voice note', language: t.language || '',
        extractedText: r(t.original), englishText: t.english && t.english !== t.original ? r(t.english) : '',
        visibleText: r(t.english || t.original)
      };
      return out;
    }

    // ---- anything else (Word, Excel, zip ...) ----
    out.analysis = { documentType: 'other', title: 'File', extractedText: '', note: 'This file type is not read automatically — open the file to view it.' };
    return out;
  } catch (e) {
    console.warn('Document reading failed:', e.message);
    out.analysis = { documentType: 'other', title: '', extractedText: '', note: 'The text could not be read automatically — open the file to view it.' };
    return out;
  }
}

module.exports = { processMedia, maskAadhaar };
