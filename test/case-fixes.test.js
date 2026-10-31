const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers');
const { parseAmount } = require('../src/services/call-signals');
const { tidy, langName } = require('../src/services/flag-tidy');
const { buildChecklist } = require('../src/services/checklist');

test('amounts in Indian answers', () => {
  assert.equal(parseAmount('1.5 million'), 1500000);
  assert.equal(parseAmount('Indane first 10,000 15 lakh'), 1500000);      // the number with a unit wins
  assert.equal(parseAmount('5,00,000'), 500000);
  assert.equal(parseAmount('1.2 crore'), 12000000);
  assert.equal(parseAmount('50 hazaar per month', { yearly: true }), 600000);
  assert.equal(parseAmount('2', { min: 1000 }), null);                     // not a believable yearly income
});

test('flags: one line per topic, no dollar notes', () => {
  const out = tidy([
    'Aadhaar card was not received during the call', 'Aadhaar card received: Not sent during the call',
    'Customer reported a promise of guaranteed returns/cashback', 'Customer says guaranteed returns or a cash payment was promised',
    'The response mentions 15 lakh, which is ambiguous in the context of US insurance currency.', 'PAN card was not received during the call']);
  assert.deepEqual(out, ['Aadhaar card was not received during the call', 'Customer reported a promise of guaranteed returns/cashback', 'PAN card was not received during the call']);
});

test('language names', () => {
  assert.equal(langName('hi'), 'Hindi');
  assert.equal(langName('Turkish', 'Hindi'), 'Hindi');
  assert.equal(langName('marathi'), 'Marathi');
});

test('checklist: a clear follow-up answer settles the item, groups stay together', () => {
  const c = { aiCall: { status: 'completed', i: 9, queue: [
    { id: 'q1', type: 'ask', key: 'name', kind: 'name', section: 'identity', text: 'Name?' },
    { id: 'p1', type: 'photo', shot: 'face', section: 'photos' },
    { id: 'q2', type: 'ask', key: 'dob', section: 'identity', text: 'Date of birth?' },
    { id: 'q3', type: 'ask', key: 'occupation', section: 'income', text: 'What is your occupation?' }],
    answers: [{ key: 'name', value: 'Ravi' }, { key: 'dob', value: '1990' },
      { key: 'occupation', english: 'private job', concern: 'too vague' }, { key: 'occupation_fu', english: 'business analyst' }],
    photos: { face: true }, checks: [], docs: {} } };
  const items = buildChecklist(c);
  const occ = items.find(x => x.id === 'q3');
  assert.equal(occ.status, 'done');
  assert.match(occ.detail, /clarified: business analyst/);
  const groups = items.map(x => x.group);
  assert.equal(groups.indexOf(groups[0], 1) === 1 || groups[1] === groups[0], true);   // identity items next to each other
});
