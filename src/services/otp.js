const wa = require('./whatsapp');

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

// Sends an OTP over WhatsApp using the SAME business number already
// connected to this case — no separate SMS/OTP provider needed.
//
// IMPORTANT LIMITATION: WhatsApp only allows free-form text messages within
// 24 hours of the recipient's last message to you. If this is the very
// first contact, send an approved OTP template instead (same mechanism as
// the case intake template — see sendTemplateMessage in whatsapp.js).
async function sendPhoneOtp(toNumber, waAccount) {
  const code = generateCode();
  await wa.sendTextMessage(
    toNumber,
    `Your Praman verification code is: ${code}\nDo not share this code with anyone.`,
    waAccount
  );
  return { code, expiresAt: Date.now() + 5 * 60 * 1000 }; // caller stores this and compares on verify
}

module.exports = { generateCode, sendPhoneOtp };
