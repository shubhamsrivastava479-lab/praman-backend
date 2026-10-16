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
const aiCallRouter = require('./routes/ai-call');
const gemini = require('./services/gemini');
const errlog = require('./services/errlog');
const scheduler = require('./services/scheduler');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(require('compression')({ threshold: 1024, filter: (req, res) => /\/api\/ai-call\/.*\/(turn|photo)/.test(req.path) ? false : require('compression').filter(req, res) }));
app.use(errlog.requestLogger);
app.use(
  express.json({
    limit: '25mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

const rolesGuard = require('./services/roles').guard;
app.use('/api', (req, res, next) => /^\/(public|ai-call|participant|super-admin|live|v1|gemini)\b/.test(req.path) ? next() : rolesGuard(req, res, next));
app.use('/api/auth', authRouter);
app.use('/api/whatsapp-accounts', whatsappAccountsRouter);
app.use('/api/kyc', kycRouter);
app.use('/api/cases', casesRouter);
app.use('/api/public', publicRouter);
app.use('/api/participant', participantRouter);
app.use('/api/super-admin', superAdminRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/ai-call', aiCallRouter);
app.use('/api/billing', require('./routes/billing'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/workflow', require('./routes/workflow'));
app.use('/api/integration', require('./routes/integration'));
app.use('/api/v1', require('./routes/api-v1'));
app.use('/webhooks/whatsapp', whatsappRouter);
app.use('/api/gemini', geminiRouter);
app.use('/f', require('./routes/files'));
app.use('/api/live', require('./routes/live'));

app.use('/media', express.static(path.join(__dirname, '..', 'media')));
// pages are revalidated (ETag) every time so a new deploy shows at once; images/fonts can be cached
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: 0, setHeaders: (res, f) => { if (/\.(png|jpe?g|svg|ico|woff2?)$/i.test(f)) res.setHeader('Cache-Control', 'public, max-age=86400'); } }));

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

require('./services/live-signaling').attach(io);

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

// Last in the chain: turns a route crash into a clean answer and writes it to the error log.
app.use(errlog.errorHandler);

const PORT = process.env.PORT || 3000;

function start(port = PORT) {
  if (process.env.PRAMAN_TEST !== '1') errlog.installProcessHandlers();
  return init().then(() => new Promise(resolve => {
    server.listen(port, () => {
      console.log(`Praman backend running on http://localhost:${port}`);
      console.log(`Shared WhatsApp webhook URL (same for every vendor):`);
      console.log(`  ${process.env.PUBLIC_BASE_URL || 'https://YOUR_DOMAIN'}/webhooks/whatsapp/webhook`);
      if (process.env.PRAMAN_TEST !== '1') { scheduler.start(); require('./services/mirror').schedule(require('./db').db); }
      resolve(server);
    });
  }));
}

if (require.main === module) start();

module.exports = { app, server, io, start };
