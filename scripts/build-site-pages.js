// Builds the public website pages for search engines from scripts/site-content.js:
//   public/industries/<slug>.html   one page per industry
//   public/instant-checks.html      every instant check
//   public/sitemap.xml, public/robots.txt
//   blocks between <!--SEO:x--> and <!--/SEO:x--> in public/login.html (the home page)
// Run:  node scripts/build-site-pages.js
const fs = require('fs');
const path = require('path');
const { SITE, CHECKS, STEPS, PAGES, HOME_FAQ, INDUSTRIES, IND_LINK } = require('./site-content');

const PUB = path.join(__dirname, '..', 'public');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ld = o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
const ORG = { '@type': 'Organization', '@id': SITE + '/#org', name: 'SatyaSakshi LLP', alternateName: 'Praman', url: SITE + '/', logo: SITE + '/logo.png', slogan: 'Truth Revealed, Trust Restored' };
const faqLd = list => ({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: list.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });

function head({ title, desc, url, extra = '' }) {
  return `<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Praman by SatyaSakshi">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/logo.png">
<meta property="og:locale" content="en_IN">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#04345a">
${extra}`;
}

const CSS = `<style>
:root{--navy:#04345a;--navy2:#0a4a7c;--amber:#c8781f;--ink:#1c2733;--mut:#5b6773;--bg:#f5f7fa;--line:#e1e6ec}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:#fff;line-height:1.6}
a{color:var(--navy2)}.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
header{position:sticky;top:0;z-index:20;background:#fff;border-bottom:1px solid var(--line)}
header .wrap{display:flex;align-items:center;justify-content:space-between;height:64px;gap:12px}
header img{height:34px;width:auto;display:block}nav{display:flex;gap:18px;align-items:center;font-size:14px}
nav a{text-decoration:none;color:var(--mut);font-weight:500}
.btn{display:inline-block;border:none;border-radius:8px;padding:11px 20px;font-weight:600;font-size:14px;text-decoration:none;background:var(--amber);color:#fff}
.btn.ghost{background:transparent;border:1px solid rgba(255,255,255,.5)}nav .btn{color:#fff;padding:9px 16px}
.hero{background:linear-gradient(135deg,var(--navy),var(--navy2));color:#fff;padding:44px 0 52px}
.crumb{font-size:13px;color:#b9cde0;margin-bottom:10px}.crumb a{color:#dce8f3}
h1{font-family:Georgia,serif;font-size:38px;line-height:1.18;margin:6px 0 14px}
.lead{font-size:17px;color:#d6e3f0;max-width:760px;margin:0 0 22px}.cta{display:flex;gap:12px;flex-wrap:wrap}
section{padding:52px 0}section.alt{background:var(--bg)}
h2{font-family:Georgia,serif;font-size:27px;color:var(--navy);margin:0 0 14px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(2,1fr)}.g3{grid-template-columns:repeat(3,1fr)}
.box{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px}
.box h3{margin:0 0 8px;font-size:16.5px;color:var(--navy)}.box ul{margin:0;padding-left:18px;color:var(--mut);font-size:14.5px}
.uses{columns:2;padding-left:18px;color:var(--ink);font-size:15.5px}.uses li{margin-bottom:6px;break-inside:avoid}
.steps{counter-reset:s;display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:0;list-style:none}
.steps li{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px}
.steps li:before{counter-increment:s;content:counter(s);display:inline-flex;width:28px;height:28px;border-radius:50%;background:var(--navy);color:#fff;align-items:center;justify-content:center;font-weight:700;margin-bottom:8px}
.steps b{display:block;color:var(--navy)}.steps span{font-size:14px;color:var(--mut)}
details{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px}
summary{cursor:pointer;font-weight:600;color:var(--navy)}details p{margin:8px 0 0;color:var(--mut)}
.note{font-size:13px;color:var(--mut);margin-top:14px}
.more{display:flex;flex-wrap:wrap;gap:8px}.more a{background:#eef3f8;color:#2b4a66;border-radius:16px;padding:6px 12px;font-size:13.5px;text-decoration:none}
.band{background:var(--navy);color:#fff;text-align:center}.band h2{color:#fff}.band p{color:#c8d8e8}
footer{background:#021f36;color:#9fb4c8;font-size:13px;padding:22px 0}footer .wrap{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}footer a{color:#cfe0ef}
@media(max-width:860px){.grid,.g3{grid-template-columns:1fr}.steps{grid-template-columns:1fr 1fr}.uses{columns:1}h1{font-size:30px}nav a.hide{display:none}}
</style>`;

