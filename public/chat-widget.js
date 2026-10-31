// Website chat box: answers a fixed set of questions about Praman and takes the visitor's contact
// details for the team. It has NO AI and NO access to any data: every answer is written below, so
// nothing internal can ever be shared. Unknown or internal questions get a polite "our team will help".
(function () {
  if (window.__pramanChat) return; window.__pramanChat = true;
  var EMAIL = 'info@pramanservices.space';
  var opened = 0, topics = [], leadSent = false, startedAt = 0;
  try { leadSent = localStorage.getItem('pmc_lead') === '1'; } catch (e) {}

  var A = {
    what: { q: 'What is Praman?', a: 'Praman, by SatyaSakshi LLP, is verification software. The person joins a recorded video call from a WhatsApp link, instant checks run with their consent, and you get one evidence report. It works for people, businesses, vehicles and claims.' },
    industries: { q: 'Which industries use it?', a: 'Banking and lending, insurance, hiring and HR, real estate and rentals, hospitals and TPAs, e-commerce and marketplaces, fleets and mobility, vendor and dealer onboarding, and government programmes.', link: ['/#industries', 'See all industries'] },
    checks: { q: 'What can be verified?', a: 'Identity documents (PAN, Aadhaar through DigiLocker, Voter ID, driving licence, passport), face match and liveness, vehicles (RC, e-challan, FASTag), employment history, business records (GST, Udyam, company), bank account and UPI name, and court records.', link: ['/instant-checks', 'See all instant checks'] },
    how: { q: 'How does it work?', a: '1) You add the case, or upload many from Excel. 2) The person gets a WhatsApp link, no app needed. 3) A video call (AI or your executive) collects answers, photos and documents. 4) You get the report, and a person signs off the final verdict.' },
    ai: { q: 'Does an AI decide?', a: 'No. The AI asks the questions in the person’s language and raises flags. A person from your team reviews the evidence and gives the final verdict.' },
    language: { q: 'Which languages?', a: 'Calls can run in Hindi, English and other Indian languages. Answers are written down and translated into English for the report.' },
    security: { q: 'Is the data safe?', a: 'Checks run only with consent. Full Aadhaar numbers are never stored, each client sees only its own cases, every action is logged, and files are deleted after the period you choose.', link: ['/privacy.html', 'Privacy policy'] },
    setup: { q: 'How do we start?', a: 'You can start with a pilot on your own cases. Cases can be added one by one, uploaded from Excel, or sent from your system through our API.', lead: true },
    price: { q: 'What does it cost?', a: 'Pricing depends on the services you need and your monthly volume. Share your details and our team will send you a quote.', lead: true },
    demo: { q: 'Book a demo', a: 'Happy to show you Praman on your own kind of case. Please share your details below.', lead: true }
  };
  var MENU = ['what', 'industries', 'checks', 'how', 'price', 'demo'];
  var MORE = ['ai', 'language', 'security', 'setup'];
  // Free text -> answer. Order matters: internal questions are caught first.
  var RULES = [
    [/gridline|gemini|openai|chatgpt|\bmodel\b|\bllm\b|provider|vendor do you use|which api|api key|server|database|source code|tech ?stack|backend|hosting|cloud|password|admin|employee count|revenue|funding|investor|client list|your clients|customers name/i, 'internal'],
    [/price|pricing|cost|charge|rate|fee|kitna|kitne|paisa|plan|quote|quotation|budget/i, 'price'],
    [/demo|trial|pilot|meeting|call me|callback|contact|talk|baat|sales|book/i, 'demo'],
    [/language|hindi|english|tamil|marathi|bengali|bhasha|regional/i, 'language'],
    [/safe|secure|security|privacy|data|consent|dpdp|gdpr|store|retention|delete/i, 'security'],
    [/\bai\b|robot|automat|decide|decision|human/i, 'ai'],
    [/industr|sector|who use|bank|nbfc|loan|insur|hiring|hr\b|employee|tenant|real estate|hospital|tpa|fleet|vendor|dealer|merchant|seller/i, 'industries'],
    [/pan|aadhaar|aadhar|voter|licen|passport|rc\b|challan|fastag|vehicle|gst|udyam|court|bank account|upi|check|verify|verification/i, 'checks'],
    [/how|work|process|step|kaise|start|integrat|excel|bulk|api\b/i, 'how'],
    [/what is|about|praman|satyasakshi|kya hai|company/i, 'what']
  ];

  var css = '.pmc-btn{position:fixed;right:18px;bottom:18px;z-index:9999;background:#c8781f;color:#fff;border:none;border-radius:28px;padding:13px 18px;font:600 14px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);cursor:pointer;display:flex;gap:8px;align-items:center}' +
    '.pmc-box{position:fixed;right:18px;bottom:18px;z-index:10000;width:360px;max-width:calc(100vw - 24px);height:540px;max-height:calc(100vh - 36px);background:#fff;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1c2733}' +
    '.pmc-box.on{display:flex}.pmc-h{background:#04345a;color:#fff;padding:12px 14px;display:flex;align-items:center;gap:10px}.pmc-h b{display:block;font-size:15px}.pmc-h small{color:#b9cde0;font-size:12px}' +
    '.pmc-x{margin-left:auto;background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1;padding:4px}' +
    '.pmc-log{flex:1;overflow-y:auto;padding:12px;background:#f5f7fa}.pmc-m{max-width:88%;padding:9px 12px;border-radius:12px;margin:0 0 8px;white-space:pre-wrap;word-wrap:break-word}' +
    '.pmc-bot{background:#fff;border:1px solid #e1e6ec;border-top-left-radius:4px}.pmc-me{background:#04345a;color:#fff;margin-left:auto;border-top-right-radius:4px}' +
    '.pmc-m a{color:#0a4a7c;font-weight:600}.pmc-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}' +
    '.pmc-chips button{background:#fff;border:1px solid #c9d5e2;color:#0a4a7c;border-radius:16px;padding:6px 11px;font:600 12.5px system-ui,sans-serif;cursor:pointer}' +
    '.pmc-f{background:#fff;border:1px solid #e1e6ec;border-radius:12px;padding:12px;margin:0 0 8px}.pmc-f label{display:block;font-size:12px;font-weight:600;color:#44505c;margin:6px 0 3px}' +
    '.pmc-f input,.pmc-f select,.pmc-f textarea{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #dde1e6;border-radius:8px;font:14px system-ui,sans-serif}' +
    '.pmc-f .ck{display:flex;gap:7px;align-items:flex-start;font-size:12px;color:#5b6773;margin:8px 0;font-weight:400}.pmc-f .ck input{width:auto;margin-top:3px}' +
    '.pmc-f button{width:100%;background:#c8781f;color:#fff;border:none;border-radius:8px;padding:10px;font:600 14px system-ui,sans-serif;cursor:pointer;margin-top:4px}' +
    '.pmc-err{color:#b23a2c;font-size:12.5px;min-height:16px}.pmc-hp{position:absolute;left:-9999px}' +
    '.pmc-in{display:flex;gap:6px;padding:10px;border-top:1px solid #e1e6ec;background:#fff}.pmc-in input{flex:1;padding:9px 10px;border:1px solid #dde1e6;border-radius:8px;font:14px system-ui,sans-serif;min-width:0}' +
    '.pmc-in button{background:#04345a;color:#fff;border:none;border-radius:8px;padding:0 14px;font-weight:600;cursor:pointer}' +
    '.pmc-note{font-size:11px;color:#8a949e;text-align:center;padding:0 10px 8px;background:#fff}' +
    '@media(max-width:480px){.pmc-box{right:0;bottom:0;width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0}.pmc-btn{right:12px;bottom:12px}}';

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var st = el('style', null, css); document.head.appendChild(st);
  var btn = el('button', 'pmc-btn', '<span aria-hidden="true">💬</span> Ask Praman'); btn.type = 'button'; btn.setAttribute('aria-label', 'Open chat');
  var box = el('div', 'pmc-box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Praman chat');
  box.innerHTML = '<div class="pmc-h"><span style="font-size:22px" aria-hidden="true">🛡️</span><div><b>Praman assistant</b><small>Quick answers · our team replies within 1 working day</small></div><button class="pmc-x" type="button" aria-label="Close chat">×</button></div>' +
    '<div class="pmc-log" aria-live="polite"></div>' +
    '<form class="pmc-in"><input placeholder="Type your question…" maxlength="300" aria-label="Your question"><button type="submit">Send</button></form>' +
    '<div class="pmc-note">Automated answers. Please do not share ID numbers or passwords here.</div>';
  document.body.appendChild(btn); document.body.appendChild(box);
  var log = box.querySelector('.pmc-log');

  function scroll() { log.scrollTop = log.scrollHeight; }
  function say(text, who, link) {
    var m = el('div', 'pmc-m ' + (who === 'me' ? 'pmc-me' : 'pmc-bot'));
    m.textContent = text;
    if (link) { m.appendChild(document.createElement('br')); var a = el('a'); a.href = link[0]; a.textContent = link[1] + ' →'; m.appendChild(a); }
    log.appendChild(m); scroll();
  }
  function chips(keys, extra) {
    var c = el('div', 'pmc-chips');
    keys.forEach(function (k) { var b = el('button'); b.type = 'button'; b.textContent = A[k].q; b.onclick = function () { ask(k, true); }; c.appendChild(b); });
    (extra || []).forEach(function (x) { var b = el('button'); b.type = 'button'; b.textContent = x[0]; b.onclick = x[1]; c.appendChild(b); });
    log.appendChild(c); scroll();
  }
  function moreChips() {
    var rest = MENU.concat(MORE).filter(function (k) { return topics.indexOf(k) < 0 && k !== 'demo'; }).slice(0, 4);
    chips(rest, leadSent ? [] : [['Talk to our team', function () { ask('demo', true); }]]);
  }
  function ask(k, clicked) {
    if (clicked) say(A[k].q, 'me');
    if (topics.indexOf(k) < 0) topics.push(k);
    setTimeout(function () {
      say(A[k].a, 'bot', A[k].link);
      if (A[k].lead && !leadSent) form(k);
      else if (!leadSent && topics.length >= 3 && !box.querySelector('.pmc-f')) { say('Would you like our team to contact you about your use case?', 'bot'); chips([], [['Yes, contact me', function () { say('Yes, contact me', 'me'); form('contact'); }], ['Not now', function () { say('Not now', 'me'); moreChips(); }]]); }
      else moreChips();
    }, 250);
  }
  function typed(text) {
    say(text, 'me');
    var hit = null;
    for (var i = 0; i < RULES.length; i++) if (RULES[i][0].test(text)) { hit = RULES[i][1]; break; }
    setTimeout(function () {
      if (hit === 'internal') { say('Sorry, I can’t share internal or technical details here. Our team will be glad to answer on a call.', 'bot'); if (!leadSent) form('question'); else moreChips(); return; }
      if (hit) { ask(hit, false); return; }
      say('I can answer a few common questions. For anything else, leave your details and our team will reply, or write to ' + EMAIL + '.', 'bot');
      if (!leadSent) form('question', text); else moreChips();
    }, 250);
  }

  function form(reason, question) {
    if (box.querySelector('.pmc-f')) { box.querySelector('.pmc-f input').focus(); return; }
    var f = el('form', 'pmc-f');
    f.innerHTML = '<b style="font-size:13.5px">Share your details</b>' +
      '<label for="pmc_n">Your name *</label><input id="pmc_n" autocomplete="name" maxlength="80">' +
      '<label for="pmc_c">Company *</label><input id="pmc_c" autocomplete="organization" maxlength="120">' +
      '<label for="pmc_e">Work email *</label><input id="pmc_e" type="email" autocomplete="email" maxlength="120" placeholder="name@company.com">' +
      '<label for="pmc_p">Mobile</label><input id="pmc_p" type="tel" autocomplete="tel" maxlength="16" placeholder="+91 98XXXXXXXX">' +
      '<label for="pmc_i">What do you want to verify?</label><select id="pmc_i"><option value="">Choose…</option>' +
      ['Insurance claims', 'PIVC / policy verification', 'Loan / borrower verification', 'Employee background checks', 'Tenant verification', 'Vendor / dealer / merchant checks', 'Vehicle and driver checks', 'Hospital / TPA checks', 'Something else'].map(function (x) { return '<option>' + x + '</option>'; }).join('') + '</select>' +
      '<label for="pmc_m">Message</label><textarea id="pmc_m" rows="2" maxlength="500"></textarea>' +
      '<input class="pmc-hp" id="pmc_w" tabindex="-1" autocomplete="off" aria-hidden="true">' +
      '<label class="ck"><input type="checkbox" id="pmc_ok"> I agree that SatyaSakshi LLP may contact me about Praman. <a href="/privacy.html" target="_blank">Privacy</a></label>' +
      '<div class="pmc-err" role="alert"></div><button type="submit">Send</button>';
    log.appendChild(f); scroll();
    if (question) f.querySelector('#pmc_m').value = question;
    var map = { price: 'Please send a quote', demo: 'I would like a demo', setup: 'I would like a pilot' };
    if (map[reason] && !question) f.querySelector('#pmc_m').value = map[reason];
    f.querySelector('#pmc_n').focus();
    f.onsubmit = function (ev) {
      ev.preventDefault();
      var g = function (id) { return f.querySelector('#' + id).value.trim(); }, err = f.querySelector('.pmc-err'), sb = f.querySelector('button');
      var body = { name: g('pmc_n'), company: g('pmc_c'), email: g('pmc_e'), phone: g('pmc_p'), interest: g('pmc_i'), message: g('pmc_m'), website: g('pmc_w'),
        consent: f.querySelector('#pmc_ok').checked, page: location.pathname, topics: topics.slice(0, 15), ms: Date.now() - startedAt };
      if (!body.name || !body.company) { err.textContent = 'Please enter your name and company.'; return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) { err.textContent = 'Please enter a valid email address.'; return; }
      if (body.phone && !/^\+?[\d\s-]{8,16}$/.test(body.phone)) { err.textContent = 'Please check the mobile number.'; return; }
      if (!body.consent) { err.textContent = 'Please tick the box so we may contact you.'; return; }
      err.textContent = ''; sb.disabled = true; sb.textContent = 'Sending…';
      fetch('/api/demo/chat-lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          if (!x.ok) { err.textContent = x.d.error || 'Could not send. Please try again.'; sb.disabled = false; sb.textContent = 'Send'; return; }
          leadSent = true; try { localStorage.setItem('pmc_lead', '1'); } catch (e) {}
          f.remove(); say('Thank you, ' + body.name.split(' ')[0] + '. Our team will contact you within 1 working day.', 'bot'); moreChips();
        })
        .catch(function () { err.textContent = 'Could not send. Please check your internet and try again.'; sb.disabled = false; sb.textContent = 'Send'; });
    };
  }

  function open() {
    box.classList.add('on'); btn.style.display = 'none';
    if (!opened++) {
      startedAt = Date.now();
      say('Hello! I can answer common questions about Praman. What would you like to know?', 'bot');
      chips(MENU);
    }
    box.querySelector('.pmc-in input').focus();
  }
  btn.onclick = open;
  box.querySelector('.pmc-x').onclick = function () { box.classList.remove('on'); btn.style.display = ''; };
  box.querySelector('.pmc-in').onsubmit = function (ev) { ev.preventDefault(); var i = box.querySelector('.pmc-in input'); var t = i.value.trim(); if (!t) return; i.value = ''; typed(t.slice(0, 300)); };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && box.classList.contains('on')) box.querySelector('.pmc-x').click(); });
  fetch('/api/site-info').then(function (r) { return r.json(); }).then(function (d) { if (d && d.email) EMAIL = d.email; }).catch(function () {});
  // Any link to #chat opens the chat box.
  document.addEventListener('click', function (e) { var a = e.target.closest && e.target.closest('a[href="#chat"]'); if (a) { e.preventDefault(); open(); } });
})();
