require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const { init } = require('./db');
const casesRouter = require('./routes/cases');
const whatsappRouter = require('./routes/whatsapp');
const whatsappAccountsRouter = require('./routes/whatsapp-accounts');
const kycRouter = require('./routes/kyc');
const geminiRouter = require('./routes/gemini');
const authRouter = require('./routes/auth');
const publicRouter = require('./routes/public');
const participantRouter = require('./routes/participant');
const superAdminRouter = require('./routes/super-admin');
const analyticsRouter = require('./routes/analytics');
const gemini = require('./services/gemini');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(
  express.json({
    limit: '25mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

app.use('/api/auth', authRouter);
app.use('/api/whatsapp-accounts', whatsappAccountsRouter);
app.use('/api/kyc', kycRouter);
app.use('/api/cases', casesRouter);
app.use('/api/public', publicRouter);
app.use('/api/participant', participantRouter);
app.use('/api/super-admin', superAdminRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/webhooks/whatsapp', whatsappRouter);
app.use('/api/gemini', geminiRouter);

app.use('/media', express.static(path.join(__dirname, '..', 'media')));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

// Public ICE server config for WebRTC — combines the free STUN server with a
// TURN server if one is configured in .env (needed for participants behind
// restrictive corporate/mobile networks where direct peer-to-peer fails).
app.get('/api/turn-config', (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  res.json({ iceServers });
});

// WebRTC signaling + live captioning (self-hosted, no Twilio/Agora needed)
io.on('connection', socket => {
  socket.on('join-room', ({ roomId, role }) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = role;
    socket.to(roomId).emit('peer-joined', { role });
  });

  socket.on('signal', ({ roomId, data }) => {
    socket.to(roomId).emit('signal', { data, from: socket.data.role });
  });

  socket.on('screen-share-started', ({ roomId, caseId }) => {
    socket.to(roomId).emit('screen-share-started');
    logShareEvent(caseId, 'Screen share started (participant consent granted)');
  });
  socket.on('screen-share-stopped', ({ roomId, caseId }) => {
    socket.to(roomId).emit('screen-share-stopped');
    logShareEvent(caseId, 'Screen share stopped');
  });

  socket.on('audio-chunk', async ({ roomId, caseId, base64Audio, mimeType, speaker }) => {
    try {
      const result = await gemini.transcribeAndTranslateAudio(base64Audio, mimeType || 'audio/webm');
      io.to(roomId).emit('caption', { speaker, ...result, ts: Date.now() });
      if (caseId) saveTranscriptSegment(caseId, speaker, result);
    } catch (err) {
      console.warn('Live captioning failed:', err.message);
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.roomId) socket.to(socket.data.roomId).emit('peer-left', { role: socket.data.role });
  });
});

async function logShareEvent(caseId, event) {
  if (!caseId) return;
  const { db, uid } = require('./db');
  await db.read();
  db.data.custody.push({ id: uid('cust'), caseId, event, actor: 'call_session', timestamp: new Date().toISOString() });
  await db.write();
}

async function saveTranscriptSegment(caseId, speaker, result) {
  const { db, uid } = require('./db');
  await db.read();
  db.data.transcripts.push({
    id: uid('tr'),
    caseId,
    source: 'live_call',
    speaker,
    original: result.original,
    english: result.english,
    language: result.language,
    timestamp: new Date().toISOString()
  });
  await db.write();
}

const PORT = process.env.PORT || 3000;

init().then(() => {
  server.listen(PORT, () => {
    console.log(`Praman backend running on http://localhost:${PORT}`);
    console.log(`Shared WhatsApp webhook URL (same for every vendor):`);
    console.log(`  ${process.env.PUBLIC_BASE_URL || 'https://YOUR_DOMAIN'}/webhooks/whatsapp/webhook`);
  });
});
