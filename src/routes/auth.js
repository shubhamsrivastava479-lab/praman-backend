const express = require('express');
const { db, uid } = require('../db');
const { hashPassword, comparePassword, signToken } = require('../services/auth');
const { requireAuth } = require('../middleware/auth');
const totp = require('../services/totp');
const audit = require('../services/audit');

const router = express.Router();

// Self-service signup now happens only through Google (vendor-access.html),
// where firm details are collected and the Super Admin approves each vendor.
router.post('/signup', (req, res) => {
  res.status(410).json({ error: 'New vendors sign up with Google at /vendor-access.html' });
});

router.post('/login', async (req, res) => {
  const { email, password, code } = req.body;
  await db.read();
  const user = db.data.users.find(u => u.email.toLowerCase() === (email || '').toLowerCase());
  if (!user || !(await comparePassword(password || '', user.passwordHash))) {
    audit.log('anonymous', 'login_failed', String(email || '').slice(0, 120), user && (user.parentVendorId || user.id));
    await db.write().catch(() => {});
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (user.totpEnabled) {
    const lock = twoFaLock(user.id);
    if (lock) return res.status(429).json({ needCode: true, error: 'Too many wrong codes. Please wait ' + lock + ' minutes and try again.' });
    if (!code) return res.status(401).json({ needCode: true, error: 'Enter the 6-digit code from your authenticator app.' });
    if (!totp.verify(user.totpSecret, code)) {
      twoFaFail(user.id);
      audit.log(user, 'login_failed', 'wrong two-step code', user.parentVendorId || user.id);
      await db.write().catch(() => {});
      return res.status(401).json({ needCode: true, error: 'That code is not correct. Try the newest code.' });
    }
    twoFaOk(user.id);
  }

  // Approval gate: a vendor_admin must be approved; an agent's whole company
  // must be approved (their parent vendor_admin's status governs them).
  if (user.role === 'vendor_admin' && user.approved === false) {
    return res.status(403).json({ error: user.status === 'suspended' ? 'Your account is suspended. Contact the platform admin.' : 'Your account is pending approval by a platform admin.' });
  }
  if (require('../services/roles').isTeam(user.role)) {
    const parent = db.data.users.find(u => u.id === user.parentVendorId);
    if (!parent || parent.approved === false) {
      return res.status(403).json({ error: 'Your company account is pending approval by a platform admin.' });
    }
  }

  const vendorRootId = require('../services/roles').isTeam(user.role) ? user.parentVendorId : user.id;
  const token = signToken({ ...user, vendorRootId });
  audit.log({ ...user, vendorRootId }, 'login', user.totpEnabled ? 'with two-step code' : '');
  await db.write().catch(() => {});
  res.json({ token, user: { id: user.id, email: user.email, vendorName: user.vendorName, role: user.role || 'vendor_admin' } });
});

// ---------- Two-step login (optional, per person) ----------
const fails = new Map(); // userId -> { n, until }
const twoFaLock = id => { const f = fails.get(id); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; };
const twoFaFail = id => { const f = fails.get(id) || { n: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 10 * 60000; f.n = 0; } fails.set(id, f); };
const twoFaOk = id => fails.delete(id);

router.get('/2fa', requireAuth, async (req, res) => {
  await db.read();
  const me = db.data.users.find(u => u.id === req.user.id);
  res.json({ enabled: !!(me && me.totpEnabled) });
});
router.post('/2fa/setup', requireAuth, async (req, res) => {
  await db.read();
  const me = db.data.users.find(u => u.id === req.user.id);
  if (!me) return res.status(404).json({ error: 'Account not found' });
  if (me.totpEnabled) return res.status(409).json({ error: 'Two-step login is already on.' });
  me.totpPending = totp.newSecret();
  await db.write();
  res.json({ secret: me.totpPending, otpauth: totp.otpauthUrl(me.totpPending, me.email) });
});
router.post('/2fa/enable', requireAuth, async (req, res) => {
  await db.read();
  const me = db.data.users.find(u => u.id === req.user.id);
  if (!me || !me.totpPending) return res.status(400).json({ error: 'Start the setup first.' });
  if (!totp.verify(me.totpPending, req.body && req.body.code)) return res.status(400).json({ error: 'That code is not correct. Check the code in your app and try again.' });
  me.totpSecret = me.totpPending; me.totpPending = undefined; me.totpEnabled = true;
  audit.log(req.user, '2fa_enabled', me.email);
  await db.write();
  res.json({ ok: true });
});
router.post('/2fa/disable', requireAuth, async (req, res) => {
  await db.read();
  const me = db.data.users.find(u => u.id === req.user.id);
  if (!me || !me.totpEnabled) return res.json({ ok: true });
  const b = req.body || {};
  if (!(await comparePassword(b.password || '', me.passwordHash)) || !totp.verify(me.totpSecret, b.code)) return res.status(400).json({ error: 'Password or code is not correct.' });
  me.totpEnabled = false; me.totpSecret = undefined;
  audit.log(req.user, '2fa_disabled', me.email);
  await db.write();
  res.json({ ok: true });
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

// ---------- Vendor: Sign in / sign up with Google (+ firm details, Super Admin approval) ----------
const jwtLib = require('jsonwebtoken');

async function verifyGoogleIdToken(credential) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  const info = await r.json();
  if (!r.ok || info.error_description || info.error) throw new Error('verify');
  if (info.aud !== googleClientId()) throw new Error('verify');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(info.iss)) throw new Error('verify');
  if (String(info.email_verified) !== 'true') throw new Error('unverified');
  if (Number(info.exp) * 1000 < Date.now()) throw new Error('expired');
  return { email: String(info.email || '').toLowerCase(), name: info.name || '' };
}

function rateLimit(map, ip, max) {
  const now = Date.now();
  const rec = map.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 15 * 60 * 1000; }
  rec.count++; map.set(ip, rec);
  return rec.count > max;
}

