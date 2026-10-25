// The message a customer gets with their link: their name, who is asking, WHY (in words that fit
// the service), what will happen on the call, the video call link and, for a live call, the
// Android app with the reason to install it. Hindi first, then English.
//
// WhatsApp rules: a normal (free text) message reaches the customer only within 24 hours of
// their last message; otherwise only an approved template can be sent. Two template shapes work:
//   1. the firm's "link template" with 3 variables: {{1}} name, {{2}} reason, {{3}} link(s)
//   2. the older template with 1 variable: {{1}} link
const plans = require('./plans');
const followup = require('./followup');

const REASON = {
  health_claim: { hi: 'आपके हेल्थ इंश्योरेंस क्लेम की जाँच', en: 'checking your health insurance claim' },
  motor_claim: { hi: 'आपकी गाड़ी के इंश्योरेंस क्लेम की जाँच', en: 'checking your vehicle insurance claim' },
  pivc_life: { hi: 'आपकी नई लाइफ़ इंश्योरेंस पॉलिसी जारी होने से पहले पुष्टि', en: 'confirming your new life insurance policy before it is issued' },
  pivc_term: { hi: 'आपकी नई टर्म इंश्योरेंस पॉलिसी जारी होने से पहले पुष्टि', en: 'confirming your new term insurance policy before it is issued' },
  pivc_health: { hi: 'आपकी नई हेल्थ इंश्योरेंस पॉलिसी जारी होने से पहले पुष्टि', en: 'confirming your new health insurance policy before it is issued' },
  bgv_employee: { hi: 'नई नौकरी के लिए आपका बैकग्राउंड वेरिफ़िकेशन', en: 'your background verification for the new job' }
};
const NUMBER = { health_claim: ['क्लेम नं.', 'claim no.'], motor_claim: ['क्लेम नं.', 'claim no.'], bgv_employee: ['केस नं.', 'case no.'] };
const BRING = {
  health_claim: ['आधार, पैन, अस्पताल का डिस्चार्ज समरी और बिल', 'Aadhaar, PAN, hospital discharge summary and bills'],
  motor_claim: ['आधार, पैन, ड्राइविंग लाइसेंस, RC और FIR (अगर है)', 'Aadhaar, PAN, driving licence, RC and FIR (if any)'],
  bgv_employee: ['आधार, पैन, डिग्री / मार्कशीट और पिछली नौकरी का रिलीविंग लेटर', 'Aadhaar, PAN, degree / marksheet and relieving letter of the last job'],
  pivc: ['आधार और पैन कार्ड', 'Aadhaar and PAN card']
};
const clean1 = v => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim(); // template variables must be one line

function parts(c, firm) {
  const svc = plans.serviceOfCase(c);
  const r = REASON[svc] || REASON.motor_claim;
  const [nh, ne] = NUMBER[svc] || ['पॉलिसी नं.', 'policy no.'];
  const d = c.details || {};
  const insurer = clean1(d.clientName && svc === 'bgv_employee' ? d.clientName : d.insurerName);
  const by = clean1(firm && firm.vendorName) || 'हमारी टीम';
  return {
    svc, name: clean1(c.insuredName) || 'ग्राहक', number: clean1(c.claimNo),
    reasonHi: `${r.hi} (${nh} ${clean1(c.claimNo)})`, reasonEn: `${r.en} (${ne} ${clean1(c.claimNo)})`,
    insurer, by, bring: BRING[svc] || BRING.pivc
  };
}

