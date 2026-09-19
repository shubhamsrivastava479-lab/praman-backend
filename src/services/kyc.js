const BASE_URL = 'https://api.gridlines.io';

// Gridlines uses X-API-Key + X-Auth-Type headers. Credentials are passed in
// per call (platform-level, from .env — see routes/kyc.js's getPlatformCreds()).
//
// NOTE: verify the exact endpoint paths against your Gridlines dashboard
// docs (docs.gridlines.io) before going live — Gridlines occasionally
// versions these paths, and the paths below follow their documented naming
// convention but should be double-checked against your account's API
// reference page once you're logged in there.

async function gridlinesRequest(path, body, { apiKey, authType = 'API-Key' }) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      'X-Auth-Type': authType
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Gridlines API error ${res.status}`);
  }
  return data;
}

// Driving Licence verification — instant, no OTP needed.
async function verifyDrivingLicence(dlNumber, dateOfBirth, credentials) {
  return gridlinesRequest(
    '/dl-api/fetch',
    { driving_license_number: dlNumber, date_of_birth: dateOfBirth },
    credentials
  );
}

// Aadhaar verification is consent + OTP based: step 1 sends an OTP to the
// mobile number linked to that Aadhaar; step 2 verifies the OTP and returns
// the demographic details.
async function generateAadhaarOtp(aadhaarNumber, credentials) {
  return gridlinesRequest(
    '/aadhaar-api/otp/generate',
    { aadhaar_number: aadhaarNumber, consent: 'Y', consent_text: 'Consent given for KYC verification' },
    credentials
  );
}

async function verifyAadhaarOtp(referenceId, otp, credentials) {
  return gridlinesRequest(
    '/aadhaar-api/otp/verify',
    { reference_id: referenceId, otp },
    credentials
  );
}

// PAN verification — instant, name + DOB must match official records.
// dateOfBirth expected as DD/MM/YYYY per Gridlines' documented format.
async function verifyPan(panNumber, nameOnPan, dateOfBirth, credentials) {
  return gridlinesRequest(
    '/pan-api/fetch',
    { pan_number: panNumber, name_as_per_pan: nameOnPan, date_of_birth: dateOfBirth, consent: 'Y' },
    credentials
  );
}

module.exports = { verifyDrivingLicence, generateAadhaarOtp, verifyAadhaarOtp, verifyPan };
