const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers');
const http = require('http');
const blog = require('../src/services/blog');
const cal = require('../content/blog-calendar.json');

test('every blog post parses, is on the calendar and never names the API provider', () => {
  const posts = blog.all();
  assert.ok(posts.length >= 12);
  const slugs = new Set(cal.map(c => c.slug));
  for (const p of posts) {
    assert.ok(slugs.has(p.slug), 'not on calendar: ' + p.slug);
    assert.ok(p.description && p.description.length <= 200, 'description: ' + p.slug);
    assert.ok(blog.CATEGORIES[p.category], 'category: ' + p.slug);
    assert.ok(p.faq.length >= 2, 'faq: ' + p.slug);
    assert.ok(p.words >= 300, 'too short: ' + p.slug);
    assert.ok(!/gridlines/i.test(p.body), 'provider name: ' + p.slug);
    assert.match(p.body, /Praman/);
  }
});

test('markdown renders tables, lists and links', () => {
  const h = blog.md('## A\n\n| x | y |\n|---|---|\n| 1 | **2** |\n\n- a\n- [b](/blog)');
  assert.match(h, /<h2>A<\/h2>/); assert.match(h, /<th>x<\/th>/); assert.match(h, /<td><strong>2<\/strong><\/td>/);
  assert.match(h, /<li><a href="\/blog">b<\/a><\/li>/);
});

test('future posts stay hidden; published ones are served and in the sitemap', async () => {
  const before = blog.published(new Date('2026-11-01T12:00:00Z'));
  assert.equal(before.length, 0);
  const day1 = blog.published(new Date('2026-11-02T00:30:00Z'));     // 6 am in India
  assert.ok(day1.length >= 12);
  const { app } = require('../src/server');
  const server = http.createServer(app); await new Promise(r => server.listen(0, r));
  test.after(() => server.close());
  const get = p => new Promise(r => http.get({ port: server.address().port, path: p }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => r({ s: res.statusCode, b })); }));
  const live = blog.published();
  if (live.length) {
    const r = await get('/blog/' + live[0].slug);
    assert.equal(r.s, 200); assert.match(r.b, /BlogPosting/); assert.match(r.b, /FAQPage/);
    assert.match((await get('/sitemap.xml')).b, new RegExp('/blog/' + live[0].slug));
  }
  const future = blog.all().find(p => p.date > blog.todayIST());
  if (future) assert.equal((await get('/blog/' + future.slug)).s, 404);
  assert.equal((await get('/blog')).s, 200);
  assert.equal((await get('/blog/rss.xml')).s, 200);
});
