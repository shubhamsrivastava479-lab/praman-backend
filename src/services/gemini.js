const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_TTS_MODEL = 'gemini-3.1-flash-tts-preview'; // dedicated speech-generation model
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const { getSetting } = require('./platform-settings');

async function getApiKey() {
  const key = await getSetting('geminiApiKey', 'GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY is not set — configure it in Super Admin settings or .env');
  return key;
}

async function callGemini(parts, { jsonOutput = false } = {}) {
  const apiKey = await getApiKey();
  const url = `${BASE_URL}/${GEMINI_MODEL}:generateContent`;
  const body = {
    contents: [{ parts }],
    ...(jsonOutput ? { generationConfig: { responseMimeType: 'application/json' } } : {})
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  return text;
}

async function translateText(text, targetLang = 'English') {
  const prompt = `Translate the following text to ${targetLang}. Return only the translation, no preamble:\n\n"${text}"`;
  return (await callGemini([{ text: prompt }])).trim();
}

// Generates spoken audio for a piece of text using Gemini's native audio
// model. The model auto-detects the language of the input text, so to
// speak in a specific language, feed it text already in that language
// (translateText() first, if needed) — see routes/participant.js "speak".
// Returns raw PCM audio (base64) + its mime type (e.g. "audio/L16;rate=24000").
async function generateSpeech(text, voiceName = 'Kore') {
  const apiKey = await getApiKey();
  const url = `${BASE_URL}/${GEMINI_TTS_MODEL}:generateContent`;
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
    }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Gemini TTS error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const part = data?.candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data) throw new Error('Gemini TTS returned no audio');
  return { base64Audio: part.inlineData.data, mimeType: part.inlineData.mimeType || 'audio/L16;rate=24000' };
}

async function transcribeAndTranslateAudio(base64Audio, mimeType = 'audio/ogg') {
  const prompt = `Listen to this audio clip. Respond ONLY with JSON in this exact shape:
{"language": "<detected language name>", "original": "<transcription in the original language>", "english": "<English translation>"}`;
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

module.exports = { translateText, transcribeAndTranslateAudio, analyzeImage, draftReport, generateSpeech, checkLiveness };
