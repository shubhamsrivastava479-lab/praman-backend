// Screen text for the customer's live video call page, in the customer's
// language. Hindi and English are written here; the other languages are
// translated once by Gemini from the English text and kept in memory.
const LANGUAGES = [
  ['Hindi', 'हिंदी'], ['English', 'English'], ['Bengali', 'বাংলা'], ['Marathi', 'मराठी'],
  ['Telugu', 'తెలుగు'], ['Tamil', 'தமிழ்'], ['Gujarati', 'ગુજરાતી'], ['Kannada', 'ಕನ್ನಡ'],
  ['Malayalam', 'മലയാളം'], ['Punjabi', 'ਪੰਜਾਬੀ'], ['Odia', 'ଓଡ଼ିଆ'], ['Assamese', 'অসমীয়া']
];

const EN = {
  chooseLang: 'Choose your language',
  title: 'Video call with the investigation officer',
  loading: 'Loading…',
  intro: 'The investigation officer will speak with you on video about your case ({caseRef}). Please join from a quiet place.',
  from: 'on behalf of {firm}',
  b1: 'This call will be <b>recorded</b>.',
  b2: 'Your <b>camera, microphone and location</b> will be used.',
  b3: 'If the officer asks, you can turn on the <b>back camera</b> to show the vehicle, items or documents.',
  consent: 'I agree that this video call is recorded and that my camera, microphone and location are used for the investigation.',
  join: 'Join the video call',
  badLink: 'This link is not valid. Please ask for a new link.',
  serverDown: 'Cannot reach the server. Please refresh this page after 30 seconds.',
  allowCam: 'Please allow the camera and microphone, then try again.',
  startFail: 'The call could not start. Please try again.',
  waitOfficer: 'The investigation officer has not joined yet.<br><small>Please stay on this page. The call will start as soon as the officer joins.</small>',
  connecting: 'Connecting you to the investigation officer…',
  officerLeft: 'The officer\'s connection dropped. Please wait…',
  netWeak: 'Weak network. Reconnecting…',
  retrying: 'Having trouble connecting. Trying again…',
  recording: 'Recording',
  mic: 'Mic', flip: 'Switch camera', screen: 'Screen', end: 'End call',
  askBack: 'The officer would like you to turn on the back camera to show the vehicle, items or documents.',
  askFront: 'The officer would like to see your face. Turn on the front camera?',
  notNow: 'Not now', yesOn: 'Yes, turn on',
  connected: 'Connected', connectingShort: 'Connecting',
  endConfirm: 'End the call?',
  thanks: 'Thank you',
  ended: 'The call has ended. You can close this page.',
  replaced: 'This call was opened on another phone or tab.',
  flipFail: 'Could not switch the camera.'
};

const HI = {
  chooseLang: 'अपनी भाषा चुनें',
  title: 'जाँच अधिकारी के साथ वीडियो कॉल',
  loading: 'लोड हो रहा है…',
  intro: 'आपके केस ({caseRef}) के लिए जाँच अधिकारी आपसे वीडियो पर बात करेंगे। कृपया शांत जगह से जुड़ें।',
  from: '{firm} की ओर से',
  b1: 'यह कॉल <b>रिकॉर्ड</b> होगी।',
  b2: 'आपका <b>कैमरा, माइक और लोकेशन</b> इस्तेमाल होगा।',
  b3: 'अधिकारी कहें तो <b>पीछे का कैमरा</b> चालू करके गाड़ी, सामान या कागज़ दिखा सकते हैं।',
  consent: 'मैं सहमत हूँ कि यह वीडियो कॉल रिकॉर्ड हो और जाँच के लिए मेरा कैमरा, माइक और लोकेशन इस्तेमाल हो।',
  join: 'वीडियो कॉल से जुड़ें',
  badLink: 'यह लिंक सही नहीं है। कृपया नया लिंक मँगवाएँ।',
  serverDown: 'सर्वर से जुड़ नहीं पा रहे। 30 सेकंड बाद पेज रीफ़्रेश करें।',
  allowCam: 'कृपया कैमरा और माइक की अनुमति दें, फिर दोबारा कोशिश करें।',
  startFail: 'कॉल शुरू नहीं हो सकी। दोबारा कोशिश करें।',
  waitOfficer: 'जाँच अधिकारी अभी कॉल पर नहीं आए हैं।<br><small>कृपया इसी पेज पर बने रहें। अधिकारी के जुड़ते ही कॉल शुरू हो जाएगी।</small>',
  connecting: 'जाँच अधिकारी से जोड़ रहे हैं…',
  officerLeft: 'अधिकारी का कनेक्शन टूट गया। कृपया इंतज़ार करें…',
  netWeak: 'नेटवर्क कमज़ोर है। फिर से जोड़ रहे हैं…',
  retrying: 'जुड़ने में दिक्कत आ रही है। फिर से कोशिश कर रहे हैं…',
  recording: 'रिकॉर्डिंग',
  mic: 'माइक', flip: 'कैमरा बदलें', screen: 'स्क्रीन', end: 'कॉल ख़त्म',
  askBack: 'जाँच अधिकारी चाहते हैं कि आप पीछे का कैमरा चालू करें, ताकि गाड़ी, सामान या कागज़ दिखा सकें।',
  askFront: 'जाँच अधिकारी आपका चेहरा देखना चाहते हैं। सामने का कैमरा चालू करें?',
  notNow: 'अभी नहीं', yesOn: 'हाँ, चालू करें',
  connected: 'जुड़े हुए', connectingShort: 'जोड़ रहे हैं',
  endConfirm: 'कॉल ख़त्म करें?',
  thanks: 'धन्यवाद',
  ended: 'कॉल ख़त्म हो गई। आप यह पेज बंद कर सकते हैं।',
  replaced: 'यह कॉल किसी दूसरे फ़ोन या टैब पर खुल गई है।',
  flipFail: 'कैमरा बदल नहीं पाए।'
};

const cache = new Map([['English', EN], ['Hindi', HI]]);
const pending = new Map();

async function textsFor(language) {
  const lang = LANGUAGES.find(([v]) => v === language) ? language : 'Hindi';
  if (cache.has(lang)) return { language: lang, texts: cache.get(lang) };
  if (!pending.has(lang)) {
    const gemini = require('./gemini');
    pending.set(lang, gemini.translateStrings(EN, lang)
      .then(t => { cache.set(lang, t); return t; })
      .finally(() => pending.delete(lang)));
  }
  try { return { language: lang, texts: await pending.get(lang) }; }
  catch (e) {
    console.warn(`Live call text translation to ${lang} failed:`, e.message);
    return { language: lang, texts: EN, fallback: true };
  }
}

module.exports = { LANGUAGES, textsFor, EN };