const vendorGoogleAttempts = new Map();
router.post('/vendor-google-login', async (req, res) => {
  if (rateLimit(vendorGoogleAttempts, req.ip || 'x', 40)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Missing Google credential.' });
  let g;
  try { g = await verifyGoogleIdToken(credential); }
  catch (e) {
    if (e.message === 'unverified') return res.status(401).json({ error: 'Your Google email is not verified.' });
    if (e.message === 'expired') return res.status(401).json({ error: 'Google sign-in expired. Try again.' });
    if (e.message === 'verify') return res.status(401).json({ error: 'Google sign-in could not be verified.' });
    return res.status(502).json({ error: 'Could not reach Google. Try again.' });
  }
  if (g.email === googleAdminEmail()) {
    return res.status(403).json({ error: 'This account is for platform access. Use the platform access page.' });
  }

  await db.read();
  const user = db.data.users.find(u => u.email.toLowerCase() === g.email && u.role !== 'super_admin');
  if (!user) {
    // New vendor: give a short-lived onboarding token; the firm details form uses it.
    const onboardToken = jwtLib.sign({ purpose: 'vendor_onboard', email: g.email, name: g.name }, process.env.JWT_SECRET, { expiresIn: '30m' });
    return res.json({ status: 'new', email: g.email, name: g.name, onboardToken });
  }
  if (user.totpEnabled) return res.status(403).json({ error: 'This account uses two-step login. Please log in with your email, password and authenticator code.' });
  if (user.role === 'vendor_admin' && user.approved === false) {
    return res.json({ status: user.status === 'suspended' ? 'suspended' : 'pending', firmName: user.vendorName });
  }
  if (require('../services/roles').isTeam(user.role)) {
    const parent = db.data.users.find(u => u.id === user.parentVendorId);
    if (!parent || parent.approved === false) return res.json({ status: 'pending', firmName: parent ? parent.vendorName : '' });
  }
  const vendorRootId = require('../services/roles').isTeam(user.role) ? user.parentVendorId : user.id;
  const token = signToken({ ...user, vendorRootId });
  res.json({ status: 'ok', token, user: { id: user.id, email: user.email, vendorName: user.vendorName, role: user.role || 'vendor_admin' } });
});

const GST_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const clean = (v, max = 300) => String(v || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

const vendorRegAttempts = new Map();
router.post('/vendor-register', async (req, res) => {
  if (rateLimit(vendorRegAttempts, req.ip || 'x', 15)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const b = req.body || {};
  let ob;
  try {
    ob = jwtLib.verify(b.onboardToken || '', process.env.JWT_SECRET);
    if (ob.purpose !== 'vendor_onboard') throw new Error('x');
  } catch { return res.status(401).json({ error: 'Your sign-in expired. Please sign in with Google again.' }); }

  const firmName = clean(b.firmName, 120);
  const contactName = clean(b.contactName, 80);
  const contactEmail = clean(b.contactEmail, 120).toLowerCase();
  const mobile = String(b.mobile || '').replace(/[\s\-+]/g, '').replace(/^91(?=\d{10}$)/, '');
  const gst = clean(b.gst, 20).toUpperCase();
  const pan = clean(b.pan, 12).toUpperCase();
  const address = clean(b.address, 400);
  const city = clean(b.city, 80);
  const state = clean(b.state, 80);
  const pincode = String(b.pincode || '').trim();

  if (firmName.length < 2) return res.status(400).json({ error: 'Firm name is required.' });
  if (!/^[6-9]\d{9}$/.test(mobile)) return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) return res.status(400).json({ error: 'Enter a valid contact email.' });
  if (!pan || !PAN_RE.test(pan)) return res.status(400).json({ error: 'Enter a valid PAN (like ABCDE1234F).' });
  if (gst && !GST_RE.test(gst)) return res.status(400).json({ error: 'GST number format is not valid (15 characters).' });
  if (gst && gst.slice(2, 12) !== pan) return res.status(400).json({ error: 'GST number does not match the PAN entered.' });
  if (address.length < 10) return res.status(400).json({ error: 'Enter the full address.' });
  if (!/^\d{6}$/.test(pincode)) return res.status(400).json({ error: 'Enter a valid 6-digit pincode.' });
  const { SERVICES } = require('../services/plans');
  const requestedServices = [...new Set((Array.isArray(b.services) ? b.services : []).filter(x => SERVICES[x]))];
  if (!requestedServices.length) return res.status(400).json({ error: 'Choose at least one service.' });

  await db.read();
  if (db.data.users.find(u => u.email.toLowerCase() === ob.email)) {
    return res.status(409).json({ error: 'This Google account is already registered. Sign in instead.' });
  }
  if (db.data.users.find(u => u.role === 'vendor_admin' && u.profile && u.profile.pan === pan)) {
    return res.status(409).json({ error: 'A firm with this PAN is already registered. Contact the platform admin.' });
  }

  const user = {
    id: uid('user'),
    email: ob.email,
    vendorName: firmName,
    role: 'vendor_admin',
    parentVendorId: null,
    approved: false,
    status: 'pending',
    signupMethod: 'google',
    profile: { firmName, contactName: contactName || ob.name || '', contactEmail, mobile, gst: gst || null, pan, address, city, state, pincode, submittedAt: new Date().toISOString() },
    requestedServices,
    passwordHash: await hashPassword(require('crypto').randomBytes(24).toString('hex')),
    createdAt: new Date().toISOString()
  };
  db.data.users.push(user);
  await db.write();
  res.status(201).json({ status: 'pending', message: 'Request submitted. You can sign in once the platform admin approves it.' });
});

// Public list of services, for the vendor sign-up form (no prices).
router.get('/services-catalog', (req, res) => {
  const { SERVICES, ALL } = require('../services/plans');
  res.json(ALL.map(k => ({ key: k, label: SERVICES[k].label, short: SERVICES[k].short, icon: SERVICES[k].icon, about: SERVICES[k].about })));
});

// ---------- Who am I + which services my firm has bought ----------
router.get('/me', requireAuth, async (req, res) => {
  const plans = require('../services/plans');
  await db.read();
  const me = db.data.users.find(u => u.id === req.user.id);
  if (!me) return res.status(401).json({ error: 'Session expired, please log in again' });
  const firm = plans.firmOf(db.data, req.user);
  const keys = plans.allowedServices(db.data, req.user);
  res.json({
    user: { id: me.id, email: me.email, role: me.role || 'vendor_admin', name: me.agentName || me.profile?.contactName || '', vendorName: firm ? firm.vendorName : me.vendorName },
    services: plans.publicList(keys, require('../services/roles').isTeam(req.user.role) ? null : (firm && firm.servicePrices))
  });
});

// ---------- Agent accounts (created by a vendor_admin, for concurrent calls) ----------

router.get('/agents', requireAuth, async (req, res) => {
  if (require('../services/roles').isTeam(req.user.role)) return res.status(403).json({ error: 'Only the company admin account can manage team members' });
  await db.read();
  const agents = db.data.users
    .filter(u => require('../services/roles').isTeam(u.role) && u.parentVendorId === req.user.id)
    .map(a => ({ id: a.id, email: a.email, name: a.agentName, role: a.role, createdAt: a.createdAt }));
  res.json(agents);
});

router.post('/agents', requireAuth, async (req, res) => {
  if (require('../services/roles').isTeam(req.user.role)) return res.status(403).json({ error: 'Only the company admin account can create team members' });
  const { email, password, name } = req.body;
  const role = ['agent', 'viewer', 'insurer'].includes(req.body.role) ? req.body.role : 'agent';
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
    role,
    parentVendorId: req.user.id,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString()
  };
  db.data.users.push(agent);
  audit.log(req.user, 'team_added', `${email} as ${role}`);
  await db.write();
  res.status(201).json({ id: agent.id, email: agent.email, name: agent.agentName, role });
});

router.delete('/agents/:id', requireAuth, async (req, res) => {
  if (require('../services/roles').isTeam(req.user.role)) return res.status(403).json({ error: 'Only the company admin account can remove team members' });
  await db.read();
  const idx = db.data.users.findIndex(u => u.id === req.params.id && u.parentVendorId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Agent not found' });
  audit.log(req.user, 'team_removed', db.data.users[idx].email);
  db.data.users.splice(idx, 1);
  await db.write();
  res.json({ ok: true });
});

module.exports = router;