// Full message for a free-text WhatsApp message or for the executive to copy and send.
// kind: 'live' (video call with an executive) or 'ai' (AI video call the customer can take any time).
function text(c, { firm, joinUrl, appUrl, kind = 'live' } = {}) {
  const p = parts(c, firm);
  const forWhom = p.insurer ? `${p.insurer} की ओर से ` : '';
  const forWhomEn = p.insurer ? ` on behalf of ${p.insurer}` : '';
  const hi = [
    `नमस्ते ${p.name} जी,`,
    `${forWhom}${p.by} — ${p.reasonHi} के लिए आपसे एक छोटी वीडियो कॉल (10–15 मिनट) करनी है।`,
    kind === 'ai'
      ? 'आप यह कॉल अपने समय पर, नीचे दिए लिंक से कर सकते हैं। कॉल पर एक AI असिस्टेंट आपकी भाषा में कुछ सवाल पूछेगा।'
      : 'नीचे दिए लिंक से कॉल में जुड़ें, हमारे अधिकारी आपसे बात करेंगे।',
    `क्यों ज़रूरी है: इससे आपकी पहचान और जानकारी की पुष्टि घर बैठे हो जाती है, आपको कहीं आना नहीं पड़ता और काम जल्दी पूरा होता है।`,
    `कॉल पर पास रखें: ${p.bring[0]}।`,
    `👉 वीडियो कॉल लिंक: ${joinUrl}`,
    ...(appUrl && kind === 'live' ? [`📱 Android ऐप (ज़रूरत हो तो): ${appUrl}`, 'ऐप क्यों: अगर अधिकारी को आपके फ़ोन की स्क्रीन (जैसे मैसेज, पेमेंट या रिपोर्ट) देखनी हो, तो यह ऐप ही आपकी अनुमति से स्क्रीन दिखा पाता है। सिर्फ़ वीडियो कॉल के लिए ऐप ज़रूरी नहीं है। ऐप इंस्टॉल करें, फिर ऊपर वाला लिंक ऐप में खोलें।'] : []),
    'कॉल रिकॉर्ड होगी, कॉल शुरू होने से पहले आपकी अनुमति ली जाएगी। यह लिंक सिर्फ़ आपके लिए है, इसे किसी और को न भेजें।'
  ];
  const en = [
    `Hello ${p.name},`,
    `${p.by}${forWhomEn} needs a short video call (10–15 minutes) for ${p.reasonEn}.`,
    kind === 'ai'
      ? 'You can take this call at a time that suits you, from the link below. An AI assistant will ask a few questions in your language.'
      : 'Join from the link below and our officer will speak with you.',
    'Why: it confirms your identity and details from home, so you do not need to visit anyone and your case moves faster.',
    `Please keep ready: ${p.bring[1]}.`,
    `👉 Video call link: ${joinUrl}`,
    ...(appUrl && kind === 'live' ? [`📱 Android app (if needed): ${appUrl}`, 'Why the app: if the officer needs to see your phone screen (for example messages, payments or reports), only this app can show it, and only with your permission. The video call itself does not need the app. Install it, then open the link above inside the app.'] : []),
    'The call is recorded; your consent is asked before it starts. This link is only for you, please do not share it.'
  ];
  return hi.join('\n') + '\n\n' + en.join('\n');
}

// Template to use outside the 24-hour window, with its parameters.
function template(c, { firm, link, appUrl, fallbackName } = {}) {
  const s = followup.settingsOf(firm);
  if (s.linkTemplate) {
    const p = parts(c, firm);
    const links = appUrl ? `${link} (Android app for screen sharing, only if the officer asks: ${appUrl})` : link;
    return { name: s.linkTemplate, params: [p.name, clean1(`${p.reasonHi} / ${p.reasonEn}`), clean1(links)] };
  }
  return { name: fallbackName || s.reminderTemplate, params: [link] };
}

// Sends the link with the template. Returns the template name used.
async function sendTemplate(c, account, opts = {}) {
  const wa = require('./whatsapp');
  const t = template(c, opts);
  await wa.sendTemplateMessage(c.whatsappNumber, t.name, account, 'en', [{ type: 'body', parameters: t.params.map(x => ({ type: 'text', text: x })) }]);
  return t.name;
}

module.exports = { text, template, sendTemplate, parts, REASON };
