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

// ---------- Super Admin password reset (setup-key protected) ----------
const resetAttempts = new Map(); // ip -> {count, resetAt}
router.post('/reset-super-admin-password', async (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const rec = resetAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 15 * 60 * 1000; }
  rec.count++;
  resetAttempts.set(ip, rec);
  if (rec.count > 8) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });

  const { setupKey, email, newPassword } = req.body || {};
  if (!process.env.SUPER_ADMIN_SETUP_KEY) {
    return res.status(400).json({ error: 'SUPER_ADMIN_SETUP_KEY is not configured on the server.' });
  }
  if (!setupKey || setupKey !== process.env.SUPER_ADMIN_SETUP_KEY) {
    return res.status(403).json({ error: 'Invalid setup key.' });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  await db.read();
  const admins = db.data.users.filter(u => u.role === 'super_admin');
  if (!admins.length) return res.status(404).json({ error: 'No Super Admin exists yet. Use setup-super-admin.html instead.' });
  // Email is optional: if left blank, the (first) Super Admin is reset and its email is shown.
  const target = email
    ? admins.find(u => u.email.toLowerCase() === email.trim().toLowerCase())
    : admins[0];
  if (!target) return res.status(404).json({ error: 'No Super Admin with that email. Leave email blank to reset the existing one.' });

  target.passwordHash = await hashPassword(newPassword);
  await db.write();
  res.json({ ok: true, email: target.email });
});

// ---------- Super Admin: Sign in with Google ----------
// Only the Gmail set in SUPER_ADMIN_GOOGLE_EMAIL can get in this way.
const GOOGLE_CLIENT_ID_DEFAULT = '445649274332-of8rk67v62ckk78619bia87vumu17idl.apps.googleusercontent.com';
const googleClientId = () => process.env.GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID_DEFAULT;
const googleAdminEmail = () => (process.env.SUPER_ADMIN_GOOGLE_EMAIL || '').trim().replace(/^["']+|["']+$/g, '').trim().toLowerCase();

router.get('/google-config', (req, res) => res.json({ clientId: googleClientId() }));

const googleAttempts = new Map();
router.post('/google-login', async (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const rec = googleAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 15 * 60 * 1000; }
  rec.count++;
  googleAttempts.set(ip, rec);
  if (rec.count > 30) return res.status(429).json({ error: 'Too many attempts. Try again later.' });

  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Missing Google credential.' });
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
    const info = await r.json();
    if (!r.ok || info.error_description || info.error) {
      return res.status(401).json({ error: 'Google sign-in could not be verified.' });
    }
    if (info.aud !== googleClientId()) return res.status(401).json({ error: 'Google sign-in could not be verified.' });
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(info.iss)) {
      return res.status(401).json({ error: 'Google sign-in could not be verified.' });
    }
    if (String(info.email_verified) !== 'true') return res.status(401).json({ error: 'Google email is not verified.' });
    if (Number(info.exp) * 1000 < Date.now()) return res.status(401).json({ error: 'Google sign-in expired. Try again.' });
    const gmail = String(info.email || '').toLowerCase();
    if (!googleAdminEmail()) {
      return res.status(403).json({ error: 'Setup incomplete: SUPER_ADMIN_GOOGLE_EMAIL is empty or missing on the server (Render > Environment). Save it with "Save, rebuild, and deploy".' });
    }
    if (gmail !== googleAdminEmail()) {
      const want = googleAdminEmail();
      return res.status(403).json({ error: 'This Google account is not allowed to be Super Admin. You signed in as ' + gmail +
        '; the server expects an email starting "' + want.slice(0, 3) + '" with ' + want.length + ' characters (you: ' + gmail.length + ').' });
    }

    await db.read();
    let admin = db.data.users.find(u => u.role === 'super_admin' && u.email.toLowerCase() === gmail)
      || db.data.users.find(u => u.role === 'super_admin');
    if (!admin) {
      admin = {
        id: uid('user'), email: gmail, vendorName: 'Platform', role: 'super_admin',
        parentVendorId: null, approved: true,
        passwordHash: await hashPassword(require('crypto').randomBytes(24).toString('hex')),
        createdAt: new Date().toISOString()
      };
      db.data.users.push(admin);
      await db.write();
    }
    const token = signToken({ ...admin, vendorRootId: admin.id });
    res.json({ token, user: { id: admin.id, email: admin.email, vendorName: admin.vendorName, role: admin.role } });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach Google. Try again.' });
  }
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
