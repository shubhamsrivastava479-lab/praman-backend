const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { PAGES } = require('../scripts/site-content');

test('website pages are built for search engines and served on clean URLs', async () => {
  const home = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
  assert.match(home, /<link rel="canonical" href="https:\/\/pramanservices\.space\/">/);
  assert.match(home, /"@type":"FAQPage"/);
  assert.match(home, /<h3>Insurance<\/h3>/);                       // industries are in the HTML, not drawn by script
  assert.ok(!/gridlines/i.test(home));
  const { app } = require('../src/server');
  const server = http.createServer(app); await new Promise(r => server.listen(0, r));
  test.after(() => server.close());
  const get = p => new Promise(r => http.get({ port: server.address().port, path: p }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => r({ s: res.statusCode, b })); }));
  for (const p of PAGES) {
    const r = await get('/industries/' + p.slug);
    assert.equal(r.s, 200, p.slug);
    assert.match(r.b, /<h1>/); assert.match(r.b, /rel="canonical"/); assert.ok(!/gridlines/i.test(r.b));
  }
  const sm = await get('/sitemap.xml');
  assert.equal(sm.s, 200); assert.equal((sm.b.match(/<loc>/g) || []).length, PAGES.length + 3);
  assert.match((await get('/robots.txt')).b, /Disallow: \/api\//);
  assert.equal((await get('/instant-checks')).s, 200);
});