const HEADER = `<header><div class="wrap"><a href="/"><img src="/logo.png" alt="Praman by SatyaSakshi" width="150" height="34"></a>
<nav><a class="hide" href="/#industries">Industries</a><a class="hide" href="/instant-checks">Instant checks</a><a class="hide" href="/#demo">Request a demo</a><a class="btn" href="/#login">Log in</a></nav></div></header>`;
const FOOTER = `<footer><div class="wrap"><div>© ${new Date().getFullYear()} SatyaSakshi LLP · Praman. All rights reserved.</div><div><a href="/">Home</a> · <a href="/instant-checks">Instant checks</a> · <a href="/privacy.html">Privacy policy</a></div></div></footer>`;
const checkBoxes = keys => keys.map(k => CHECKS[k]).map(g => `<div class="box"><h3>${g.icon} ${esc(g.name)}</h3><ul>${g.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`).join('');
const stepsHtml = `<ol class="steps">${STEPS.map(([t, d]) => `<li><b>${esc(t)}</b><span>${esc(d)}</span></li>`).join('')}</ol>`;
const faqHtml = list => list.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('');
const demoBand = `<section class="band"><div class="wrap"><h2>See it on your own cases</h2><p>Tell us what you verify today. We will set up a short live demo.</p><div class="cta" style="justify-content:center"><a class="btn" href="/#demo">Request a demo</a><a class="btn ghost" href="/#contact">Contact us</a></div></div></section>`;

function industryPage(p) {
  const url = `${SITE}/industries/${p.slug}`;
  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
    { '@type': 'ListItem', position: 2, name: 'Industries', item: SITE + '/#industries' },
    { '@type': 'ListItem', position: 3, name: p.nav, item: url }] };
  const service = { '@context': 'https://schema.org', '@type': 'Service', name: p.h1, serviceType: p.nav, description: p.desc, areaServed: { '@type': 'Country', name: 'India' }, provider: ORG, url };
  const others = PAGES.filter(x => x.slug !== p.slug);
  return `<!DOCTYPE html>
<html lang="en-IN">
<head>
${head({ title: p.title, desc: p.desc, url, extra: [ld(crumbs), ld(service), ld(faqLd(p.faq))].join('\n') })}
${CSS}
</head>
<body>
${HEADER}
<main>
<div class="hero"><div class="wrap">
<div class="crumb"><a href="/">Home</a> › <a href="/#industries">Industries</a> › ${esc(p.nav)}</div>
<h1>${esc(p.h1)}</h1>
<p class="lead">${esc(p.lead)}</p>
<div class="cta"><a class="btn" href="/#demo">Request a demo</a><a class="btn ghost" href="/#login">Log in</a></div>
</div></div>
<section><div class="wrap"><h2>What you can verify</h2><ul class="uses">${p.uses.map(u => `<li>${esc(u)}</li>`).join('')}</ul></div></section>
<section class="alt"><div class="wrap"><h2>Instant checks for this work</h2>
<p style="color:var(--mut);margin:0 0 20px;max-width:720px">Run from the case in seconds, with the person’s consent. Every result is saved with the case and shown in the report.</p>
<div class="grid">${checkBoxes(p.checks)}</div>
<p class="note">Checks available depend on your plan. <a href="/instant-checks">See all instant checks</a>.</p></div></section>
<section><div class="wrap"><h2>How it works</h2>${stepsHtml}</div></section>
<section class="alt"><div class="wrap"><h2>Questions</h2>${faqHtml(p.faq)}</div></section>
<section><div class="wrap"><h2>Other uses of Praman</h2><div class="more">${others.map(o => `<a href="/industries/${o.slug}">${o.icon} ${esc(o.nav)}</a>`).join('')}</div></div></section>
${demoBand}
</main>
${FOOTER}
</body>
</html>
`;
}

