const { db } = require('../db');

// Checks the DB (Super Admin dashboard) first, falls back to .env. This lets
// the Super Admin rotate keys from the UI without needing a redeploy, while
// .env still works as the default/bootstrap source.
async function getSetting(dbKey, envVarName) {
  await db.read();
  const fromDb = db.data.platformSettings?.[dbKey];
  return fromDb || process.env[envVarName] || null;
}

module.exports = { getSetting };
