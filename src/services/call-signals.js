// Extra checks that need no AI: do the customer's answers agree with the records, do the same
// identity details / device show up on other cases, and was the audio good enough to trust.
// Everything here only RAISES questions (flags / "needs a look"); a person decides.
const crypto = require('crypto');
function normDob(s) {
  const t = String(s || '').trim();
  const m = t.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return { d: m[1].padStart(2, '0'), m: m[2].padStart(2, '0'), y: m[3] };
  const y = t.match(/\b(19|20)\d{2}\b/);
  return y ? { y: y[0] } : null;
}

const STOP = new Set(['the', 'a', 'an', 'near', 'opp', 'opposite', 'behind', 'next', 'to', 'road', 'rd', 'street', 'st', 'lane', 'nagar', 'colony', 'house', 'no', 'flat', 'floor', 'main', 'sector', 'and', 'of', 'in', 'at', 'po', 'ps', 'dist', 'district', 'tehsil', 'village', 'vill', 'post', 'india', 'c/o', 's/o', 'd/o', 'w/o']);
const words = t => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));

// How much of what the customer said as their address appears in the address printed on the Aadhaar.
function addressOverlap(spoken, printed) {
  const A = [...new Set(words(spoken))], B = new Set(words(printed));
  if (A.length < 3 || B.size < 3) return null;
  const hit = A.filter(w => B.has(w) || [...B].some(b => b.length > 4 && w.length > 4 && (b.startsWith(w) || w.startsWith(b)))).length;
  return hit / A.length;
}

// "5 lakh", "5,00,000", "10 lakhs", "1.2 crore", "50k", "500000" -> rupees. Returns null if no number found.
function parseAmount(text) {
  const t = String(text || '').toLowerCase().replace(/,/g, '').replace(/₹|rs\.?|rupees?|inr/g, ' ');
  const m = t.match(/(\d+(?:\.\d+)?)\s*(crore|cr|lakhs?|lacs?|lac|l\b|thousand|k\b|hazar)?/);
  if (!m) return null;
  let n = parseFloat(m[1]); const u = m[2] || '';
  if (/^cr/.test(u)) n *= 1e7; else if (/^(lakh|lac|l$)/.test(u)) n *= 1e5; else if (/^(thousand|k|hazar)/.test(u)) n *= 1e3;
  return isFinite(n) && n > 0 ? Math.round(n) : null;
}
const inr = n => '₹' + Number(n).toLocaleString('en-IN');

const YES = /\b(yes|yeah|yep|correct|right|sure|haan|han|ji haan|bilkul|sahi)\b/i, NO = /\b(no|nope|not|never|nahi|nahin|galat|wrong)\b/i;
const sayYes = a => !!a && YES.test(String(a.english || a.value || '').slice(0, 60)) && !NO.test(String(a.english || a.value || '').slice(0, 60));
const sayNo = a => !!a && NO.test(String(a.english || a.value || '').slice(0, 60));

// Checks from the call's own answers and documents. `set(id, label, result, detail)` records a check.
function answerChecks(c, set, flag) {
  const a = c.aiCall, ans = k => (a.answers || []).find(x => x.key === k);
  const spokenAddr = ans('address') && (ans('address').value || ans('address').english);
  const printed = a.docs && a.docs.aadhaar && a.docs.aadhaar.address;
  if (spokenAddr && printed) {
    const o = addressOverlap(spokenAddr, printed);
    if (o != null) set('address_spoken_aadhaar', 'Address stated vs Aadhaar address', o >= 0.5 ? 'match' : 'partial', o >= 0.5 ? '' : 'Little of the stated address appears on the Aadhaar (the customer may have moved)');
  }
  // The age said at the end must fit the date of birth said earlier (or printed on the Aadhaar).
  const ageSaid = ans('age') && String((ans('age').value || ans('age').english) || '').match(/\b(\d{1,3})\b/);
  const dobSrc = (a.docs && a.docs.aadhaar && a.docs.aadhaar.dob) || (ans('dob') && (ans('dob').value || ans('dob').english));
  const nd = dobSrc && normDob(dobSrc);
  if (ageSaid && nd && nd.y) {
    const yrs = new Date().getFullYear() - Number(nd.y), said = Number(ageSaid[1]);
    if (said >= 5 && said <= 110 && Math.abs(yrs - said) > 1) set('age_vs_dob', 'Age stated vs date of birth', 'partial', `Customer said ${said} years, the date of birth gives about ${yrs}`);
  }
  const income = ans('income') && parseAmount(ans('income').value || ans('income').english);
  const cover = parseAmount(c.policyValue);
  if (income && cover && c.caseType === 'policy_verification') {
    const x = cover / income;
    if (x > 25) set('income_vs_cover', 'Stated income vs sum assured', 'partial', `Sum assured ${inr(cover)} is about ${Math.round(x)} times the stated yearly income of ${inr(income)}`);
  }
  const said = ans('sum_assured') && parseAmount(ans('sum_assured').value || ans('sum_assured').english);
  if (said && cover && Math.abs(said - cover) / cover > 0.2) set('cover_spoken_record', 'Cover amount stated vs record', 'partial', `Customer said ${inr(said)}, the record shows ${inr(cover)}`);
  // risky answers: mis-selling signs
  if (sayNo(ans('applied_self'))) flag('Customer says they did not apply for the policy themselves');
  if (sayNo(ans('signed_self'))) flag('Customer says they did not sign the proposal form themselves');
  if (sayYes(ans('promises'))) flag('Customer says guaranteed returns or a cash payment was promised');
  if (sayNo(ans('disclosed'))) flag('Customer says the health details written in the proposal were not correct');
  if (sayYes(ans('rejected_before'))) flag('Customer says an earlier insurance application was rejected or postponed');
}

