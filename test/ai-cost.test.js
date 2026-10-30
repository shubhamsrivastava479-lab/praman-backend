require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../src/db');
const usage = require('../src/services/usage');

test('AI cost: exact tokens per task, model, firm and case; cost from current prices', async () => {
  db.data.cases.push({ id: 'cost1', vendorId: 'fx', caseRef: 'PR-C1', createdAt: new Date().toISOString() });
  db.data.users.push({ id: 'fx', vendorName: 'Cost Firm', role: 'vendor_admin' });
  const reply = (inT, audio, out, think = 0) => ({ usageMetadata: { promptTokenCount: inT, candidatesTokenCount: out, thoughtsTokenCount: think, promptTokensDetails: audio ? [{ modality: 'AUDIO', tokenCount: audio }, { modality: 'TEXT', tokenCount: inT - audio }] : [] } });
  await usage.run({ caseId: 'cost1', firmId: 'fx' }, async () => {
    await usage.run({ task: 'Speech to text (customer voice)' }, async () => usage.record({ label: 'x', model: 'gemini-3.6-flash', ok: true, reply: reply(1000000, 800000, 100000, 100000) }));
    await usage.run({ task: 'Translation' }, async () => usage.record({ label: 'x', model: 'some-lite-model', ok: true, reply: reply(5000, 0, 500) }));
  });
  let s = usage.summary(1);
  const stt = s.tasks.find(t => t.name === 'Speech to text (customer voice)');
  assert.equal(stt.audioTok, 800000); assert.equal(stt.outTok, 200000);          // thinking counted as output
  assert.ok(Math.abs(stt.usd - (1000000 * 0.75 + 200000 * 3.75) / 1e6) < 1e-9);  // audio uses the input price when no audio price is set
  assert.equal(s.tasks.find(t => t.name === 'Translation').unpriced, 1);        // no price for that model: tokens only
  assert.equal(s.firms[0].name, 'Cost Firm');
  assert.equal(s.topCases[0].caseRef, 'PR-C1');
  usage.setPrices({ 'some-lite-model': { in: 0.1, out: 0.4 }, 'gemini-3.6-flash': { in: 0.75, audioIn: 1.5, out: 3.75 } });
  s = usage.summary(1);
  assert.equal(s.tasks.find(t => t.name === 'Translation').unpriced, 0);        // a price set later applies to past use
  assert.ok(Math.abs(s.tasks[0].usd - (200000 * 0.75 + 800000 * 1.5 + 200000 * 3.75) / 1e6) < 1e-9);
});
