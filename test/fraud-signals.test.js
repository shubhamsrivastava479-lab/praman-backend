require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/services/ai-call-engine');
const signals = require('../src/services/call-signals');

const mk = () => {
  const c = { id: 'cf1', vendorId: 'v1', caseType: 'policy_verification', policyType: 'life', insuredName: 'Ravi Kumar', claimNo: 'P1', aiCall: {} };
  engine.startSession(c, { language: 'English' });
  return c;
};
const goTo = (c, id) => { const a = c.aiCall; a.i = a.queue.findIndex(s => s.id === id); return a.queue[a.i]; };

test('the call has a random live action and a random spoken code', () => {
  const c = mk(), q = c.aiCall.queue;
  const ch = q.find(s => s.id === 'challenge'), lc = q.find(s => s.id === 'live_code');
  assert.ok(ch && ch.type === 'burst' && ['turn_left', 'turn_right', 'look_up', 'nod'].includes(ch.challenge));
  assert.match(lc.code, /^[1-9]{4}$/);
  assert.ok(lc.text.includes(lc.code.split('').join(', ')));
  assert.ok(q.findIndex(s => s.id === 'blink') < q.findIndex(s => s.id === 'challenge'));
  assert.ok(q.some(s => s.id === 'q_age'));
});

test('live action: passes, retries once, then a plain miss is only partial', () => {
  const c = mk(); goTo(c, 'challenge');
  engine.apply(c, {}, { challenge: { faceVisible: true, sameFaceAllFrames: true, actionPerformed: true, possibleSpoof: '' } });
  assert.equal(c.aiCall.checks.find(x => x.id === 'challenge').result, 'pass');

  const d = mk(); goTo(d, 'challenge');
  const miss = { challenge: { faceVisible: true, sameFaceAllFrames: true, actionPerformed: false, possibleSpoof: '' } };
  engine.apply(d, {}, miss);                         // first miss: asks again
  assert.equal(d.aiCall.queue[d.aiCall.i].id, 'challenge');
  engine.apply(d, {}, miss);                         // second miss: moves on
  assert.equal(d.aiCall.checks.find(x => x.id === 'challenge').result, 'partial');

  const e = mk(); goTo(e, 'challenge');
  const spoof = { challenge: { faceVisible: true, actionPerformed: false, possibleSpoof: 'screen glare' } };
  engine.apply(e, {}, spoof); engine.apply(e, {}, spoof);
  assert.equal(e.aiCall.checks.find(x => x.id === 'challenge').result, 'fail');
  assert.ok(e.aiCall.flags.some(f => /recording or edited/.test(f)));
});

test('spoken code is compared with the code the AI gave', () => {
  const c = mk(), step = c.aiCall.queue.find(s => s.id === 'live_code');
  c.aiCall.answers.push({ key: 'live_code', value: step.code.split('').join(' ') });
  engine.applyFinish(c, { summary: 'x', sections: {}, concerns: [] });
  assert.equal(c.aiCall.checks.find(x => x.id === 'live_code').result, 'pass');
  const d = mk();
  d.aiCall.answers.push({ key: 'live_code', value: '0000' });
  engine.applyFinish(d, { summary: 'x', sections: {}, concerns: [] });
  assert.equal(d.aiCall.checks.find(x => x.id === 'live_code').result, 'partial');
});

test('age said must fit the date of birth', () => {
  const y = new Date().getFullYear();
  const out = [];
  const c = { aiCall: { answers: [{ key: 'dob', value: `12/03/${y - 40}` }, { key: 'age', value: '25' }], docs: { aadhaar: {}, pan: {} } } };
  signals.answerChecks(c, (id, l, r) => out.push([id, r]), () => {});
  assert.deepEqual(out.find(x => x[0] === 'age_vs_dob'), ['age_vs_dob', 'partial']);
  const ok = [];
  c.aiCall.answers[1].value = '40';
  signals.answerChecks(c, (id, l, r) => ok.push(id), () => {});
  assert.ok(!ok.includes('age_vs_dob'));
});

test('contradictions, background voices and edited ID cards become flags', () => {
  const c = mk(), a = c.aiCall;
  a.otherVoice = 3;
  engine.applyIdMedia(c, { readable: true, documentType: 'pan', name: 'R', idNumber: 'ABCDE1234F', tamperSigns: 'Name font differs from the rest' }, null, {});
  engine.applyFinish(c, { summary: 'x', sections: {}, concerns: [], consistency: [{ issue: 'Said not ill, but later takes diabetes medicine', severity: 'high' }] });
  assert.ok(a.flags.some(f => /Possible contradiction/.test(f)));
  assert.ok(a.flags.some(f => /Another person's voice/.test(f)));
  assert.equal(a.checks.find(x => x.id === 'id_tamper_pan').result, 'partial');
  assert.equal(a.checks.find(x => x.id === 'consistency').result, 'partial');
});
