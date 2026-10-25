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

const CLR = { focus: '#c62828', check: '#b7791f', clear: '#2e7d32', none: '#9aa0aa' };
const RANK = { none: 0, clear: 1, check: 2, focus: 3 };
const STATE_WORD = { focus: 'Focus', check: 'Check', clear: 'Clear', none: 'Not checked' };
const RES_STATE = { fail: 'focus', mismatch: 'focus', discrepancy: 'focus', partial: 'check', pass: 'clear', match: 'clear', confirmed: 'clear' };
const DETAIL_LABELS = { mobile: 'Mobile', email: 'Email', dob: 'Date of birth', gender: 'Gender', address: 'Address', city: 'City', state: 'State', pincode: 'Pincode',
  insurerName: 'Insurance company', verificationType: 'Verification type', productName: 'Product / plan', policyStartDate: 'Policy start date', premium: 'Premium', nomineeName: 'Nominee',
  claimType: 'Claim type', claimAmount: 'Claim amount', incidentDate: 'Incident date', incidentPlace: 'Incident place', hospitalName: 'Hospital', admissionDate: 'Admission date',
  dischargeDate: 'Discharge date', diagnosis: 'Diagnosis', vehicleMake: 'Vehicle make / model', branch: 'Branch', agentName: 'Agent / advisor',
  clientName: 'Client', position: 'Position', employeeId: 'Employee ID',
  policyEndDate: 'Policy end date', annualIncome: 'Yearly income', premiumFrequency: 'Premium frequency', garageName: 'Garage',
  employer1Name: 'Latest employer', employer1From: 'Latest job from', employer1To: 'Latest job to', employer2Name: 'Previous employer',
  employer2From: 'Previous job from', employer2To: 'Previous job to', passingYear: 'Passing year', remarks: 'Remarks' };

// Groups everything the call found into the areas of THIS service (service-profiles.js).
// Each area gets the worst result among its items, and the reasons behind anything not clear.
const profiles = require('./service-profiles');
function glance(R, rv) {
  const prof = profiles.profileOf(R.meta.service);
  const tiles = prof.areas.map(([key, label, rule]) => ({ key, label, rule, state: 'none', note: '', reasons: [], n: 0 }));
  const bump = (t, st, why) => { if (RANK[st] > RANK[t.state]) t.state = st; if ((st === 'focus' || st === 'check') && why && t.reasons.length < 3 && !t.reasons.includes(why)) t.reasons.push(why); };
  const withSrc = k => tiles.filter(t => (t.rule.src || []).includes(k));
  const fallback = tiles.find(t => t.key === 'identity');
  for (const k of R.checks || []) {
    const st = RES_STATE[k.result]; if (!st) continue;
    const t = (k.area && tiles.find(x => x.key === k.area)) || tiles.find(x => x.rule.checks && x.rule.checks.test(k.id || '')) || (/^(consistency|age_|answer)/.test(k.id || '') ? null : fallback);
    const target = t || tiles.find(x => x.rule.sections && x.rule.sections.length) || fallback;
    target.n++; bump(target, st, (/_api$/.test(k.id || '') ? 'Official: ' : 'AI: ') + (k.detail ? `${k.label} - ${k.detail}` : k.label));
  }
  for (const sec of R.sections || []) for (const q of sec.qa) {
    const t = tiles.find(x => (x.rule.keys || []).includes(q.key)) || tiles.find(x => (x.rule.sections || []).includes(sec.key) && !(x.rule.skipKeys || []).includes(q.key));
    if (!t) continue;
    if (q.answer) { t.n++; bump(t, 'clear'); }
    if (q.concern) bump(t, t.rule.concern || 'check', 'AI: ' + q.concern); // mis-selling, a criminal case: a concern there is a focus point
  }
  for (const t of withSrc('location')) {
    if ((R.locations || []).length || R.call.startLocation) { t.n++; bump(t, 'clear'); }
    if (R.call.device) { t.n++; bump(t, 'clear'); }
  }
  for (const t of withSrc('docs')) if ((R.received || []).length || (R.documents.aadhaar || {}).masked || (R.documents.pan || {}).masked) { t.n++; bump(t, 'clear'); }
  // record rules: to the box they name (area), else the triggers box, else documents, else identity
  const trigBox = withSrc('triggers')[0] || tiles.find(t => t.key === 'docs') || fallback;
  for (const x of R.triggers || []) {
    if (x.state === 'none') continue;
    const t = (x.area && tiles.find(y => y.key === x.area)) || (x.area === 'docs' && tiles.find(y => (y.rule.src || []).includes('docs'))) || trigBox;
    t.n++; bump(t, x.state, `Record: ${x.label} - ${x.detail}`);
  }
  for (const t of withSrc('signoff')) {
    if (rv) { t.n++; bump(t, rv.finalVerdict === 'verified' ? 'clear' : rv.finalVerdict === 'found_discrepancy' || rv.finalVerdict === 'unverified' ? 'focus' : 'check', rv.remarks || VERDICT[rv.finalVerdict]); }
    else if (R.call.status === 'completed') bump(t, 'check', 'Waiting for a person to sign off');
  }
  for (const t of tiles) {
    t.note = t.state === 'none' ? (t.key === 'signoff' ? 'Not reviewed yet' : 'Not covered in this call')
      : t.reasons[0] || (t.n ? `${t.n} item${t.n > 1 ? 's' : ''} checked, all clear` : 'Clear');
  }
  const count = { focus: 0, check: 0, clear: 0 };
  tiles.forEach(t => { if (count[t.state] != null) count[t.state]++; });
  return { tiles, count, prof };
}

