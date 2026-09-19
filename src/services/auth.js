const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

function getSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set in .env — add any long random string');
  }
  return process.env.JWT_SECRET;
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      vendorName: user.vendorName,
      role: user.role || 'vendor_admin',
      vendorRootId: user.vendorRootId || user.id // agents carry their parent vendor's id here
    },
    getSecret(),
    { expiresIn: '7d' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

module.exports = { hashPassword, comparePassword, signToken, verifyToken };
