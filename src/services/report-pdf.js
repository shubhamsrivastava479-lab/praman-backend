// Server-made PDF of the verification report (cover page, firm logo, page numbers).
// Built from the same data as the on-screen report, so both always agree.
// pdfkit's built-in font covers English only, so other scripts are left out of the PDF
// (the original-language text stays in the on-screen report).
const PDFDocument = require('pdfkit');

const VERDICT = {
  verified: 'Verified', partially_verified: 'Partially verified', found_discrepancy: 'Discrepancy found',
  unverified: 'Unverified', pending_verification: 'Pending review', handoff: 'Handed over to an executive'
};
const RESULT = { match: 'Match', pass: 'Pass', partial: 'Partial', mismatch: 'Mismatch', fail: 'Fail', unknown: 'Not checked', skipped: 'Skipped', confirmed: 'Confirmed', discrepancy: 'Discrepancy', pending: 'Pending' };
const brand = require('./brand');
const INK = '#1b2233', MUTE = '#667', BRAND = brand.NAVY, LINE = '#d9dce6';

const clean = v => String(v == null ? '' : v).replace(/₹/g, 'Rs.').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
  .replace(/[^\x09\x0A\x20-\x7E -ÿ]/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+\n/g, '\n').trim();
const ist = d => d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' IST' : '-';

function logoBuffer(dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  return m ? Buffer.from(m[2], 'base64') : null;
}