// A short fingerprint of the device + network, so the same phone on many cases stands out.
const deviceSig = (deviceInfo, ip) => {
  if (!deviceInfo && !ip) return null;
  const s = [deviceInfo && deviceInfo.platform, deviceInfo && deviceInfo.screen, deviceInfo && deviceInfo.timezone, ip].join('|');
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
};
// Only last digits + date of birth are kept (full ID numbers are never stored).
function idKeys(a) {
  const d = (a && a.docs) || {}, dob = x => { const n = normDob(x); return n ? `${n.d || ''}/${n.m || ''}/${n.y}` : ''; };
  return {
    aadhaar: d.aadhaar && d.aadhaar.last4 && d.aadhaar.dob ? `${d.aadhaar.last4}|${dob(d.aadhaar.dob)}` : null,
    pan: d.pan && d.pan.masked && d.pan.dob ? `${d.pan.masked}|${dob(d.pan.dob)}` : null
  };
}
// Same details on another case of the SAME firm (never across firms).
function crossCase(c, others) {
  const a = c.aiCall, mine = idKeys(a), out = [];
  for (const o of others) {
    if (!o.aiCall || o.id === c.id || o.vendorId !== c.vendorId) continue;
    const theirs = o.aiCall.idKeysSaved || idKeys(o.aiCall);
    const ref = o.caseRef || o.claimNo;
    if (mine.aadhaar && theirs.aadhaar === mine.aadhaar) out.push({ type: 'aadhaar', ref, text: `The same Aadhaar details (last 4 digits and date of birth) appear on another case: ${ref}` });
    else if (mine.pan && theirs.pan === mine.pan) out.push({ type: 'pan', ref, text: `The same PAN details (last digits and date of birth) appear on another case: ${ref}` });
    if (a.deviceSig && o.aiCall.deviceSig === a.deviceSig && o.whatsappNumber !== c.whatsappNumber) out.push({ type: 'device', ref, text: `The same phone and network were used on a case with a different customer number: ${ref}` });
    if (c.whatsappNumber && o.whatsappNumber === c.whatsappNumber && o.id !== c.id && o.aiCall.status === 'completed' && String(o.insuredName || '').toLowerCase() !== String(c.insuredName || '').toLowerCase()) out.push({ type: 'phone', ref, text: `This WhatsApp number is also used on case ${ref} for a different person` });
  }
  const seen = new Set();
  return out.filter(x => !seen.has(x.text) && seen.add(x.text)).slice(0, 5);
}

// Was the audio good enough to trust the answers?
function audioQuality(a) {
  const noisy = a.noisy || 0, stt = a.sttErrors || 0, silent = (a.answers || []).filter(x => x.intent === 'no_answer').length;
  const reasons = [];
  if (noisy >= 4) reasons.push(`Background noise or very faint audio was detected ${noisy} times`);
  if (stt >= 3) reasons.push(`The AI could not process the customer's voice ${stt} times`);
  if (silent >= 3) reasons.push(`${silent} questions got no clear answer`);
  return { poor: reasons.length > 0, reasons };
}

module.exports = { addressOverlap, parseAmount, answerChecks, deviceSig, idKeys, crossCase, audioQuality };
