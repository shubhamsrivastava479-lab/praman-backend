const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getSetting } = require('./platform-settings');

const mediaDir = path.join(__dirname, '..', '..', 'media');
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

// Reads S3/R2 config from the Super Admin dashboard (DB) first, falling
// back to .env — same pattern as the Gemini/Gridlines keys. Returns null if
// nothing is configured anywhere, meaning "use local disk".
async function getS3Config() {
  const endpoint = await getSetting('s3Endpoint', 'S3_ENDPOINT');
  const bucket = await getSetting('s3Bucket', 'S3_BUCKET');
  const accessKeyId = await getSetting('s3AccessKeyId', 'S3_ACCESS_KEY_ID');
  const secretAccessKey = await getSetting('s3SecretAccessKey', 'S3_SECRET_ACCESS_KEY');
  const region = (await getSetting('s3Region', 'S3_REGION')) || 'auto';
  const publicBaseUrl = await getSetting('s3PublicBaseUrl', 'S3_PUBLIC_BASE_URL');
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey, region, publicBaseUrl };
}

// Minimal S3-compatible PUT using SigV4 signing via the AWS-standard REST
// API — implemented with plain fetch + crypto so no AWS SDK dependency is
// required. Works with AWS S3, Cloudflare R2, and Backblaze B2 (S3-compat mode).
async function s3Put(key, buffer, contentType, cfg) {
  const { endpoint, bucket, accessKeyId, secretAccessKey, region } = cfg;
  const host = new URL(endpoint).host;
  const url = `${endpoint.replace(/\/$/, '')}/${bucket}/${key}`;

  const date = new Date();
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(buffer).digest('hex');

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', `/${bucket}/${key}`, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n');

  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: authHeader,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'Content-Type': contentType
    },
    body: buffer
  });
  if (!res.ok) throw new Error(`Object storage upload failed: ${res.status} ${await res.text()}`);

  return cfg.publicBaseUrl ? `${cfg.publicBaseUrl.replace(/\/$/, '')}/${key}` : url;
}

// Saves a buffer under a stable filename and returns a publicly reachable
// URL (relative /media/... for local disk, or absolute for S3/R2).
async function saveFile(buffer, filename, mimeType) {
  const cfg = await getS3Config();
  if (cfg) {
    return s3Put(filename, buffer, mimeType, cfg);
  }
  const dest = path.join(mediaDir, filename);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  return `/media/${filename}`;
}

// Large files (call recordings uploaded by an executive): streamed from a
// temp file on disk to storage, so a 500 MB video never sits in memory.
// Uses SigV4 with UNSIGNED-PAYLOAD (supported by AWS S3 and Cloudflare R2).
async function saveFileFromPath(filePath, filename, mimeType) {
  const cfg = await getS3Config();
  const size = fs.statSync(filePath).size;
  if (!cfg) {
    const dest = path.join(mediaDir, filename);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(filePath, dest);
    return `/media/${filename}`;
  }
  const { endpoint, bucket, accessKeyId, secretAccessKey, region } = cfg;
  const host = new URL(endpoint).host;
  const url = `${endpoint.replace(/\/$/, '')}/${bucket}/${filename}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', `/${bucket}/${filename}`, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, dateStamp), region), 's3'), 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash,
      'Content-Type': mimeType, 'Content-Length': String(size)
    },
    body: fs.createReadStream(filePath),
    duplex: 'half'
  });
  if (!res.ok) throw new Error(`Object storage upload failed: ${res.status} ${await res.text()}`);
  return cfg.publicBaseUrl ? `${cfg.publicBaseUrl.replace(/\/$/, '')}/${filename}` : url;
}

async function isS3Configured() {
  return !!(await getS3Config());
}


// ---- Private bucket access: time-limited signed download links (SigV4 query signing) ----
// Evidence stays private in the bucket; whenever the dashboard or a shared
// report is opened we hand out links that expire (default 1 hour).
const enc = v => encodeURIComponent(v).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function presignGet({ host, path: p, accessKeyId, secretAccessKey, region, expires = 3600, amzDate }) {
  amzDate = amzDate || new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const q = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host'
  };
  const canonicalQuery = Object.keys(q).sort().map(k => `${enc(k)}=${enc(q[k])}`).join('&');
  const canonicalRequest = ['GET', p, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, dateStamp), region), 's3'), 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');
  return { query: `${canonicalQuery}&X-Amz-Signature=${signature}`, signature };
}

// Turns a stored private-bucket URL into a signed, expiring one. Local /media
// paths and already-public URLs are returned unchanged.
async function signedUrl(fileUrl) {
  if (!fileUrl || fileUrl.startsWith('/')) return fileUrl;
  const cfg = await getS3Config();
  if (!cfg) return fileUrl;
  const prefix = `${cfg.endpoint.replace(/\/$/, '')}/${cfg.bucket}/`;
  if (!fileUrl.startsWith(prefix)) return fileUrl;
  const key = fileUrl.slice(prefix.length);
  const host = new URL(cfg.endpoint).host;
  const p = `/${cfg.bucket}/${key.split('/').map(enc).join('/')}`;
  const { query } = presignGet({ host, path: p, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region });
  return `${prefix}${key}?${query}`;
}

async function signEvidenceList(list) {
  const cfg = await getS3Config();
  if (!cfg) return list;
  return Promise.all(list.map(async e => (e.fileUrl ? { ...e, fileUrl: await signedUrl(e.fileUrl) } : e)));
}

// Signed S3/R2 request with no body hashing (UNSIGNED-PAYLOAD). Extra
// x-amz-* headers (e.g. x-amz-copy-source) are signed too.
async function s3Request(method, key, cfg, extra = {}) {
  const { endpoint, bucket, accessKeyId, secretAccessKey, region } = cfg;
  const host = new URL(endpoint).host;
  const uri = `/${bucket}/${key.split('/').map(enc).join('/')}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers = { host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate, ...extra };
  const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map(n => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, uri, '', canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, dateStamp), region), 's3'), 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');
  const { host: _h, ...send } = headers;
  return fetch(`${endpoint.replace(/\/$/, '')}${uri}`, { method, headers: { ...send, Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } });
}

