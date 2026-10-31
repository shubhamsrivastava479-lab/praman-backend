// The checklist of a case: every question to ask and every document / photo to collect for
// THIS case type (the AI call's queue is built from the case type), each marked by the AI as
//   done        asked and answered / received and fine
//   partial     answered or received, but something needs a person's look (a concern, one side only, AI could not check)
//   not_done    asked but no clear answer / not received / failed after retries / customer declined
//   in_progress the AI is on this item right now
//   pending     not reached yet (or the call ended before it)
// A person can mark an item as done by themselves (c.checklistOverrides); it then shows as done with their name.
// It is worked out from the call's own records every time it is read, so it can never drift
// from what really happened.

const GROUPS = { ...require('./service-profiles').SECTION_LABELS, lossDetails: 'Loss details' };
const G_PHOTO = 'Photos and liveness check', G_DOC = 'Documents';
const short = (t, n = 150) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function buildChecklist(c) {
  const a = c && c.aiCall;
  if (!a || !Array.isArray(a.queue) || !a.queue.length) return [];
  const docs = a.docs || {}, photos = a.photos || {}, checks = a.checks || [];
  const ended = a.status === 'completed' || a.status === 'handoff';
  const chk = id => checks.find(k => k.id === id);
  const out = [];
  a.queue.forEach((s, idx) => {
    if (s.type === 'close' || s.isFollowUp) return;
    const reached = idx < a.i || a.status === 'completed';
    const here = idx === a.i && a.status === 'in_progress';
    const item = { id: s.id, kind: 'question', group: GROUPS[s.section] || 'Other', label: '', status: 'pending', detail: '' };
    const ans = (a.answers || []).filter(x => x.key === s.key).slice(-1)[0];
    const fallback = () => { item.status = here ? 'in_progress' : reached ? 'not_done' : 'pending'; };

    if (s.type === 'ask') {
      item.label = s.kind === 'name' ? 'Customer states their full name' : short(s.text, 120);
      const said = ans && !['no_answer', 'unclear'].includes(ans.intent) && (ans.value || ans.english);
      // The AI may have asked one follow-up question; a clear follow-up answer settles the item.
      const fu = (a.answers || []).filter(x => x.key === s.key + '_fu').slice(-1)[0];
      const fuSaid = fu && !['no_answer', 'unclear'].includes(fu.intent) && (fu.value || fu.english);
      if (said && fuSaid) {
        const first = short(ans.value || ans.english, 70), then = short(fu.value || fu.english, 90);
        item.status = fu.concern ? 'partial' : 'done';
        item.detail = fu.concern ? `Needs a look: ${short(fu.concern, 110)} (said: ${then})` : `${first} → clarified: ${then}`;
      } else if (said) {
        item.status = ans.concern ? 'partial' : 'done';
        item.detail = ans.concern ? 'Needs a look: ' + short(ans.concern, 120) : short(ans.value || ans.english);
      } else { fallback(); if (item.status === 'not_done') item.detail = 'Asked, but no clear answer'; }
    } else if (s.type === 'confirm') {
      item.label = `Confirm ${s.label}: ${short(s.value, 60)}`;
      if (ans && ans.intent === 'confirmed') { item.status = 'done'; item.detail = 'Customer confirmed it is correct'; }
      else if (ans && ans.intent === 'denied') { item.status = 'partial'; item.detail = 'Customer says it is different — see red flags'; }
      else { fallback(); if (item.status === 'not_done') item.detail = 'No clear yes / no'; }
    } else if (s.type === 'consent') {
      item.label = 'Customer agrees to the WhatsApp history check';
      if (a.chatConsent === 'given') { item.status = 'done'; item.detail = 'Customer agreed'; }
      else if (a.chatConsent === 'declined') { item.status = 'not_done'; item.detail = 'Customer declined'; }
      else { fallback(); if (item.status === 'not_done') item.detail = 'No clear answer'; }
    } else if (s.type === 'photo' || s.type === 'burst') {
      item.kind = 'photo'; item.group = G_PHOTO;
      const key = s.shot;
      item.label = key === 'face' ? 'Live face photo' : key === 'blink' ? 'Eye-blink liveness check' : key === 'stand' ? 'Full body photo — standing' : 'Full body photo — sitting';
      const chkId = key === 'face' ? 'face_photo' : key === 'blink' ? 'blink' : 'body_' + key;
      const k = chk(chkId);
      if (photos[key] === true) { item.status = k && k.result === 'partial' ? 'partial' : 'done'; item.detail = k && k.detail ? short(k.detail) : 'Captured and checked by AI'; }
      else if (photos[key] === null || (k && k.result === 'unknown')) { item.status = 'partial'; item.detail = 'Photo saved, but the AI could not check it — please look at it'; }
      else if (photos[key] === false) { item.status = k && k.result === 'partial' ? 'partial' : 'not_done'; item.detail = k && k.detail ? short(k.detail) : 'Not clear after retries'; }
      else fallback();
    } else if (s.type === 'docs') {
      item.kind = 'document'; item.group = s.doc === 'chats' ? GROUPS.chatHistory : G_DOC;
      if (s.doc === 'aadhaar') {
        item.label = 'Aadhaar card — front and back';
        const d = docs.aadhaar || {};
        if (d.front && d.back) { item.status = 'done'; item.detail = 'Both sides received' + (d.masked ? ' (' + d.masked + ')' : ''); }
        else if (d.front || d.back || d.received) { item.status = 'partial'; item.detail = d.front ? 'Only the front was received' : d.back ? 'Only the back was received' : 'Received but could not be read fully'; }
        else fallback();
      } else if (s.doc === 'pan') {
        item.label = 'PAN card';
        const d = docs.pan || {};
        if (d.received) { item.status = d.masked ? 'done' : 'partial'; item.detail = d.masked ? 'Received (' + d.masked + ')' : 'Received but the number could not be read'; }
        else fallback();
      } else {
        item.label = 'WhatsApp search screenshots';
        const n = (docs.chats || {}).count || 0;
        if (a.chatConsent === 'declined') { item.status = 'not_done'; item.detail = 'Customer declined'; }
        else if (n) { item.status = 'done'; item.detail = n + ' screenshot(s) received'; }
        else fallback();
        if (item.status === 'not_done' && !item.detail) item.detail = 'No screenshots were sent';
      }
      if (item.status === 'not_done' && !item.detail) item.detail = 'Not received';
    } else if (s.type === 'otp') {
      item.kind = 'document'; item.group = G_DOC; item.label = 'Aadhaar OTP read-out';
      const k = chk('aadhaar_api');
      if (k && ['pass', 'match'].includes(k.result)) { item.status = 'done'; item.detail = 'Verified with the official record'; }
      else if (k && ['fail', 'mismatch'].includes(k.result)) { item.status = 'not_done'; item.detail = short(k.detail || 'OTP verification failed'); }
      else fallback();
    } else return;
    if (a.status === 'handoff' && item.status === 'not_done' && !item.detail) item.detail = 'Call was handed over to a person';
    const ov = c.checklistOverrides && c.checklistOverrides[s.id];
    if (ov && item.status !== 'done') {   // a person did this item themselves (for example on a live call)
      item.aiStatus = item.status; item.status = 'done'; item.byHuman = true;
      item.detail = `Done by ${ov.by}${ov.note ? ': ' + short(ov.note, 120) : ''}`;
    }
    item.mandatory = (a.mandatory || []).includes(s.id);
    out.push(item);
  });
  // Keep each group together (questions of one group can be asked before and after the photos).
  const order = [];
  for (const x of out) if (!order.includes(x.group)) order.push(x.group);
  return out.map((x, i) => [x, i]).sort((p, q) => order.indexOf(p[0].group) - order.indexOf(q[0].group) || p[1] - q[1]).map(p => p[0]);
}

function summarize(items) {
  const n = k => items.filter(x => x.status === k).length;
  return { total: items.length, done: n('done'), partial: n('partial'), notDone: n('not_done'), pending: n('pending') + n('in_progress') };
}

module.exports = { buildChecklist, summarize };