function render(R, opts = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: `Verification report ${clean(R.meta.reportNo)}`, Author: clean(R.meta.firm) || 'Praman', Subject: 'Verification report' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width - 96;
    const rv = R.review && R.review.finalVerdict && R.review.finalVerdict !== 'pending_verification' ? R.review : null;
    const verdict = rv ? VERDICT[rv.finalVerdict] : (VERDICT[R.result.decision] || 'Not completed');
    const verdictBy = rv ? `Final verdict by ${clean(rv.reviewerName) || 'reviewer'}` : 'AI result - not yet signed off by a person';

    // ---- cover ----
    doc.rect(0, 0, doc.page.width, 150).fill(BRAND);
    let x = 48;
    const logo = logoBuffer(opts.logoDataUrl);
    if (logo) { try { doc.image(logo, 48, 36, { fit: [90, 60] }); x = 150; } catch { /* bad logo: ignore */ } }
    const pl = brand.logo('logo-compact');
    if (pl) { doc.roundedRect(48 + W - 132, 34, 132, 52, 8).fill('#fff'); try { doc.image(pl, 48 + W - 124, 40, { fit: [116, 40], align: 'center', valign: 'center' }); } catch { /* ignore */ } }
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(22).text(clean(R.meta.firm) || 'Praman', x, 42, { width: W - (x - 48) - 150 });
    doc.font('Helvetica').fontSize(11).fillColor('#cfd6ff').text('Verification report', x, doc.y + 2);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(26).text(clean(R.meta.caseTypeLabel).replace(/^./, ch => ch.toUpperCase()), 48, 190, { width: W });
    doc.moveDown(0.3).font('Helvetica').fontSize(13).fillColor(MUTE).text(`Report no. ${clean(R.meta.reportNo)}`);
    doc.moveDown(1.2);
    const kv = [['Case', clean(R.case.caseRef)], ['Claim / policy no.', clean(R.case.claimNo)], ['Customer', clean(R.case.insuredName) || '-'], ['Customer language', clean(R.call.language) || '-'], ['Call date', ist(R.call.startedAt)], ['Call length', R.call.durationMin ? R.call.durationMin + ' min' : '-'], ['Report created', ist(R.meta.generatedAt)]];
    for (const [k, v] of kv) { const y = doc.y; doc.font('Helvetica').fontSize(11).fillColor(MUTE).text(k, 48, y, { width: 140 }); doc.fillColor(INK).text(v, 190, y, { width: W - 142 }); doc.y = Math.max(doc.y, y + 16) + 3; }
    doc.moveDown(1);
    const by = doc.y;
    doc.roundedRect(48, by, W, 78, 8).lineWidth(1).stroke(LINE);
    doc.font('Helvetica').fontSize(10).fillColor(MUTE).text('RESULT', 64, by + 12);
    doc.font('Helvetica-Bold').fontSize(22).fillColor(BRAND).text(verdict, 64, by + 28);
    doc.font('Helvetica').fontSize(10).fillColor(MUTE).text(verdictBy, 64, by + 56);
    doc.y = by + 100;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTE).text('Integrity fingerprint (SHA-256): ' + R.meta.fingerprint, 48, doc.y, { width: W });
    doc.text('If anything in this report is changed later, this value changes. The same value is shown on the on-screen report.', { width: W });

    // ---- helpers ----
    const room = n => { if (doc.y + n > doc.page.height - 70) doc.addPage(); };
    const H = t => { room(60); doc.moveDown(0.8).font('Helvetica-Bold').fontSize(13).fillColor(BRAND).text(t, 48, doc.y, { width: W }); doc.moveTo(48, doc.y + 2).lineTo(48 + W, doc.y + 2).lineWidth(0.7).stroke(LINE); doc.moveDown(0.5); };
    const P = (t, o = {}) => { room(30); doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size || 10).fillColor(o.color || INK).text(clean(t), 48, doc.y, { width: W, ...o.opts }); doc.moveDown(o.gap == null ? 0.35 : o.gap); };
    const row = (cols, widths, o = {}) => {
      const hs = cols.map((c, i) => doc.heightOfString(clean(c), { width: widths[i] - 8 }));
      const h = Math.max(...hs) + 6; room(h + 4);
      const y = doc.y; let cx = 48;
      cols.forEach((c, i) => { doc.font(o.head ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(o.head ? MUTE : INK).text(clean(c), cx + 2, y + 3, { width: widths[i] - 8 }); cx += widths[i]; });
      doc.y = y + h; doc.moveTo(48, doc.y).lineTo(48 + W, doc.y).lineWidth(0.4).stroke(LINE);
    };

    // ---- body ----
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text('Summary', 48, 56);
    doc.moveDown(0.4);
    P(R.result.summary || 'No summary was written.');
    if ((R.result.flags || []).length) { H('Points that need attention'); R.result.flags.forEach(f => P('- ' + f, { color: '#8a1f1f' })); }
    if ((R.result.liveCallReasons || []).length) { H('Live call recommended'); R.result.liveCallReasons.forEach(f => P('- ' + f)); }
    if (R.recordingMissing) P('The call recording is missing for this case.', { color: '#8a1f1f', bold: true });

    if (R.checklist && R.checklist.items && R.checklist.items.length) {
      H(`Checklist (${R.checklist.done} of ${R.checklist.total} done)`);
      const ST = { done: 'Done', partial: 'Partly', not_done: 'Not done', pending: 'Pending' };
      row(['Item', 'Status', 'Detail'], [190, 70, W - 260], { head: true });
      R.checklist.items.forEach(i => row([i.label + (i.mandatory ? ' (required)' : ''), ST[i.status] || i.status, i.detail || ''], [190, 70, W - 260]));
    }
    if ((R.checks || []).length) {
      H('Automatic checks');
      row(['Check', 'Result', 'Detail'], [190, 70, W - 260], { head: true });
      R.checks.forEach(k => row([k.label, RESULT[k.result] || k.result, k.detail || ''], [190, 70, W - 260]));
    }
    const docsLines = [];
    const a = R.documents.aadhaar || {}, p = R.documents.pan || {};
    if (a.masked || a.name) docsLines.push(['Aadhaar', `${a.name || ''} ${a.masked ? '(' + a.masked + ')' : ''} ${a.dob ? 'DOB ' + a.dob : ''}`, R.idSources.aadhaar]);
    if (p.masked || p.name) docsLines.push(['PAN', `${p.name || ''} ${p.masked ? '(' + p.masked + ')' : ''}`, R.idSources.pan]);
    if (docsLines.length) { H('Identity documents'); docsLines.forEach(d => { P(`${d[0]}: ${d[1]}`, { gap: 0 }); P(d[2], { color: MUTE, size: 9 }); }); }

    (R.sections || []).forEach(sec => {
      if (!sec.qa.length) return;
      H(sec.label);
      sec.qa.forEach(q => { P('Q: ' + q.question, { color: MUTE, size: 9.5, gap: 0.05 }); P('A: ' + (q.answer || '-'), { bold: true, gap: q.concern ? 0.05 : 0.4 }); if (q.concern) P('Concern: ' + q.concern, { color: '#8a1f1f', size: 9 }); });
    });

    H('Sign-off');
    if (rv) {
      P(`${VERDICT[rv.finalVerdict] || rv.finalVerdict} - ${clean(rv.reviewerName) || 'reviewer'}${rv.reviewerDesignation ? ', ' + clean(rv.reviewerDesignation) : ''} - ${ist(rv.reviewedAt)}`, { bold: true });
      if (rv.remarks) P(rv.remarks);
    } else P('Not yet signed off by a person.');
    (R.reviewHistory || []).forEach(h => P(`Earlier: ${VERDICT[h.finalVerdict] || h.finalVerdict} - ${clean(h.reviewerName) || '-'} - ${ist(h.reviewedAt)}${h.remarks ? ' - ' + clean(h.remarks) : ''}`, { size: 9, color: MUTE }));

    if ((R.custody || []).length) {
      H('Activity record');
      R.custody.slice(-40).forEach(c => P(`${ist(c.at)}  ${c.event}`, { size: 8.5, gap: 0.15 }));
      if (R.custody.length > 40) P(`(${R.custody.length - 40} earlier entries are in the on-screen report)`, { size: 8.5, color: MUTE });
    }

    // ---- page footer ----
    const n = doc.bufferedPageRange().count;
    for (let i = 0; i < n; i++) {
      doc.switchToPage(i); doc.page.margins.bottom = 0; // footer sits inside the bottom margin
      doc.font('Helvetica').fontSize(8).fillColor(MUTE);
      doc.text(`${clean(R.meta.firm)} - ${clean(R.meta.reportNo)}`, 48, doc.page.height - 38, { width: W / 2, lineBreak: false });
      const fl = brand.logo('logo-compact'); if (fl) { try { doc.image(fl, 48 + W / 2 - 24, doc.page.height - 44, { fit: [48, 18] }); } catch { /* ignore */ } }
      doc.text(`Page ${i + 1} of ${n}`, 48 + W / 2, doc.page.height - 38, { width: W / 2, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { render, clean };