const clean = v => String(v == null ? '' : v).replace(/₹/g, 'Rs.').replace(/•/g, 'x').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
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

    // ---- page 1: at a glance ----
    // Like a lab "smart report": the case in the middle, each area of the check around it,
    // coloured by result, so the reader sees at once where to focus.
    const PW = doc.page.width;
    doc.rect(0, 0, PW, 92).fill(BRAND);
    let x = 48;
    const logo = logoBuffer(opts.logoDataUrl);
    if (logo) { try { doc.image(logo, 48, 20, { fit: [80, 52] }); x = 140; } catch { /* bad logo: ignore */ } }
    const pl = brand.logo('logo-compact');
    if (pl) { doc.roundedRect(48 + W - 120, 24, 120, 44, 8).fill('#fff'); try { doc.image(pl, 48 + W - 112, 29, { fit: [104, 34], align: 'center', valign: 'center' }); } catch { /* ignore */ } }
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(19).text(clean(R.meta.firm) || 'Praman', x, 26, { width: W - (x - 48) - 135, lineBreak: false, ellipsis: true });
    doc.font('Helvetica').fontSize(10).fillColor('#cfd6ff').text('Verification report  |  At a glance', x, 52);

    const G = glance(R, rv);
    const vWord = (rv ? G.prof.verdict[rv.finalVerdict] : G.prof.verdict[R.result.decision]) || verdict;
    const VC = { verified: CLR.clear, partially_verified: CLR.check, pending_verification: CLR.check, handoff: CLR.check, found_discrepancy: CLR.focus, unverified: CLR.focus };
    const vKey = rv ? rv.finalVerdict : (R.result.decision || 'pending_verification');
    const vColor = VC[vKey] || CLR.none;

    // title + case facts (left), result box (right)
    const BX = 48 + W - 168;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(17).text(clean(G.prof.title), 48, 112, { width: W - 185 });
    doc.font('Helvetica').fontSize(9).fillColor(MUTE).text(`Report no. ${clean(R.meta.reportNo)}   |   Created ${ist(R.meta.generatedAt)}`, 48, doc.y + 2, { width: W - 185 });
    const d = R.case.details || {};
    const isBgv = R.meta.service === 'bgv_employee';
    const facts = [
      [G.prof.person, R.case.insuredName], ['WhatsApp', R.case.whatsapp], ['Mobile', d.mobile], ['Email', d.email],
      ['City / State', [d.city || R.case.district, d.state].filter(Boolean).join(', ')], ...(isBgv ? [] : [['Insurer', d.insurerName]]),
      [R.meta.isPolicy ? 'Policy no.' : isBgv ? 'Case no.' : 'Claim no.', R.case.claimNo], ...(R.case.policyNo && R.case.policyNo !== R.case.claimNo ? [['Policy no.', R.case.policyNo]] : []),
      ...G.prof.facts(d, R.case),
      ['Call', R.call.startedAt ? `${new Date(R.call.startedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })}${R.call.durationMin ? ', ' + R.call.durationMin + ' min' : ''}${R.call.language ? ', ' + R.call.language : ''}` : 'Not held']
    ].filter(f => f[1] && String(f[1]).trim());
    if (facts.length > 10) facts.splice(9, facts.length - 10); // keep the call line last
    let fy = doc.y + 10;
    const colW = (W - 185) / 2;
    facts.forEach((f, i) => {
      const cx = 48 + (i % 2) * colW, cy = fy + Math.floor(i / 2) * 25;
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTE).text(f[0].toUpperCase(), cx, cy, { width: colW - 8, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(clean(f[1]), cx, cy + 10, { width: colW - 8, height: 12, ellipsis: true });
    });
    const factsBottom = fy + Math.ceil(facts.length / 2) * 25;

    doc.roundedRect(BX, 108, 168, 132, 10).fill(vColor);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8).text('RESULT', BX, 122, { width: 168, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(vWord.length > 18 ? 13.5 : 16).text(clean(vWord), BX + 10, 138, { width: 148, align: 'center' });
    doc.font('Helvetica').fontSize(8.5).text(rv ? 'Signed off by a person' : 'AI result, not yet signed off', BX + 10, doc.y + 4, { width: 148, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(9).text(`${G.count.focus} focus  |  ${G.count.check} check  |  ${G.count.clear} clear`, BX + 6, 216, { width: 156, align: 'center' });

    // the hub
    const top = Math.max(factsBottom, 252) + 14;
    doc.font('Helvetica-Bold').fontSize(12).fillColor(BRAND).text('Where to focus', 48, top);
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTE).text('Each box is one area of the verification. Red boxes are where the reader should look first.', 48, doc.y + 1, { width: W });
    const rows = Math.ceil(G.tiles.length / 2), TW = 178, GAP = rows > 4 ? 8 : 12, TH = rows > 4 ? 52 : 64;
    const hubTop = doc.y + 10;
    const cxm = 48 + W / 2, cym = hubTop + (rows * TH + (rows - 1) * GAP) / 2;
    const slots = G.tiles.map((t, i) => ({ t, x: i < rows ? 48 : 48 + W - TW, y: hubTop + (i % rows) * (TH + GAP) }));
    slots.forEach(({ t, x: tx, y: ty }) => {
      const ex = tx === 48 ? tx + TW : tx, ey = ty + TH / 2;
      doc.moveTo(cxm, cym).lineTo(ex, ey).lineWidth(t.state === 'focus' ? 1.6 : 0.8);
      if (t.state === 'none') doc.dash(3, { space: 3 });
      doc.stroke(t.state === 'none' ? '#cfd3da' : CLR[t.state]);
      doc.undash();
    });
    doc.circle(cxm, cym, 58).fill('#eef1f8');
    doc.circle(cxm, cym, 46).fill(BRAND);
    const initials = clean(R.case.insuredName).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'C';
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(22).text(initials, cxm - 46, cym - 16, { width: 92, align: 'center' });
    doc.font('Helvetica').fontSize(7.5).fillColor('#cfd6ff').text(clean(R.case.caseRef) || 'Case', cxm - 46, cym + 10, { width: 92, align: 'center', lineBreak: false });
    slots.forEach(({ t, x: tx, y: ty }) => {
      const col = CLR[t.state], faded = t.state === 'none';
      doc.roundedRect(tx, ty, TW, TH, 8).lineWidth(t.state === 'focus' ? 2 : 0.8).fillAndStroke(t.state === 'focus' ? '#fdeeee' : '#ffffff', faded ? '#dfe2e8' : col);
      doc.circle(tx + 14, ty + 15, 4.5).fill(faded ? '#c9cdd4' : col);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(faded ? '#a3a8b2' : INK).text(t.label, tx + 24, ty + 9, { width: TW - 32, height: 13, ellipsis: true });
      doc.font('Helvetica-Bold').fontSize(7.6).fillColor(faded ? '#a3a8b2' : col).text(STATE_WORD[t.state].toUpperCase() + '  ', tx + 12, ty + 25, { width: TW - 22, height: TH - 28, ellipsis: true, continued: true })
        .font('Helvetica').fillColor(faded ? '#a3a8b2' : MUTE).text(clean(t.note));
    });

    // look here first
    let ly = hubTop + rows * TH + (rows - 1) * GAP + 14;
    const todo = G.tiles.filter(t => t.state === 'focus' || t.state === 'check').sort((a1, b1) => RANK[b1.state] - RANK[a1.state]);
    const items = [];
    todo.forEach(t => t.reasons.forEach(r => items.push([t, r])));
    (R.result.flags || []).forEach(f => { if (!items.some(i => String(i[1]).includes(f))) items.push([{ label: 'Flag', state: 'focus' }, 'AI: ' + f]); });
    const room2 = Math.max(1, Math.floor((doc.page.height - 112 - ly - 30) / 15));
    const show = items.slice(0, Math.min(5, room2));
    const boxH = 30 + Math.max(1, show.length) * 15;
    doc.roundedRect(48, ly, W, boxH, 8).lineWidth(0.8).stroke(LINE);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(show.length ? 'Look here first' : 'Nothing needs attention', 60, ly + 9);
    let iy = ly + 25;
    if (!show.length) doc.font('Helvetica').fontSize(8.5).fillColor(MUTE).text('Every area that was checked came out clear. Grey areas were not part of this verification.', 60, iy, { width: W - 24 });
    show.forEach(([t, r]) => {
      doc.circle(64, iy + 4, 3).fill(CLR[t.state] || CLR.focus);
      const lab = clean(t.label) + ': ', room1 = 108 - lab.length;
      const txt = clean(r).length > room1 ? clean(r).slice(0, room1 - 3).trim() + '...' : clean(r);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(lab, 74, iy, { continued: true, width: W - 40, height: 11 })
        .font('Helvetica').fillColor(MUTE).text(txt, { height: 11 });
      iy += 15;
    });
    if (items.length > show.length) doc.font('Helvetica').fontSize(8).fillColor(MUTE).text(`+ ${items.length - show.length} more in the pages that follow`, 48 + W - 200, ly + 10, { width: 188, align: 'right' });

    // legend + fingerprint
    const lgY = Math.min(ly + boxH + 8, doc.page.height - 96);
    [['focus', 'Focus: look first'], ['check', 'Check: partly matched'], ['clear', 'Clear'], ['none', 'Not checked']].forEach(([k, t], i) => {
      const lx = 48 + i * 125; doc.circle(lx + 4, lgY + 4, 3.5).fill(k === 'none' ? '#c9cdd4' : CLR[k]);
      doc.font('Helvetica').fontSize(8).fillColor(MUTE).text(t, lx + 12, lgY, { lineBreak: false });
    });
    doc.font('Helvetica').fontSize(7.2).fillColor(MUTE).text('Trigger and repeat checks come from records (exact rules, no AI). Photo, voice and document readings are AI findings that a person confirms.', 48, doc.page.height - 80, { width: W });
    doc.font('Helvetica').fontSize(6.8).fillColor(MUTE).text('Integrity fingerprint (SHA-256): ' + R.meta.fingerprint + '. If anything in this report is changed later, this value changes.', 48, doc.page.height - 66, { width: W, lineBreak: true });

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
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text('Case details', 48, 56);
    doc.moveDown(0.3);
    {
      const dd = R.case.details || {};
      const all = [['Case', R.case.caseRef], ['Claim / policy no.', R.case.claimNo], ['Policy no.', R.case.policyNo], ['Customer', R.case.insuredName], ['WhatsApp', R.case.whatsapp],
        ['Vehicle no.', R.case.vehicleNo], ['District', R.case.district], ['Sum assured', R.case.policyValue ? 'Rs. ' + Number(R.case.policyValue).toLocaleString('en-IN') : ''],
        ['Customer language', R.call.language], ['Call date', R.call.startedAt ? ist(R.call.startedAt) : ''], ['Call length', R.call.durationMin ? R.call.durationMin + ' min' : '']]
        .concat(Object.entries(DETAIL_LABELS).map(([k, l]) => [l, ['claimAmount', 'premium', 'annualIncome'].includes(k) ? profiles.money(dd[k]) : dd[k]]))
        .filter(f => f[1] && String(f[1]).trim());
      for (let i = 0; i < all.length; i += 2) {
        const y = doc.y; const half = W / 2;
        [all[i], all[i + 1]].forEach((f, j) => { if (!f) return; doc.font('Helvetica').fontSize(8.5).fillColor(MUTE).text(f[0], 48 + j * half, y, { width: 105 }); doc.fillColor(INK).text(clean(f[1]), 48 + j * half + 108, y, { width: half - 116 }); });
        doc.y = Math.max(doc.y, y + 12) + 3;
      }
    }
    if ((R.triggers || []).length) {
      H('Trigger check');
      P('Exact rules on the case record, dates, amounts, files and the firm\'s other cases. No AI is used here: the same data always gives the same result.', { size: 8.5, color: MUTE });
      row(['Trigger', 'Result', 'Detail'], [170, 70, W - 240], { head: true });
      R.triggers.forEach(t => row([t.label, STATE_WORD[t.state] === 'Not checked' ? 'No data' : STATE_WORD[t.state], t.detail || ''], [170, 70, W - 240]));
    }
    {
      const rec = (R.checks || []).filter(k => /^rec_/.test(k.id || ''));
      if (rec.length) {
        H('Insurer details vs what the customer said');
        P('Each detail was asked on the call without telling the customer the value on record. The AI wrote down the answer; dates, amounts and numbers are compared by exact rules.', { size: 8.5, color: MUTE });
        row(['Detail', 'On record', 'Customer said', 'Result'], [130, 135, 160, W - 425], { head: true });
        const show = (k, v) => v && k.type === 'amount' ? profiles.money(v) : v;
        rec.forEach(k => row([k.label.replace(/: customer vs record$/, ''), show(k, k.expected) || '', show(k, k.said) || '(not said)', RESULT[k.result] || k.result], [130, 135, 160, W - 425]));
      }
    }
    {
      const worst = G.count.focus ? 'focus' : G.count.check ? 'check' : 'clear';
      const steps = G.prof.next[worst] || [];
      if (steps.length) {
        H(worst === 'clear' ? 'Suggested next step' : 'Suggested next steps');
        steps.forEach((t, i) => P(`${i + 1}. ${t}`, { gap: 0.2 }));
        P('Suggestions only. The final decision stays with the insurer / reviewer.', { size: 8.5, color: MUTE });
      }
    }
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text('Summary', 48, doc.y);
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
      P('Checks made during the call. "Official" = matched with a government record. "AI + rule" = the AI wrote down what the customer said, the comparison with the record is an exact rule. "AI" = an AI finding that a person should confirm.', { size: 8.5, color: MUTE });
      row(['Check', 'Result', 'Source', 'Detail'], [175, 62, 58, W - 295], { head: true });
      R.checks.forEach(k => row([k.label, RESULT[k.result] || k.result, /_api$/.test(k.id || '') ? 'Official' : /^rec_/.test(k.id || '') ? 'AI + rule' : 'AI', k.detail || ''], [175, 62, 58, W - 295]));
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

module.exports = { render, clean, glance };
