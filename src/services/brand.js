// Praman's own logo files (public/logo*.png), read once, for the PDFs.
const fs = require('fs');
const path = require('path');
const cache = {};
function logo(name = 'logo-compact') {
  if (cache[name] === undefined) {
    try { cache[name] = fs.readFileSync(path.join(__dirname, '..', '..', 'public', name + '.png')); } catch { cache[name] = null; }
  }
  return cache[name];
}
module.exports = { logo, NAVY: '#04345a', ORANGE: '#e15603', GREEN: '#157e46', TAGLINE: 'Truth revealed, trust restored' };
