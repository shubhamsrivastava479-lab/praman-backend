// Gemini's TTS model returns raw PCM audio (no container/header), so
// browsers can't play it directly — this wraps it in a minimal 44-byte WAV
// header. Sample rate is parsed from the mime type Gemini returns
// (e.g. "audio/L16;rate=24000"), defaulting to 24000 Hz mono 16-bit if absent.
function pcmToWav(pcmBuffer, mimeType) {
  const rateMatch = /rate=(\d+)/.exec(mimeType || '');
  const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM format chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

module.exports = { pcmToWav };
