require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/services/speech-cache');

test('speech cache returns what was stored, counts hits, and drops the oldest when full', () => {
  assert.equal(c.get('a', 'Hindi', 'Hello'), undefined);
  c.set('a', 'Hindi', 'Hello', 'AUDIO1');
  assert.equal(c.get('a', 'Hindi', 'Hello'), 'AUDIO1');
  assert.equal(c.get('a', 'Tamil', 'Hello'), undefined);            // other language = other entry
  assert.ok(c.stats.hits >= 1 && c.stats.misses >= 2);
  const big = 'x'.repeat(5 * 1024 * 1024);
  for (let i = 0; i < 20; i++) c.set('a', 'L', 'line' + i, big);     // 100 MB offered, 60 MB limit
  assert.ok(c.size().mb <= 60);
  assert.equal(c.get('a', 'L', 'line0'), undefined);                  // oldest gone
  assert.equal(c.get('a', 'L', 'line19'), big);                       // newest kept
});
