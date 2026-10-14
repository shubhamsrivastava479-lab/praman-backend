// Socket.IO signaling for the live executive <-> customer video call.
// A socket can only join a call room if it proves who it is:
//   customer  -> the case's live-call token
//   executive -> a valid dashboard login (JWT) for the vendor that owns the case
// Messages are only relayed inside the room the socket was admitted to.
const { db, uid } = require('../db');
const { verifyToken } = require('./auth');

function attach(io) {
  io.on('connection', socket => {
    socket.on('live-join', async ({ token, jwt } = {}, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        await db.read();
        const c = db.data.cases.find(x => x.liveCall && x.liveCall.token && x.liveCall.token === String(token || ''));
        if (!c) return reply({ error: 'This video call link is not valid.' });
        let role = 'customer', who = 'participant';
        if (jwt) {
          let user;
          try { user = verifyToken(jwt); } catch { return reply({ error: 'Please log in again.' }); }
          if (user.vendorRootId !== c.vendorId) return reply({ error: 'This case belongs to another firm.' });
          role = 'executive'; who = user.email || 'agent';
        }
        const room = 'live_' + c.liveCall.token;
        // one executive and one customer at a time: a new join replaces the old one
        const sockets = await io.in(room).fetchSockets();
        for (const s of sockets) if (s.data.liveRole === role && s.id !== socket.id) { s.emit('live-replaced'); s.leave(room); s.data.liveRoom = null; }
        socket.join(room);
        Object.assign(socket.data, { liveRoom: room, liveRole: role, liveCaseId: c.id, liveWho: who });
        const others = (await io.in(room).fetchSockets()).filter(s => s.id !== socket.id).map(s => s.data.liveRole);
        socket.to(room).emit('live-peer', { role, event: 'joined' });
        c.liveCall.lastJoin = c.liveCall.lastJoin || {};
        c.liveCall.lastJoin[role] = new Date().toISOString();
        db.data.custody.push({ id: uid('cust'), caseId: c.id, event: role === 'executive' ? `Executive ${who} joined the live video call` : 'Customer joined the live video call', actor: who, timestamp: new Date().toISOString() });
        await db.write();
        reply({ ok: true, role, peers: others });
      } catch (e) {
        console.error('live-join error:', e.message);
        reply({ error: 'Could not join the call. Please try again.' });
      }
    });

    const inRoom = () => socket.data.liveRoom;
    socket.on('live-signal', data => { if (inRoom()) socket.to(inRoom()).emit('live-signal', { data, from: socket.data.liveRole }); });
    // customer -> executive: latest location / camera facing / screen share state
    socket.on('live-state', state => { if (inRoom() && socket.data.liveRole === 'customer') socket.to(inRoom()).emit('live-state', state); });
    // executive -> customer: polite requests (switch to back camera, re-connect)
    socket.on('live-cmd', cmd => { if (inRoom() && socket.data.liveRole === 'executive') socket.to(inRoom()).emit('live-cmd', cmd); });

    const leave = async reason => {
      const room = inRoom();
      if (!room) return;
      socket.to(room).emit('live-peer', { role: socket.data.liveRole, event: 'left' });
      socket.leave(room);
      try {
        await db.read();
        db.data.custody.push({ id: uid('cust'), caseId: socket.data.liveCaseId, event: `${socket.data.liveRole === 'executive' ? 'Executive' : 'Customer'} left the live video call${reason ? ' (' + reason + ')' : ''}`, actor: socket.data.liveWho, timestamp: new Date().toISOString() });
        await db.write();
      } catch {}
      socket.data.liveRoom = null;
    };
    socket.on('live-leave', () => leave('ended the call'));
    socket.on('disconnect', () => leave('connection closed'));
  });
}

module.exports = { attach };
