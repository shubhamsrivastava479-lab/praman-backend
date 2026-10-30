const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
// Used when the main model is busy (503), over its quota (429) or not found (404).
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash-lite,gemini-3.8-flash').split(',').map(s => s.trim()).filter(Boolean);
const GEMINI_TTS_MODELS = (process.env.GEMINI_TTS_MODELS || 'gemini-3.8-flash-tts,gemini-3.8-flash-lite-tts,gemini-3.1-flash-tts-preview').split(',').map(s => s.trim()).filter(Boolean);
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const { getSetting } = require('./platform-settings');

async function getApiKey() {
  const key = await getSetting('geminiApiKey', 'GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY is not set — configure it in Super Admin settings or .env');
  return key;
}

// A model that just said "quota exceeded" is skipped for a minute, so a live
// call does not wait on it again and again.
const cooldown = new Map();
const RETRYABLE = new Set([404, 429, 500, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Calls one generateContent endpoint, trying each model in order.
async function generate(models, body, label, opts = {}) {
  const apiKey = await getApiKey();
  const perTry = opts.timeoutMs || 25000;            // one request
  const deadline = Date.now() + (opts.budgetMs || 50000); // whole call, all models: never keep the customer waiting longer
  const list = models.filter(m => !(cooldown.get(m) > Date.now()));
  if (!list.length) list.push(...models); // all cooling down: try anyway
  let lastErr;
  for (const model of list) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() > deadline) { require('./usage').record({ label, model: models[0] || '', ok: false }); throw lastErr || new Error(`${label} timed out`); }
      let res;
      try {
        res = await fetch(`${BASE_URL}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.max(3000, Math.min(perTry, deadline - Date.now())))
        });
      } catch (e) { lastErr = new Error(`${label} network error (${model}): ${e.message}`); cooldown.set(model, Date.now() + 30_000); break; } // slow/dead model: skip it for 30 s
      if (res.ok) { cooldown.delete(model); const json = await res.json(); require('./usage').record({ label, model, ok: true, reply: json }); return json; }
      const errText = await res.text();
      lastErr = new Error(`${label} error ${res.status} (${model}): ${errText}`);
      if (!RETRYABLE.has(res.status)) throw lastErr; // bad key / bad request: no point trying others
      if (res.status === 429) { cooldown.set(model, Date.now() + 60_000); break; }
      if (res.status === 404) break;
      if (res.status === 503 || res.status === 500) { cooldown.set(model, Date.now() + 20_000); break; } // overloaded: next model now
    }
  }
  require('./usage').record({ label, model: models[0] || '', ok: false });
  throw lastErr;
}

// light: simple jobs (translating a fixed line) go to the cheaper model first.
const GEMINI_LIGHT_MODEL = process.env.GEMINI_LIGHT_MODEL || 'gemini-3.5-flash-lite';
async function callGemini(parts, { jsonOutput = false, light = false } = {}) {
  const first = light ? GEMINI_LIGHT_MODEL : GEMINI_MODEL;
  const data = await generate([first, ...[GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS].filter(m => m !== first)], {
    contents: [{ parts }],
    ...(jsonOutput ? { generationConfig: { responseMimeType: 'application/json' } } : {})
  }, 'Gemini API');
  return data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
}

async function translateText(text, targetLang = 'English') {
  const prompt = `Translate the following text to ${targetLang}. Return only the translation, no preamble:\n\n"${text}"`;
  return (await callGemini([{ text: prompt }], { light: true })).trim();
}

// Translates a flat { key: "English text" } object in one call. Keeps the
// keys, placeholders like {caseRef} and simple HTML tags (<b>, <br>) as-is.
async function translateStrings(obj, targetLang) {
  const prompt = `Translate every value of this JSON object from English to ${targetLang}, for a customer of an Indian insurance company on a mobile phone. Use simple, polite, everyday ${targetLang} in its native script. Keep the keys unchanged. Keep placeholders in curly braces (like {caseRef}) and HTML tags (<b>, </b>, <br>, <small>) exactly as they are. Return only the JSON object.\n\n${JSON.stringify(obj)}`;
  const out = parseJson(await callGemini([{ text: prompt }], { jsonOutput: true }), null);
  if (!out || typeof out !== 'object') throw new Error('Translation failed');
  const clean = {};
  for (const k of Object.keys(obj)) clean[k] = typeof out[k] === 'string' && out[k].trim() ? out[k] : obj[k];
  return clean;
}

// Generates spoken audio for a piece of text using Gemini's native audio
// model. The model auto-detects the language of the input text, so to
// speak in a specific language, feed it text already in that language
// (translateText() first, if needed) — see routes/participant.js "speak".
// Returns raw PCM audio (base64) + its mime type (e.g. "audio/L16;rate=24000").
async function generateSpeech(text, voiceName = 'Kore') {
  const data = await generate(GEMINI_TTS_MODELS, {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
    }
  }, 'Gemini TTS', { timeoutMs: 15000, budgetMs: 25000 });
  const part = data?.candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data) throw new Error('Gemini TTS returned no audio');
  return { base64Audio: part.inlineData.data, mimeType: part.inlineData.mimeType || 'audio/L16;rate=24000' };
}

async function transcribeAndTranslateAudio(base64Audio, mimeType = 'audio/ogg') {
  const prompt = `Listen to this audio clip. Respond ONLY with JSON in this exact shape:
{"language": "<detected language name>", "original": "<transcription in the original language>", "english": "<English translation>", "clear": true, "otherVoiceHeard": false}
Set "otherVoiceHeard" to true ONLY if a second person is clearly speaking or prompting the customer in the background (telling them what to say); ordinary background noise is false.
Set "clear" to false, and leave "original" and "english" as empty strings, if the clip has no clear human speech (only silence, background noise, music, TV, or a voice too faint to understand). Never guess words that you cannot hear.`;
  const raw = await callGemini(
    [
      { text: prompt },
      { inlineData: { mimeType, data: base64Audio } }
    ],
    { jsonOutput: true }
  );
  try {
    return JSON.parse(raw);
  } catch {
    return { language: 'unknown', original: raw, english: raw };
  }
}

async function analyzeImage(base64Image, mimeType = 'image/jpeg') {
  const prompt = `You are assisting an insurance fraud investigator. Look at this
image from a motor claim case (it may be a damage photo, an ID document, or a
screenshot). Respond ONLY with JSON in this shape:
{"documentType": "<damage_photo|id_document|rc|dl|screenshot|other>",
 "visibleText": "<any dates, names, numbers, or text visible in the image>",
 "notableDetails": "<anything an investigator should notice, or empty string>"}`;
  const raw = await callGemini(
    [
      { text: prompt },
      { inlineData: { mimeType, data: base64Image } }
    ],
    { jsonOutput: true }
  );
  try {
    return JSON.parse(raw);
  } catch {
    return { documentType: 'other', visibleText: '', notableDetails: raw };
  }
}

async function draftReport({ caseInfo, evidenceSummaries, transcriptText }) {
  const prompt = `You are drafting the Observation and Conclusion sections of a
formal motor insurance investigation report. Use ONLY the facts given below.
Explicitly flag contradictions between what different people said. Do not
invent facts that are not present in the evidence. Write in plain, formal
English matching the style of an insurance investigation report.

CASE:
${JSON.stringify(caseInfo, null, 2)}

EVIDENCE VAULT (from WhatsApp + uploads):
${evidenceSummaries.map((e, i) => `${i + 1}. [${e.type}] ${e.summary}`).join('\n')}

CALL TRANSCRIPT (translated to English):
${transcriptText || '(no call transcript yet)'}

Return the report as HTML using <h2> for section headings ("Observation",
"Conclusion") and <p> for paragraphs. No other commentary.`;

  const html = await callGemini([{ text: prompt }]);
  return html.replace(/^```html\s*|```\s*$/g, '').trim();
}

// Checks a live selfie for basic liveness signals (a real face is visible,
// a hand-held challenge code matches what the wizard displayed, no obvious
// signs of a photo-of-a-photo/screen replay) and gives an opinion on
// whether it looks like the same person as their earlier ID photo. This is
// a practical, low-cost check using Gemini Vision — not a certified
// biometric liveness product. For higher assurance, a dedicated liveness
// API (e.g. Gridlines' Liveness/Face-match product) can replace this later
// without changing anything else in the flow.
async function checkLiveness(base64Selfie, challengeCode, base64IdPhoto) {
  const prompt = `You are a KYC liveness reviewer. Look at this live selfie photo.
The person was asked to hold up a piece of paper with the code "${challengeCode}"
written on it, to prove the photo was taken live just now (not reused from
an old photo or replayed from a screen).
${base64IdPhoto ? 'A second image is also provided: their earlier-uploaded ID photo, for a same-person comparison.' : ''}
Respond ONLY with JSON in this shape:
{"faceVisible": true|false,
 "codeVisible": "<the code you can read in the image, or empty string>",
 "codeMatches": true|false,
 "possibleSpoof": "<brief note if you see signs of a photo-of-a-photo, screen glare/moire, or a printed face — otherwise empty string>",
 "samePersonOpinion": "<if a second ID photo was given: likely_same | likely_different | uncertain — otherwise empty string>"}`;

  const parts = [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: base64Selfie } }];
  if (base64IdPhoto) parts.push({ inlineData: { mimeType: 'image/jpeg', data: base64IdPhoto } });

  const raw = await callGemini(parts, { jsonOutput: true });
  try {
    return JSON.parse(raw);
  } catch {
    return { faceVisible: false, codeVisible: '', codeMatches: false, possibleSpoof: 'Could not analyze image', samePersonOpinion: '' };
  }
}


// ---------- Full-automation AI verification call helpers ----------

function parseJson(raw, fallback) {
  try { return JSON.parse(String(raw).replace(/^```json\s*|```\s*$/g, '').trim()); } catch { return fallback; }
}

// Reads ANY document a customer sends on WhatsApp (photo of a paper, ID card,
// PDF, bill, FIR, discharge summary, RC, DL ...) and returns its full text,
// an English version, and — when it is an ID card — the structured ID fields
// the AI verification call uses. For Aadhaar images it also returns where the
// 12-digit number is printed, so we can black out the first 8 digits before
// the image is stored.
async function readDocument(base64, mimeType = 'image/jpeg') {
  const isImage = /^image\//.test(mimeType);
  const prompt = `You are a document reader for an Indian insurance investigation firm. Read the attached ${isImage ? 'image' : 'document'} completely.
Respond ONLY with JSON in exactly this shape (use "" or [] when not applicable):
{"documentType":"aadhaar|pan|driving_licence|voter_id|passport|rc|insurance_policy|proposal_form|medical_record|hospital_bill|discharge_summary|fir|bank_document|photo|screenshot|other",
 "title":"<short human title, e.g. 'Aadhaar card (front)', 'Hospital bill — City Hospital', 'Photo of damaged car'>",
 "language":"<main language of the text>",
 "extractedText":"<ALL readable text exactly as written, in the original language and script, line by line. For a photo with no text, empty string>",
 "englishText":"<English translation of extractedText if it is not already English, else empty string>",
 "keyDetails":"<3-6 short lines with the facts an investigator needs: names, dates, amounts, numbers, places, hospital/doctor, vehicle no., etc.>",
 "observations":"<for photos: what the photo shows and anything suspicious (edited, screenshot of a screen, mismatched dates); else empty>",
 "side":"front|back|unknown",
 "name":"<person's full name if this is an ID card>",
 "idNumber":"<ID number if this is an ID card: Aadhaar 12 digits without spaces, PAN 10 characters, or other ID number>",
 "dob":"<date of birth DD/MM/YYYY if printed>",
 "gender":"<male|female|other|''>",
 "fatherName":"<father's or husband's name if printed>",
 "address":"<full address if printed>",
 "hasPhoto": true|false,
 "readable": true|false,
 "aadhaarNumberBoxes": [<only for an Aadhaar IMAGE: one [ymin, xmin, ymax, xmax] box per place where the 12-digit Aadhaar number or 16-digit VID is printed, coordinates normalised 0-1000>],
 "chatScreenshot": <ONLY if this is a screenshot of WhatsApp or another chat app (a chat list, search results or an open chat), else null:
   {"app":"whatsapp|other", "searchTerm":"<the word typed in the search bar, if visible>",
    "entries":[{"chat":"<chat or group name / contact>", "date":"<date shown, as DD/MM/YYYY when possible, or as written e.g. Yesterday>", "time":"<time if shown>", "sender":"<who wrote it, if visible>", "text":"<the message text shown, in the original language>", "english":"<English translation if not English, else empty>"}]}>}
For a chat screenshot use documentType "screenshot".`;
  const raw = await callGemini([{ text: prompt }, { inlineData: { mimeType, data: base64 } }], { jsonOutput: true });
  return parseJson(raw, { documentType: 'other', title: '', language: '', extractedText: '', englishText: '', keyDetails: '', observations: '', side: 'unknown', name: '', idNumber: '', dob: '', gender: '', fatherName: '', address: '', hasPhoto: false, readable: false, aadhaarNumberBoxes: [], chatScreenshot: null });
}

// Short description + speech transcript of a WhatsApp video (under ~18 MB).
async function describeVideo(base64, mimeType = 'video/mp4') {
  const prompt = `You are assisting an Indian insurance investigator. Watch this video sent by a customer on WhatsApp.
Respond ONLY with JSON:
{"title":"<short title, e.g. 'Video of damaged vehicle at garage'>",
 "description":"<what the video shows, in 3-6 short sentences, with places, vehicles, people, documents visible>",
 "speech":"<what people say in the video, in the original language; empty if nobody speaks>",
 "speechEnglish":"<English translation of speech if not English; else empty>",
 "observations":"<anything an investigator should notice or that looks staged/edited; else empty>"}`;
  const raw = await callGemini([{ text: prompt }, { inlineData: { mimeType, data: base64 } }], { jsonOutput: true });
  return parseJson(raw, { title: 'Video', description: '', speech: '', speechEnglish: '', observations: '' });
}

// Reads an Aadhaar / PAN / other ID image (or PDF) sent on WhatsApp and
// returns structured fields. The caller decides what to persist (full ID
// numbers are only ever kept in memory, see services/ai-call-engine.js).
async function extractIdDocument(base64, mimeType = 'image/jpeg') {
  const prompt = `You are reading an Indian identity document photo (Aadhaar card, PAN card, or something else).
Respond ONLY with JSON in exactly this shape (use "" when a field is not visible):
{"documentType":"aadhaar|pan|driving_licence|voter_id|other",
 "side":"front|back|unknown",
 "name":"<full name as printed>",
 "idNumber":"<Aadhaar 12 digits without spaces, or PAN 10 characters, or other ID number>",
 "dob":"<date of birth as DD/MM/YYYY if visible, else year of birth>",
 "gender":"<male|female|other|''>",
 "fatherName":"<father's name if printed>",
 "address":"<full address if visible (usually Aadhaar back)>",
 "hasPhoto": true|false,
 "readable": true|false,
 "tamperSigns": "<only if you can SEE signs the document was edited or is not original: mismatched fonts or spacing in the name / number / date, pasted or blurred photo edges, uneven print quality, a photo of a screen or a photocopy; otherwise empty string. Do not guess.>"}`;
  const raw = await callGemini([{ text: prompt }, { inlineData: { mimeType, data: base64 } }], { jsonOutput: true });
  return parseJson(raw, { documentType: 'other', side: 'unknown', name: '', idNumber: '', dob: '', gender: '', fatherName: '', address: '', hasPhoto: false, readable: false });
}

// Face photo taken by the AI during the call (customer holds phone in front
// of face). Optionally compares against the photo printed on the Aadhaar.
async function checkFacePhoto(base64Selfie, base64IdPhoto) {
  const prompt = `You are a KYC reviewer. The first image is a photo captured live during a video verification call.
${base64IdPhoto ? 'The second image is an identity card (Aadhaar). Compare the live face with the photo printed on the card.' : ''}
Respond ONLY with JSON:
{"faceVisible": true|false,
 "singleFace": true|false,
 "eyesOpenFacingCamera": true|false,
 "possibleSpoof": "<note if this looks like a photo of a screen, a printed photo, or an edited / face-swapped image (warped edges, uneven lighting on the face, glare or moire lines); otherwise empty string>",
 "samePersonOpinion": "<likely_same|likely_different|uncertain|not_compared>"}`;
  const parts = [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: base64Selfie } }];
  if (base64IdPhoto) parts.push({ inlineData: { mimeType: 'image/jpeg', data: base64IdPhoto } });
  const raw = await callGemini(parts, { jsonOutput: true });
  return parseJson(raw, { faceVisible: false, singleFace: false, eyesOpenFacingCamera: false, possibleSpoof: 'Could not analyze image', samePersonOpinion: 'uncertain' });
}

// Full-body photo of the insured (PIVC / term underwriting check).
// expectedPose: "standing" | "sitting". refFaceB64 = the live face photo
// taken earlier in the same call, so the AI can say if it is the same person.
async function checkBodyPhoto(base64Photo, expectedPose, refFaceB64) {
  const prompt = `You are a reviewer for a life insurance verification video call. The FIRST image was just captured live from the customer's phone camera. The customer was asked to be ${expectedPose === 'sitting' ? 'SITTING on a chair' : 'STANDING straight'}, with the whole body from head to feet visible.
${refFaceB64 ? 'The SECOND image is the live face photo taken a few minutes earlier in the same call.' : ''}
Be factual and neutral. Do not guess medical conditions; only note things that are clearly visible.
Respond ONLY with JSON:
{"personVisible": true|false,
 "singlePerson": true|false,
 "fullBodyVisible": true|false,
 "pose": "standing|sitting|lying|other|unclear",
 "samePersonOpinion": "<likely_same|likely_different|uncertain|not_compared>",
 "apparentAgeRange": "<e.g. 30-40, or empty>",
 "visibleHealthIndicators": "<ONLY if clearly visible: walking aid, wheelchair, plaster/cast, bandage, missing limb, oxygen tube, IV line; otherwise empty string>",
 "possibleSpoof": "<note if this looks like a photo of a screen or a printed photo, otherwise empty string>",
 "guidance": "<if the photo is not acceptable, ONE short instruction to fix it, e.g. step back so feet are visible; otherwise empty>"}`;
  const parts = [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: base64Photo } }];
  if (refFaceB64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: refFaceB64 } });
  const raw = await callGemini(parts, { jsonOutput: true });
  return parseJson(raw, { personVisible: false, singlePerson: false, fullBodyVisible: false, pose: 'unclear', samePersonOpinion: 'uncertain', apparentAgeRange: '', visibleHealthIndicators: '', possibleSpoof: 'Could not analyze image', guidance: '' });
}

// Eye-blink liveness: a burst of frames captured ~250 ms apart while the
// customer was asked to slowly close and open their eyes twice.
async function checkBlink(framesB64) {
  const prompt = `These ${framesB64.length} images are consecutive frames (about 250 ms apart) from a live front camera. The person was asked to slowly close and open their eyes two times.
Respond ONLY with JSON:
{"faceVisible": true|false,
 "sameFaceAllFrames": true|false,
 "eyesClosedInSomeFrame": true|false,
 "eyesOpenInSomeFrame": true|false,
 "closedFrameIndex": <0-based index of a frame with eyes clearly closed, or -1>,
 "openFrameIndex": <0-based index of a frame with eyes clearly open, or -1>,
 "possibleSpoof": "<note if this looks like a static photo, a screen, a printed picture, a replayed video, or a face-swap / deepfake (blurred or warped face edges, flickering skin, eyes or mouth not moving naturally, screen glare or moire lines); otherwise empty string>"}`;
  const parts = [{ text: prompt }, ...framesB64.map(d => ({ inlineData: { mimeType: 'image/jpeg', data: d } }))];
  const raw = await callGemini(parts, { jsonOutput: true });
  return parseJson(raw, { faceVisible: false, sameFaceAllFrames: false, eyesClosedInSomeFrame: false, eyesOpenInSomeFrame: false, closedFrameIndex: -1, openFrameIndex: -1, possibleSpoof: 'Could not analyze frames' });
}

// Random live challenge: a pre-recorded or replayed video cannot follow an unpredictable instruction.
const CHALLENGES = {
  turn_left: 'turn their head slowly to one side and back to the front (a clear sideways head turn, either direction counts because the camera may be mirrored)',
  turn_right: 'turn their head slowly to one side and back to the front (a clear sideways head turn, either direction counts because the camera may be mirrored)',
  look_up: 'tilt their head up and look at the ceiling, then back to the camera',
  nod: 'nod their head up and down two times'
};
async function checkChallenge(framesB64, challenge) {
  const what = CHALLENGES[challenge] || CHALLENGES.nod;
  const prompt = `These ${framesB64.length} images are consecutive frames (about 250 ms apart) from a live front camera in an insurance verification call. The person was asked to ${what}.
Respond ONLY with JSON:
{"faceVisible": true|false,
 "sameFaceAllFrames": true|false,
 "actionPerformed": true|false,
 "possibleSpoof": "<note if this looks like a static photo, a screen, a replayed video or a face-swap / deepfake (warped face edges when the head turns, flicker, glare); otherwise empty string>"}
Set actionPerformed to true only if the frames clearly show the requested head movement.`;
  const parts = [{ text: prompt }, ...framesB64.map(d => ({ inlineData: { mimeType: 'image/jpeg', data: d } }))];
  const raw = await callGemini(parts, { jsonOutput: true });
  return parseJson(raw, { faceVisible: false, sameFaceAllFrames: false, actionPerformed: false, possibleSpoof: 'Could not analyze frames' });
}

// Reads all answers of a finished call and lists contradictions (between answers, or with the record).
async function checkConsistency({ caseType, caseInfo, answers, docs }) {
  const lines = (answers || []).filter(a => a.english || a.value).map(a => `- [${a.key}] Q: ${a.question}\n  A: ${(a.english || a.value || '').slice(0, 300)}`).join('\n');
  const prompt = `You review a finished insurance verification call (${caseType}). Find CONTRADICTIONS only: places where the customer's own answers disagree with each other, with the case record, or with the identity document details. Ignore vague, short or missing answers, and ignore recognition errors that are plausibly just mis-heard.
CASE RECORD: ${JSON.stringify(caseInfo)}
ID DOCUMENT DETAILS (from the cards): ${JSON.stringify(docs || {})}
ANSWERS:
${lines}

Respond ONLY with JSON: {"issues":[{"issue":"<one plain sentence naming both conflicting facts>","severity":"low|medium|high"}]}
Return {"issues":[]} if there is no clear contradiction. Do not invent issues.`;
  const raw = await callGemini([{ text: prompt }], { jsonOutput: true, light: true });
  const out = parseJson(raw, { issues: [] });
  return (Array.isArray(out.issues) ? out.issues : []).filter(x => x && x.issue).slice(0, 6);
}

// Interprets one spoken answer (already transcribed to English).
// kind: name | confirm | capture | otp | free
async function judgeAnswer({ kind, question, answerEnglish, expected }) {
  const prompt = `You are the voice agent of an insurance verification call. You asked the customer a question and they answered (transcribed, translated to English, may contain recognition errors).
QUESTION: ${question}
${expected ? 'VALUE ON RECORD: ' + expected : ''}
CUSTOMER ANSWER: "${answerEnglish}"
TASK KIND: ${kind}

Respond ONLY with JSON:
{"intent":"yes|no|unclear",
 "value":"<${kind === 'name' ? 'the customer full name only' : kind === 'otp' ? 'only the digits spoken, no spaces' : 'the key fact the customer stated, short and plain; empty if none'}>",
 "clear": true|false,
 "followUp":"<ONE short clarifying question if the answer is vague, incomplete or suspicious; otherwise empty string>",
 "concern":"<short note if the answer contradicts the record or sounds suspicious/evasive; otherwise empty string>"}
For kind "confirm": intent is yes if they agree the record is correct, no if they say it is wrong, unclear otherwise; put any corrected value they state in "value".
For other kinds intent can be "unclear" only when nothing useful was said.`;
  const raw = await callGemini([{ text: prompt }], { jsonOutput: true });
  return parseJson(raw, { intent: 'unclear', value: '', clear: false, followUp: '', concern: '' });
}

// Pulls the values a customer stated out of one answer, as plain values for an exact comparison
// in code. Dates and numbers: the record is NOT shown to the AI, so it cannot lean towards it.
// Text (names, places): the record is shown only to ask whether both name the same thing.
async function extractValues({ question, answerEnglish, fields }) {
  const list = fields.map(f => `- ${f.field} (${f.type}${f.type === 'text' ? `; record says "${f.expected}"` : ''}): ${f.label}`).join('\n');
  const prompt = `A customer answered a question on an insurance verification call (transcribed and translated to English, may contain recognition errors).
QUESTION: ${question}
ANSWER: "${answerEnglish}"

For each field below, write only what the CUSTOMER said. Never fill in a value they did not say.
${list}

Formats: date -> YYYY-MM-DD (YYYY-MM if they gave only month and year; use the current year ${new Date().getFullYear()} only if they clearly meant this year); amount -> digits only in rupees ("1.8 lakh" -> 180000, "50 hazaar" -> 50000); year -> 4 digits; number -> digits only; text -> their words, short.
For text fields also say if what they said names the SAME thing as the record (spelling, short forms and local names count as the same; a different hospital, company, person or place is not).
Respond ONLY with JSON: {"fields":{"<field>":{"said":"<value or empty>","sameAsRecord":true|false|null}}}`;
  const raw = await callGemini([{ text: prompt }], { jsonOutput: true, light: true });
  return parseJson(raw, { fields: {} });
}

// Final structured summary of an AI-run verification call.
async function summarizeAiCall({ caseType, caseInfo, answers, checks, flags }) {
  const prompt = `You are summarising a fully automated AI verification call for an insurance company reviewer.
Use ONLY the data below. Do not invent facts.
CASE TYPE: ${caseType}
CASE RECORD: ${JSON.stringify(caseInfo)}
Q&A (English): ${JSON.stringify(answers.map(a => ({ section: a.section, q: a.question, a: a.english, concern: a.concern })))}
AUTOMATED CHECKS: ${JSON.stringify(checks.map(c => ({ check: c.label, result: c.result, detail: c.detail })))}
FLAGS: ${JSON.stringify(flags)}

Respond ONLY with JSON:
{"summary":"<5-8 plain sentences for the reviewer>",
 "sections":{"identity":{"status":"confirmed|discrepancy|pending","notes":"<one line>"},
             "healthDisclosure":{"status":"...","notes":"..."},
             "incomeOccupation":{"status":"...","notes":"..."},
             "nominee":{"status":"...","notes":"..."},
             "policyDetails":{"status":"...","notes":"..."}},
 "concerns":["<each concern as one short line>"]}
For a claim investigation case, still fill "sections" (use "pending" where not asked).`;
  const raw = await callGemini([{ text: prompt }], { jsonOutput: true });
  return parseJson(raw, { summary: '', sections: {}, concerns: [] });
}

// Looks at the WhatsApp search results a claim customer sent (screenshots)
// and compares them with what the customer said about the incident.
async function assessChatHistory({ caseInfo, incident, entries }) {
  const prompt = `You are assisting an Indian motor/property insurance claim investigator. The customer searched their own WhatsApp for words like accident, theft and police and sent screenshots of the search results. The messages below were read from those screenshots by AI (dates may be relative, e.g. "Yesterday", or partial).
CASE: ${JSON.stringify(caseInfo)}
WHAT THE CUSTOMER SAID ABOUT THE INCIDENT (English): ${JSON.stringify(incident)}
MESSAGES FOUND: ${JSON.stringify(entries)}
Use ONLY this data. Do not invent facts. Respond ONLY with JSON:
{"assessment":"<3-5 plain sentences: who the incident was discussed with, the earliest date it was mentioned, and whether this fits the customer's account>",
 "firstMention":{"date":"<earliest date found, or empty>","chat":"<with whom>"},
 "peopleTold":["<chat / contact names the incident was discussed with>"],
 "consistent": true|false|null,
 "concerns":["<each specific point that needs checking, e.g. incident mentioned before the stated date, a different story told to someone, talk of a planned claim; empty list if none>"]}
Use null for "consistent" when there is too little to judge (e.g. no relevant messages).`;
  const raw = await callGemini([{ text: prompt }], { jsonOutput: true });
  return parseJson(raw, { assessment: '', firstMention: { date: '', chat: '' }, peopleTold: [], consistent: null, concerns: [] });
}

// Every exported job runs with its own name as the "task", so cost is counted per job.
const TASK = {
  transcribeAndTranslateAudio: 'Speech to text (customer voice)', generateSpeech: 'Voice of the AI (text to speech)', translateText: 'Translation',
  translateStrings: 'Translation', judgeAnswer: 'Understanding answers', extractValues: 'Reading values for record match', checkFacePhoto: 'Face photo check',
  checkBlink: 'Blink check', checkChallenge: 'Random action check', checkBodyPhoto: 'Body photo check', extractIdDocument: 'Reading Aadhaar / PAN',
  summarizeAiCall: 'Call summary', checkConsistency: 'Consistency check', assessChatHistory: 'WhatsApp screenshots check', readDocument: 'Reading WhatsApp documents',
  describeVideo: 'Describing WhatsApp videos', analyzeImage: 'Reading images', draftReport: 'Report drafting', checkLiveness: 'Liveness (older check)'
};
const tracked = (name, fn) => (...args) => require('./usage').run({ task: TASK[name] || name }, () => fn(...args));
module.exports = Object.fromEntries(Object.entries({
  checkChallenge, checkConsistency, extractValues, translateStrings, readDocument, assessChatHistory, describeVideo, extractIdDocument, checkFacePhoto, checkBodyPhoto, checkBlink, judgeAnswer, summarizeAiCall, translateText, transcribeAndTranslateAudio, analyzeImage, draftReport, generateSpeech, checkLiveness }).map(([k, f]) => [k, tracked(k, f)]));