// Moves a stored file to a new key (used when a document is moved to another
// case, so the file sits in that case's folder). Returns the new file URL.
async function moveFile(fileUrl, newKey) {
  if (!fileUrl) return fileUrl;
  if (fileUrl.startsWith('/media/')) {
    const src = path.join(mediaDir, fileUrl.slice('/media/'.length));
    const dst = path.join(mediaDir, newKey);
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.rename(src, dst);
    return `/media/${newKey}`;
  }
  const cfg = await getS3Config();
  if (!cfg) return fileUrl;
  const prefix = `${cfg.endpoint.replace(/\/$/, '')}/${cfg.bucket}/`;
  const pub = cfg.publicBaseUrl ? cfg.publicBaseUrl.replace(/\/$/, '') + '/' : null;
  const oldKey = fileUrl.startsWith(prefix) ? fileUrl.slice(prefix.length) : (pub && fileUrl.startsWith(pub) ? fileUrl.slice(pub.length) : null);
  if (!oldKey || oldKey === newKey) return fileUrl;
  const cp = await s3Request('PUT', newKey, cfg, { 'x-amz-copy-source': `/${cfg.bucket}/${oldKey.split('/').map(enc).join('/')}` });
  if (!cp.ok) throw new Error(`Storage copy failed: ${cp.status} ${await cp.text()}`);
  const del = await s3Request('DELETE', oldKey, cfg);
  if (!del.ok && del.status !== 404) console.warn('Old file not deleted after move:', del.status);
  return pub ? pub + newKey : prefix + newKey;
}

// Permanently deletes a stored file (data retention). Missing files count as deleted.
async function deleteFile(fileUrl) {
  if (!fileUrl) return false;
  if (fileUrl.startsWith('/media/')) {
    try { await fs.promises.unlink(path.join(mediaDir, fileUrl.slice('/media/'.length))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return true;
  }
  const cfg = await getS3Config();
  if (!cfg) throw new Error('Storage is not configured');
  const prefix = `${cfg.endpoint.replace(/\/$/, '')}/${cfg.bucket}/`;
  const pub = cfg.publicBaseUrl ? cfg.publicBaseUrl.replace(/\/$/, '') + '/' : null;
  const key = fileUrl.startsWith(prefix) ? fileUrl.slice(prefix.length) : (pub && fileUrl.startsWith(pub) ? fileUrl.slice(pub.length) : null);
  if (!key) throw new Error('File is not in the configured storage');
  const r = await s3Request('DELETE', key.split('?')[0], cfg);
  if (!r.ok && r.status !== 404) throw new Error(`Storage delete failed: ${r.status}`);
  return true;
}

// Reads a stored file back (backups, restore). Local /media paths and private-bucket URLs.
async function readFile(fileUrl) {
  if (!fileUrl) throw new Error('No file');
  if (fileUrl.startsWith('/media/')) return fs.promises.readFile(path.join(mediaDir, fileUrl.slice('/media/'.length)));
  const r = await fetch(await signedUrl(fileUrl), { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`Storage download failed: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { readFile, deleteFile, moveFile, saveFileFromPath, saveFile, isS3Configured, mediaDir, signedUrl, signEvidenceList, presignGet };
