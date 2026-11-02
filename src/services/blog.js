// Blog: posts are Markdown files in content/blog/<slug>.md with a small header:
//   ---
//   title: Tenant verification in India: the complete guide
//   description: One or two sentences for Google.
//   date: 2026-11-02            (the post goes live on this day, India time; until then it is hidden)
//   category: tenant
//   keywords: tenant verification, landlord
//   related: tenant-verification          (an /industries/<slug> page to link)
//   faq: Question? | Answer.              (any number of lines)
//   ---
// Pages: /blog, /blog/category/<cat>, /blog/<slug>, /blog/rss.xml. The site map lists the published posts.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'content', 'blog');
const SITE = 'https://pramanservices.space';
const CATEGORIES = {
  tenant: 'Tenant and rental', domestic: 'Domestic help', employee: 'Employee verification', gig: 'Gig workers',
  vehicle: 'Drivers and vehicles', matrimonial: 'Matrimonial', deals: 'Online deals', claims: 'Insurance claims',
  pivc: 'Policy verification (PIVC)', lending: 'Loans and lending', business: 'Business and vendors',
  healthcare: 'Hospitals and TPAs', kyc: 'Digital KYC and checks', guides: 'Guides and compliance'
};

let cache = null;
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const todayIST = (now = new Date()) => new Date(now.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

function parse(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const meta = { faq: [] };
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':'); if (i < 0) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    if (k === 'faq') { const [q, a] = v.split('|').map(x => x.trim()); if (q && a) meta.faq.push([q, a]); }
    else meta[k] = v;
  }
  const slug = path.basename(file, '.md');
  if (!/^[a-z0-9-]+$/.test(slug) || !meta.title || !/^\d{4}-\d{2}-\d{2}$/.test(meta.date || '')) return null;
  const body = m[2].trim();
  return { slug, ...meta, keywords: (meta.keywords || '').split(',').map(x => x.trim()).filter(Boolean), body, words: body.split(/\s+/).length };
}

function all() {
  if (cache && process.env.NODE_ENV === 'production') return cache;
  let files = [];
  try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.md')); } catch { files = []; }
  cache = files.map(f => { try { return parse(path.join(DIR, f)); } catch { return null; } }).filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  return cache;
}
const published = (now) => all().filter(p => p.date <= todayIST(now));

