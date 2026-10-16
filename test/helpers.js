// Shared by the tests: a throw-away data folder, so tests never touch real data.
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.PRAMAN_TEST = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-for-production';
process.env.DATABASE_URL = '';
process.env.PRAMAN_DATA_DIR = process.env.PRAMAN_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'praman-test-'));
process.env.ALLOW_HTTP_WEBHOOKS = '1';
process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
module.exports = {};