function checksPage() {
  const url = SITE + '/instant-checks';
  const title = 'Instant ID, Vehicle, Business, Bank and Court Record Checks | Praman';
  const desc = 'Instant checks inside Praman: PAN, Aadhaar via DigiLocker, Voter ID, driving licence, passport, face match and liveness, RC, e-challan, FASTag, EPFO, GST, Udyam, bank account, UPI, credit score and court records.';
  const used = k => PAGES.filter(p => p.checks.includes(k)).map(p => `<a href="/industries/${p.slug}">${esc(p.nav)}</a>`).join(', ');
  return `<!DOCTYPE html>
<html lang="en-IN">
<head>
${head({ title, desc, url, extra: ld({ '@context': 'https://schema.org', '@type': 'WebPage', name: title, description: desc, url, publisher: ORG }) })}
${CSS}
</head>
<body>
${HEADER}
<main>
<div class="hero"><div class="wrap">
<div class="crumb"><a href="/">Home</a> › Instant checks</div>
<h1>Instant checks, saved with every case</h1>
<p class="lead">Along with the video call, Praman can confirm a person, a vehicle, a business or a bank account in seconds. Checks run with the person’s consent, and each result is stored in the case report with the time it was run.</p>
<div class="cta"><a class="btn" href="/#demo">Request a demo</a><a class="btn ghost" href="/#login">Log in</a></div>
</div></div>
<section><div class="wrap"><div class="grid">${Object.keys(CHECKS).map(k => `<div class="box"><h3>${CHECKS[k].icon} ${esc(CHECKS[k].name)}</h3><ul>${CHECKS[k].items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>${used(k) ? `<p class="note" style="margin-top:10px">Used in: ${used(k)}</p>` : ''}</div>`).join('')}</div>
<p class="note">Full Aadhaar numbers are never stored. Checks available depend on your plan.</p></div></section>
${demoBand}
</main>
${FOOTER}
</body>
</html>
`;
}

// ---- home page blocks ----
function homeBlocks() {
  const desc = 'Praman by SatyaSakshi LLP: insurance claim investigation, digital PIVC, loan, employee, tenant and vendor verification on a WhatsApp video call, with instant PAN, Aadhaar, RC, e-challan, GST, bank and court record checks.';
  const headBlock = `<link rel="canonical" href="${SITE}/">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Praman by SatyaSakshi">
<meta property="og:title" content="Praman: Verification and Claim Investigation Software">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}/">
<meta property="og:image" content="${SITE}/logo.png">
<meta property="og:locale" content="en_IN">
<meta name="twitter:card" content="summary">
${ld({ '@context': 'https://schema.org', '@graph': [
    ORG,
    { '@type': 'WebSite', '@id': SITE + '/#site', url: SITE + '/', name: 'Praman', publisher: { '@id': SITE + '/#org' }, inLanguage: 'en-IN' },
    { '@type': 'SoftwareApplication', name: 'Praman', applicationCategory: 'BusinessApplication', operatingSystem: 'Web, Android', description: desc, publisher: { '@id': SITE + '/#org' }, url: SITE + '/' }] })}
${ld(faqLd(HOME_FAQ))}`;
  const ind = INDUSTRIES.map(([ic, name, ex]) => {
    const slug = IND_LINK[name];
    return `<div class="box"><div class="ic">${ic}</div><h3>${esc(name)}</h3><div class="chips">${ex.map(x => `<span>${esc(x)}</span>`).join('')}</div>${slug ? `<a class="more-link" href="/industries/${slug}">Learn more →</a>` : ''}</div>`;
  }).join('\n');
  const checks = `<section id="checks" class="alt">
  <div class="wrap">
    <div class="kicker">Instant checks</div>
    <h2 class="t">ID, vehicle, business, bank and court checks in seconds</h2>
    <p class="intro">Along with the call, Praman can confirm a person, a vehicle, a business or a bank account. Checks run with consent and every result is saved with the case report.</p>
    <div class="grid g3">${Object.values(CHECKS).map(g => `<div class="box"><div class="ic">${g.icon}</div><h3>${esc(g.name)}</h3><ul>${g.items.slice(0, 4).map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`).join('')}</div>
    <p style="margin-top:18px"><a href="/instant-checks" style="color:var(--navy);font-weight:600">See every instant check →</a></p>
  </div>
</section>`;
  const faq = `<section id="faq">
  <div class="wrap">
    <div class="kicker">Questions</div>
    <h2 class="t">Frequently asked questions</h2>
    <div class="faq">${HOME_FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div>
  </div>
</section>`;
  const foot = `<nav class="flinks" aria-label="Industries">${PAGES.map(p => `<a href="/industries/${p.slug}">${esc(p.nav)}</a>`).join('')}<a href="/instant-checks">Instant checks</a></nav>`;
  return { HEAD: headBlock, INDUSTRIES: ind, CHECKS: checks, FAQ: faq, FOOTLINKS: foot, DESC: `<meta name="description" content="${esc(desc)}">` };
}

function replaceBlock(html, name, inner) {
  const re = new RegExp(`<!--SEO:${name}-->[\\s\\S]*?<!--/SEO:${name}-->`);
  if (!re.test(html)) throw new Error('Marker SEO:' + name + ' not found in login.html');
  return html.replace(re, `<!--SEO:${name}-->\n${inner}\n<!--/SEO:${name}-->`);
}

function build() {
  fs.mkdirSync(path.join(PUB, 'industries'), { recursive: true });
  for (const p of PAGES) fs.writeFileSync(path.join(PUB, 'industries', p.slug + '.html'), industryPage(p));
  fs.writeFileSync(path.join(PUB, 'instant-checks.html'), checksPage());
  const today = new Date().toISOString().slice(0, 10);
  const urls = [[SITE + '/', '1.0'], [SITE + '/instant-checks', '0.8'], ...PAGES.map(p => [`${SITE}/industries/${p.slug}`, '0.8']), [SITE + '/privacy.html', '0.3']];
  fs.writeFileSync(path.join(PUB, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, pr]) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod><priority>${pr}</priority></url>`).join('\n')}\n</urlset>\n`);
  fs.writeFileSync(path.join(PUB, 'robots.txt'), `# Public website pages can be indexed. The app, links sent to customers and the API cannot.
User-agent: *
Allow: /$
Allow: /industries/
Allow: /instant-checks
Allow: /privacy.html
Disallow: /api/
Disallow: /index.html
Disallow: /super-admin.html
Disallow: /platform-access.html
Disallow: /vendor-access.html
Disallow: /setup-super-admin.html
Disallow: /reset-super-admin.html
Disallow: /settings.html
Disallow: /billing-admin.html
Disallow: /fraud.html
Disallow: /insurer.html
Disallow: /report.html
Disallow: /ai-report.html
Disallow: /shared-report.html
Disallow: /verify.html
Disallow: /call.html
Disallow: /ai-call.html
Disallow: /join.html
Disallow: /live.html
Disallow: /live-join.html
Disallow: /check.html
Disallow: /media/

Sitemap: ${SITE}/sitemap.xml
`);
  const homeFile = path.join(PUB, 'login.html');
  let home = fs.readFileSync(homeFile, 'utf8');
  const b = homeBlocks();
  for (const k of ['HEAD', 'DESC', 'INDUSTRIES', 'CHECKS', 'FAQ', 'FOOTLINKS']) home = replaceBlock(home, k, b[k]);
  fs.writeFileSync(homeFile, home);
  return { pages: PAGES.length, urls: urls.length };
}

if (require.main === module) console.log('Built', build());
module.exports = { build };