// Small Markdown: ## / ### headings, paragraphs, - lists, 1. lists, **bold**, *italic*, [text](url), > quote.
function inline(t) {
  return esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)/g, (_, txt, url) => `<a href="${url}"${/^https?:/.test(url) && !url.startsWith(SITE) ? ' target="_blank" rel="noopener"' : ''}>${txt}</a>`);
}
function md(src) {
  const out = []; let list = null, para = [], table = null;
  const endTable = () => {
    if (!table) return;
    const [head, ...rows] = table.filter(r => !r.every(c => /^:?-{2,}:?$/.test(c) || c === ''));
    out.push('<div class="tbl"><table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
    table = null;
  };
  const flush = () => { endTable(); if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (!t) { flush(); continue; }
    if (/^\|.*\|$/.test(t)) {
      if (!table) flush();
      (table = table || []).push(t.slice(1, -1).split('|').map(c => c.trim()));
      continue;
    }
    endTable();
    let m;
    if ((m = /^(#{2,3})\s+(.*)$/.exec(t))) { flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if ((m = /^>\s?(.*)$/.exec(t))) { flush(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = /^[-*]\s+(.*)$/.exec(t)) || (m = /^\d+\.\s+(.*)$/.exec(t))) {
      const kind = /^\d/.test(t) ? 'ol' : 'ul';
      if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
      if (list !== kind) { if (list) out.push(`</${list}>`); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    para.push(t);
  }
  flush();
  return out.join('\n');
}

const BLOG_CSS = `<style>
.post{max-width:760px;margin:0 auto;padding:36px 20px 10px}
.post h1{font-family:Georgia,serif;font-size:38px;line-height:1.2;color:var(--navy);margin:8px 0 12px}
.post .meta{color:var(--mut);font-size:14px;margin-bottom:22px}
.post h2{font-family:Georgia,serif;font-size:26px;color:var(--navy);margin:34px 0 10px}
.post h3{font-size:19px;color:var(--navy);margin:24px 0 6px}
.post p,.post li{font-size:17px;line-height:1.75;color:#26323d}
.post ul,.post ol{padding-left:22px}.post li{margin:4px 0}
.tbl{overflow-x:auto;margin:18px 0}.post table{border-collapse:collapse;width:100%;font-size:15px}.post th,.post td{border:1px solid var(--line);padding:9px 10px;text-align:left;vertical-align:top}.post th{background:#eef3f8;color:var(--navy)}
.post blockquote{margin:18px 0;padding:12px 18px;border-left:4px solid var(--amber);background:#fbf3e8;font-size:16px}
.tag{display:inline-block;background:#eef3f8;color:#2b4a66;border-radius:14px;padding:3px 10px;font-size:13px;text-decoration:none}
.cta{background:var(--navy);color:#fff;border-radius:16px;padding:24px;margin:34px 0}.cta h3{color:#fff;margin:0 0 6px;font-family:Georgia,serif;font-size:22px}.cta p{color:#c9d6e2;margin:0 0 14px;font-size:15px}
.cta .btn{margin:4px 8px 0 0}.cta .ghost{background:transparent;border:1px solid rgba(255,255,255,.5);color:#fff}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.pc{display:block;background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px;text-decoration:none;color:inherit}
.pc b{display:block;color:var(--navy);font-size:17px;line-height:1.35;margin:8px 0 6px}.pc span{color:var(--mut);font-size:14px}
.cats{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 22px}.cats a{background:#fff;border:1px solid var(--line);border-radius:16px;padding:6px 12px;font-size:14px;text-decoration:none;color:var(--navy)}.cats a.on{background:var(--navy);color:#fff}
.faq details{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px}.faq summary{cursor:pointer;font-weight:600;color:var(--navy)}
@media(max-width:860px){.cards{grid-template-columns:1fr}.post h1{font-size:30px}}
</style>`;

function parts() { return require('../../scripts/build-site-pages'); }
const fmt = d => new Date(d + 'T00:00:00+05:30').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
const card = p => `<a class="pc" href="/blog/${p.slug}"><span class="tag">${esc(CATEGORIES[p.category] || 'Guide')}</span><b>${esc(p.title)}</b><span>${esc(p.description || '')}</span></a>`;
const ctaBox = p => {
  const consumer = ['tenant', 'domestic', 'vehicle', 'matrimonial', 'deals'].includes(p.category);
  return `<div class="cta"><h3>${consumer ? 'Check before you trust, with SatyaSakshi Praman' : 'Make verification simple with Praman'}</h3>
<p>${consumer ? 'A WhatsApp link, a short video call with consent, and a report reviewed by SatyaSakshi investigators.' : 'WhatsApp link, AI or live video call, instant ID, vehicle, business and court checks, and one evidence report. Built by investigators at SatyaSakshi.'}</p>
<a class="btn" href="/#demo">Request a demo</a><a class="btn ghost" href="https://wa.me/917065567277?text=${encodeURIComponent('Hi, I read "' + p.title + '" and want to know more about Praman')}">WhatsApp +91 70655 67277</a></div>`;
};

function page({ title, desc, url, extra = '', body }) {
  const P = parts();
  return `<!DOCTYPE html>\n<html lang="en-IN">\n<head>\n${P.head({ title, desc, url, extra })}\n<link rel="alternate" type="application/rss+xml" title="Praman blog" href="${SITE}/blog/rss.xml">\n${P.CSS}\n${BLOG_CSS}\n</head>\n<body>\n${P.HEADER}\n<main>${body}</main>\n${P.FOOTER}\n<script src="/chat-widget.js" defer></script>\n</body>\n</html>\n`;
}

function postPage(p, now) {
  const P = parts(), url = `${SITE}/blog/${p.slug}`;
  const related = published(now).filter(x => x.slug !== p.slug && x.category === p.category).slice(0, 3);
  const more = related.length < 3 ? published(now).filter(x => x.slug !== p.slug && x.category !== p.category).slice(0, 3 - related.length) : [];
  const article = { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: p.title, description: p.description || '', datePublished: p.date, dateModified: p.updated || p.date,
    author: { '@type': 'Organization', name: 'SatyaSakshi LLP' }, publisher: P.ORG, mainEntityOfPage: url, keywords: p.keywords.join(', '), inLanguage: 'en-IN' };
  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' }, { '@type': 'ListItem', position: 2, name: 'Blog', item: SITE + '/blog' },
    { '@type': 'ListItem', position: 3, name: p.title, item: url }] };
  const faqLd = p.faq.length ? P.ld({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: p.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }) : '';
  const body = `<article class="post">
<div style="font-size:14px"><a href="/blog">Blog</a> › <a href="/blog/category/${esc(p.category)}">${esc(CATEGORIES[p.category] || 'Guides')}</a></div>
<h1>${esc(p.title)}</h1>
<div class="meta">By SatyaSakshi LLP · ${fmt(p.date)} · ${Math.max(2, Math.round(p.words / 200))} min read</div>
${md(p.body)}
${p.faq.length ? `<h2>Frequently asked questions</h2><div class="faq">${p.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${inline(a)}</p></details>`).join('')}</div>` : ''}
${p.related ? `<p>Related: <a href="/industries/${esc(p.related)}">how Praman handles this for businesses</a> · <a href="/instant-checks">all instant checks</a></p>` : ''}
${ctaBox(p)}
${related.concat(more).length ? `<h2>Read next</h2><div class="cards">${related.concat(more).map(card).join('')}</div>` : ''}
</article>`;
  return page({ title: `${p.title} | Praman Blog`, desc: p.description || p.title, url, extra: [P.ld(article), P.ld(crumbs), faqLd].join('\n'), body });
}

function listPage(cat, now) {
  const P = parts();
  const posts = published(now).filter(p => !cat || p.category === cat);
  const used = new Set(published(now).map(p => p.category));
  const name = cat ? CATEGORIES[cat] : null;
  const url = cat ? `${SITE}/blog/category/${cat}` : `${SITE}/blog`;
  const body = `<div class="hero"><div class="wrap"><div class="crumb"><a href="/">Home</a> › ${cat ? '<a href="/blog">Blog</a> › ' + esc(name) : 'Blog'}</div>
<h1>${cat ? esc(name) + ': verification guides' : 'Verification guides and insights'}</h1>
<p class="lead">Practical guides on verifying people, businesses, vehicles and claims in India: why each check matters, how to do it, and how Praman by SatyaSakshi makes it simple.</p></div></div>
<section><div class="wrap">
<div class="cats"><a href="/blog" class="${cat ? '' : 'on'}">All</a>${Object.entries(CATEGORIES).filter(([k]) => used.has(k)).map(([k, v]) => `<a href="/blog/category/${k}" class="${k === cat ? 'on' : ''}">${esc(v)}</a>`).join('')}</div>
${posts.length ? `<div class="cards">${posts.map(card).join('')}</div>` : '<p>New guides are coming soon.</p>'}
</div></section>`;
  return page({ title: cat ? `${name} verification guides | Praman Blog` : 'Verification blog: guides for India | Praman by SatyaSakshi', desc: cat ? `Guides on ${name.toLowerCase()} verification in India from SatyaSakshi.` : 'Guides on tenant, domestic help, employee, driver, vehicle, matrimonial, insurance claim, loan and business verification in India.', url, extra: P.ld({ '@context': 'https://schema.org', '@type': 'Blog', name: 'Praman Blog', url, publisher: P.ORG }), body });
}

function rss(now) {
  const items = published(now).slice(0, 50).map(p => `<item><title>${esc(p.title)}</title><link>${SITE}/blog/${p.slug}</link><guid>${SITE}/blog/${p.slug}</guid><pubDate>${new Date(p.date + 'T09:00:00+05:30').toUTCString()}</pubDate><description>${esc(p.description || '')}</description></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Praman Blog</title><link>${SITE}/blog</link><description>Verification guides by SatyaSakshi</description>${items}</channel></rss>`;
}

// Site map: the fixed pages plus every published post and category.
function sitemap(now) {
  const { PAGES } = require('../../scripts/site-content');
  const d = todayIST(now);
  const urls = [[SITE + '/', '1.0', d], [SITE + '/instant-checks', '0.8', d], ...PAGES.map(p => [`${SITE}/industries/${p.slug}`, '0.8', d]), [SITE + '/blog', '0.8', d],
    ...[...new Set(published(now).map(p => p.category))].map(c => [`${SITE}/blog/category/${c}`, '0.5', d]),
    ...published(now).map(p => [`${SITE}/blog/${p.slug}`, '0.7', p.updated || p.date]), [SITE + '/privacy.html', '0.3', d]];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, pr, lm]) => `  <url><loc>${u}</loc><lastmod>${lm}</lastmod><priority>${pr}</priority></url>`).join('\n')}\n</urlset>\n`;
}

function router() {
  const express = require('express');
  const r = express.Router();
  const send = (res, html, type = 'text/html') => res.type(type).set('Cache-Control', 'public, max-age=300').send(html);
  r.get('/sitemap.xml', (req, res) => send(res, sitemap(), 'application/xml'));
  r.get('/blog', (req, res) => send(res, listPage(null)));
  r.get('/blog/rss.xml', (req, res) => send(res, rss(), 'application/rss+xml'));
  r.get('/blog/category/:cat', (req, res, next) => CATEGORIES[req.params.cat] ? send(res, listPage(req.params.cat)) : next());
  r.get('/blog/:slug', (req, res, next) => {
    const p = published().find(x => x.slug === req.params.slug);
    p ? send(res, postPage(p)) : next();
  });
  return r;
}

module.exports = { all, published, md, router, sitemap, CATEGORIES, todayIST, postPage, listPage };
