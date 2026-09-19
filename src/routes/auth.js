const express = require('express');
const { db, uid } = require('../db');
const { hashPassword, comparePassword, signToken } = require('../services/auth');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/signup', async (req, res) => {
  const { email, password, vendorName } = req.body;
  if (!email || !password || !vendorName) {
    return res.status(400).json({ error: 'email, password and vendorName are required' });
  }
  await db.read();
  if (db.data.users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }
  const user = {
    id: uid('user'),
    email,
    vendorName,
    role: 'vendor_admin',
    parentVendorId: null,
    approved: false, // new vendors are pending until Super Admin approves them
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString()
  };
  db.data.users.push(user);
  await db.write();
  res.status(201).json({
    pending: true,
    message: 'Account created. A platform admin needs to approve it before you can log in.'
  });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  await db.read();
  const user = db.data.users.find(u => u.email.toLowerCase() === (email || '').toLowerCase());
  if (!user || !(await comparePassword(password || '', user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Approval gate: a vendor_admin must be approved; an agent's whole company
  // must be approved (their parent vendor_admin's status governs them).
  if (user.role === 'vendor_admin' && user.approved === false) {
    return res.status(403).json({ error: 'Your account is pending approval by a platform admin.' });
  }
  if (user.role === 'agent') {
    const parent = db.data.users.find(u => u.id === user.parentVendorId);
    if (!parent || parent.approved === false) {
      return res.status(403).json({ error: 'Your company account is pending approval by a platform admin.' });
    }
  }

  const vendorRootId = user.role === 'agent' ? user.parentVendorId : user.id;
  const token = signToken({ ...user, vendorRootId });
  res.json({ token, user: { id: user.id, email: user.email, vendorName: user.vendorName, role: user.role || 'vendor_admin' } });
});

// ---------- Super Admin bootstrap (one-time, platform operator only) ----------
// Creates the FIRST Super Admin account. Requires SUPER_ADMIN_SETUP_KEY from
// .env — a secret only the platform operator knows — and refuses if a Super
// Admin already exists, so this can't be used to create additional ones or
// be abused by a random visitor who finds the URL.
router.post('/bootstrap-super-admin', async (req, res) => {
  const { setupKey, email, password } = req.body;
  if (!process.env.SUPER_ADMIN_SETUP_KEY) {
    return res.status(400).json({ error: 'SUPER_ADMIN_SETUP_KEY is not configured on the server.' });
  }
  if (setupKey !== process.env.SUPER_ADMIN_SETUP_KEY) {
    return res.status(403).json({ error: 'Invalid setup key.' });
  }
  await db.read();
  if (db.data.users.find(u => u.role === 'super_admin')) {
    return res.status(409).json({ error: 'A Super Admin account already exists.' });
  }
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const admin = {
    id: uid('user'),
    email,
    vendorName: 'Platform',
    role: 'super_admin',
    parentVendorId: null,
    approved: true,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString()
  };
  db.data.users.push(admin);
  await db.write();
  const token = signToken({ ...admin, vendorRootId: admin.id });
  res.status(201).json({ token, user: { id: admin.id, email: admin.email, vendorName: admin.vendorName, role: admin.role } });
});

// ---------- Agent accounts (created by a vendor_admin, for concurrent calls) ----------

router.get('/agents', requireAuth, async (req, res) => {
  if (req.user.role === 'agent') return res.status(403).json({ error: 'Only the company admin account can manage agents' });
  await db.read();
  const agents = db.data.users
    .filter(u => u.role === 'agent' && u.parentVendorId === req.user.id)
    .map(a => ({ id: a.id, email: a.email, name: a.agentName, createdAt: a.createdAt }));
  res.json(agents);
});

router.post('/agents', requireAuth, async (req, res) => {
  if (req.user.role === 'agent') return res.status(403).json({ error: 'Only the company admin account can create agents' });
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name are required' });
  await db.read();
  if (db.data.users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }
  const agent = {
    id: uid('user'),
    email,
    vendorName: req.user.vendorName,
    agentName: name,
    role: 'agent',
    parentVendorId: req.user.id,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString()
  };
  db.data.users.push(agent);
  await db.write();
  res.status(201).json({ id: agent.id, email: agent.email, name: agent.agentName });
});

router.delete('/agents/:id', requireAuth, async (req, res) => {
  if (req.user.role === 'agent') return res.status(403).json({ error: 'Only the company admin account can remove agents' });
  await db.read();
  const idx = db.data.users.findIndex(u => u.id === req.params.id && u.parentVendorId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Agent not found' });
  db.data.users.splice(idx, 1);
  await db.write();
  res.json({ ok: true });
});

module.exports = router;
