// Server-made PDF of an invoice. English only (pdfkit built-in font), "Rs." instead of the rupee sign.
const PDFDocument = require('pdfkit');
const billing = require('./billing');
const { clean } = require('./report-pdf');
const brand = require('./brand');
const INK = '#1b2233', MUTE = '#667', BRAND = brand.NAVY, LINE = '#d9dce6';
const money = n => 'Rs. ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = d => d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '-';

function render(inv) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Invoice ${clean(inv.number || 'DRAFT')}`, Author: clean((inv.seller && inv.seller.legalName) || 'Praman') } });
    const chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width - 96, L = 48, R = L + W;
    const v = billing.view(inv), S = inv.seller || {}, B = inv.buyer || {};
    const draft = inv.status === 'draft';

    doc.rect(0, 0, doc.page.width, 8).fill(BRAND);
    const lg = brand.logo('logo-compact');
    if (lg) { try { doc.image(lg, L, 28, { fit: [150, 50] }); } catch { /* ignore */ } }
    doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(lg ? 11 : 20).text(clean(S.legalName) || 'Praman', L, lg ? 82 : 34, { width: W * 0.6 });
    doc.fillColor(MUTE).font('Helvetica').fontSize(9).text([clean(S.address), S.gstin ? 'GSTIN: ' + S.gstin : '', S.pan ? 'PAN: ' + S.pan : '', clean(S.email), clean(S.phone)].filter(Boolean).join('\n'), L, doc.y + 2, { width: W * 0.6 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(draft ? 'DRAFT' : (S.gstin ? 'TAX INVOICE' : 'INVOICE'), L, 34, { width: W, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor(INK)
      .text(`Invoice no: ${clean(inv.number || '(not issued)')}`, L, 58, { width: W, align: 'right' })
      .text(`Date: ${day(inv.issuedAt || inv.createdAt)}`, { width: W, align: 'right' })
      .text(`Due: ${day(inv.dueAt)}`, { width: W, align: 'right' })
      .text(`Period: ${billing.monthLabel(inv.period)}`, { width: W, align: 'right' });
    let y = Math.max(doc.y, 150) + 10;
    doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).stroke(); y += 10;
    doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(8).text('BILL TO', L, y);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(clean(B.legalName || inv.vendorName), L, y + 12, { width: W * 0.6 });
    doc.font('Helvetica').fontSize(9).fillColor(MUTE).text([clean(B.address), B.state ? 'State: ' + clean(B.state) : '', B.gstin ? 'GSTIN: ' + B.gstin : ''].filter(Boolean).join('\n'), L, doc.y + 1, { width: W * 0.6 });
    y = doc.y + 14;

    // lines
    const col = { d: L, q: L + W * 0.58, r: L + W * 0.72, a: L + W * 0.86 };
    doc.rect(L, y, W, 20).fill('#f1f3fa');
    doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(8.5);
    doc.text('DESCRIPTION', col.d + 6, y + 6); doc.text('QTY', col.q, y + 6, { width: W * 0.1, align: 'right' });
    doc.text('RATE', col.r, y + 6, { width: W * 0.12, align: 'right' }); doc.text('AMOUNT', col.a, y + 6, { width: W * 0.14 - 6, align: 'right' });
    y += 24;
    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
    for (const l of inv.lines || []) {
      if (y > 700) { doc.addPage(); y = 60; }
      const h = doc.heightOfString(clean(l.desc), { width: W * 0.54 });
      doc.fillColor(l.amount === 0 && l.kind !== 'subscription' ? MUTE : INK);
      doc.text(clean(l.desc), col.d + 6, y, { width: W * 0.54 });
      doc.text(String(l.qty), col.q, y, { width: W * 0.1, align: 'right' });
      doc.text(l.amount === 0 && l.rate === 0 ? '-' : money(l.rate), col.r, y, { width: W * 0.12, align: 'right' });
      doc.text(money(l.amount), col.a, y, { width: W * 0.14 - 6, align: 'right' });
      y += Math.max(h, 12) + 6;
      doc.moveTo(L, y - 3).lineTo(R, y - 3).strokeColor(LINE).lineWidth(0.5).stroke();
    }
    // totals
    y += 8;
    const row = (label, val, bold) => {
      if (y > 740) { doc.addPage(); y = 60; }
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5).fillColor(INK);
      doc.text(label, col.r - W * 0.2, y, { width: W * 0.32, align: 'right' }); doc.text(val, col.a, y, { width: W * 0.14 - 6, align: 'right' });
      y += bold ? 18 : 14;
    };
    row('Subtotal', money(inv.subtotal));
    if (inv.discount > 0) row(`Discount (${inv.discountPercent}%)`, '- ' + money(inv.discount));
    if (inv.discount > 0) row('Taxable value', money(inv.taxable));
    if (inv.gst && inv.gst.type === 'CGST_SGST') { row(`CGST (${inv.gst.percent / 2}%)`, money(inv.gst.cgst)); row(`SGST (${inv.gst.percent / 2}%)`, money(inv.gst.sgst)); }
    else if (inv.gst && inv.gst.type === 'IGST') row(`IGST (${inv.gst.percent}%)`, money(inv.gst.igst));
    doc.moveTo(col.r - W * 0.1, y).lineTo(R, y).strokeColor(INK).lineWidth(0.8).stroke(); y += 6;
    row('TOTAL', money(inv.total), true);
    if (v.paid > 0) { row('Received', '- ' + money(v.paid)); row('Balance due', money(v.outstanding), true); }

    // payments + how to pay
    y += 10;
    if (y > 690) { doc.addPage(); y = 60; }
    if (v.displayStatus === 'paid') doc.fillColor('#1a7f4b').font('Helvetica-Bold').fontSize(14).text('PAID', L, y);
    else if (!draft && S.bank && (S.bank.account || S.upi)) {
      doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(8).text('HOW TO PAY', L, y);
      doc.fillColor(INK).font('Helvetica').fontSize(9.5).text([S.bank.account ? `Bank: ${clean(S.bank.name)}  A/c ${clean(S.bank.account)}  IFSC ${clean(S.bank.ifsc)}  ${clean(S.bank.branch)}` : '', S.upi ? `UPI: ${clean(S.upi)}` : '', `Please mention invoice no ${clean(inv.number)} in the payment reference.`].filter(Boolean).join('\n'), L, y + 12, { width: W });
    }
    if ((inv.payments || []).length) {
      y = doc.y + 10; doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(8).text('PAYMENTS RECEIVED', L, y);
      doc.fillColor(INK).font('Helvetica').fontSize(9).text(inv.payments.map(p => `${day(p.date)}  ${money(p.amount)}  ${clean(p.mode)}${p.reference ? '  ref ' + clean(p.reference) : ''}`).join('\n'), L, y + 11, { width: W });
    }
    if (S.terms || inv.notes) { y = doc.y + 10; doc.fillColor(MUTE).font('Helvetica').fontSize(8.5).text(clean([inv.notes, S.terms].filter(Boolean).join('\n')), L, y, { width: W }); }
    doc.page.margins.bottom = 0;
    doc.fillColor(MUTE).fontSize(8).text('This is a computer-generated invoice.', L, 790, { width: W, align: 'center', lineBreak: false });
    doc.end();
  });
}
module.exports = { render };
