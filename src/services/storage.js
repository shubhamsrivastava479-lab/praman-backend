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
  fs.writeFileSync(path.join(mediaDir, filename), buffer);
  return `/media/${filename}`;
}

async function isS3Configured() {
  return !!(await getS3Config());
}

module.exports = { saveFile, isS3Configured, mediaDir };
