const path = require('path');
const fs = require('fs');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const file = path.join(dataDir, 'db.json');
const adapter = new JSONFile(file);
const defaultData = {
  users: [],
  whatsappAccounts: [],
  phoneOtps: [],
  cases: [],
  evidence: [],
  custody: [],
  callSessions: [],
  transcripts: [],
  reports: [],
  platformSettings: {} // Super Admin managed: geminiApiKey, gridlinesApiKey, gridlinesAuthType
};
const db = new Low(adapter, defaultData);

async function init() {
  await db.read();
  db.data ||= defaultData;
  for (const key of Object.keys(defaultData)) {
    if (!db.data[key]) db.data[key] = defaultData[key];
  }
  await db.write();
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { db, init, uid };
