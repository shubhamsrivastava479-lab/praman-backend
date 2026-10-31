// The Gridlines checks Praman can run. One entry per API, each with its OWN key (Gridlines gives a separate key per API).
//
// path / body below are the DEFAULTS. Paths and field names must match the Gridlines dashboard docs for the
// account, so Super Admin can change both without a new deploy (Super Admin > Gridlines checks).
// Entries marked confirmed:false are best guesses until Super Admin saves them once after checking the docs.
//
// inputs: what the person types (key = our name). body: what is sent, "{{key}}" is replaced by the typed value
// (a line with an empty value is left out).
const DOB = 'Date of birth as DD/MM/YYYY';
const VEH = /^[A-Z0-9]{6,12}$/;

const APIS = {
  pan: {
    label: 'PAN check', short: 'PAN', confirmed: true, path: '/pan-api/fetch',
    body: { pan_number: '{{panNumber}}', name_as_per_pan: '{{nameOnPan}}', date_of_birth: '{{dateOfBirth}}', consent: 'Y' },
    inputs: [
      { key: 'panNumber', label: 'PAN number', required: true, pattern: /^[A-Z]{5}\d{4}[A-Z]$/, hint: 'Like ABCDE1234F', id: true },
      { key: 'nameOnPan', label: 'Name on PAN', required: true },
      { key: 'dateOfBirth', label: 'Date of birth', required: true, hint: DOB }
    ]
  },
  dl: {
    label: 'Driving licence check', short: 'Driving licence', confirmed: true, path: '/dl-api/fetch',
    body: { driving_license_number: '{{dlNumber}}', date_of_birth: '{{dateOfBirth}}' },
    inputs: [
      { key: 'dlNumber', label: 'Driving licence number', required: true, pattern: /^[A-Z0-9][A-Z0-9 \-\/]{5,24}$/, id: true },
      { key: 'dateOfBirth', label: 'Date of birth', required: true, hint: DOB }
    ]
  },
  rc_detailed: {
    label: 'RC details (detailed)', short: 'RC details', confirmed: false, path: '/rc-api/fetch-detailed',
    body: { rc_number: '{{rcNumber}}', consent: 'Y' },
    inputs: [{ key: 'rcNumber', label: 'Vehicle registration number', required: true, pattern: VEH, hint: 'Like MH12AB1234, no spaces', id: true }]
  },
  chassis_rc: {
    label: 'Registration number from chassis', short: 'Chassis to RC', confirmed: false, path: '/rc-api/chassis-to-rc',
    body: { chassis_number: '{{chassisNumber}}', consent: 'Y' },
    inputs: [{ key: 'chassisNumber', label: 'Chassis number', required: true, pattern: /^[A-Z0-9]{8,25}$/, id: true }]
  },
  fastag: {
    label: 'FASTag details', short: 'FASTag', confirmed: false, path: '/fastag-api/fetch',
    body: { vehicle_number: '{{vehicleNumber}}', consent: 'Y' },
    inputs: [{ key: 'vehicleNumber', label: 'Vehicle registration number', required: true, pattern: VEH, hint: 'Like MH12AB1234, no spaces', id: true }]
  },
  echallan: {
    label: 'E-challan check', short: 'E-challan', confirmed: false, path: '/echallan-api/fetch',
    body: { vehicle_number: '{{vehicleNumber}}', chassis_number: '{{chassisNumber}}', engine_number: '{{engineNumber}}', consent: 'Y' },
    inputs: [
      { key: 'vehicleNumber', label: 'Vehicle registration number', required: true, pattern: VEH, hint: 'Like MH12AB1234, no spaces', id: true },
      { key: 'chassisNumber', label: 'Chassis number (last digits, if asked)', required: false, pattern: /^[A-Z0-9]{4,25}$/ },
      { key: 'engineNumber', label: 'Engine number (last digits, if asked)', required: false, pattern: /^[A-Z0-9]{4,25}$/ }
    ]
  },
  cibil: {
    label: 'Credit (CIBIL) score', short: 'CIBIL score', confirmed: false, path: '/cibil-api/fetch', needsConsent: true,
    body: { name: '{{fullName}}', date_of_birth: '{{dateOfBirth}}', mobile_number: '{{mobile}}', pan_number: '{{panNumber}}', pincode: '{{pincode}}', consent: 'Y' },
    inputs: [
      { key: 'fullName', label: 'Full name', required: true },
      { key: 'dateOfBirth', label: 'Date of birth', required: true, hint: DOB },
      { key: 'mobile', label: 'Mobile number', required: true, pattern: /^[6-9]\d{9}$/, hint: '10 digits', id: true },
      { key: 'panNumber', label: 'PAN number', required: false, pattern: /^[A-Z]{5}\d{4}[A-Z]$/, id: true },
      { key: 'pincode', label: 'Pincode', required: false, pattern: /^\d{6}$/ }
    ]
  },
  digital_footprint: {
    label: 'Digital footprint', short: 'Digital footprint', confirmed: false, path: '/digital-footprint-api/fetch',
    body: { phone_number: '{{mobile}}', email: '{{email}}', consent: 'Y' },
    inputs: [
      { key: 'mobile', label: 'Mobile number', required: true, pattern: /^[6-9]\d{9}$/, hint: '10 digits', id: true },
      { key: 'email', label: 'Email (optional)', required: false, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/ }
    ]
  }
};

// Price kinds in the wallet: the old Aadhaar steps plus every API above.
const EXTRA_KINDS = { aadhaar_generate: 'Aadhaar - send OTP', aadhaar_verify: 'Aadhaar - verify OTP' };
const KINDS = ['dl', 'aadhaar_generate', 'aadhaar_verify', 'pan', ...Object.keys(APIS).filter(k => !['dl', 'pan'].includes(k))];
const KIND_LABELS = { ...Object.fromEntries(Object.entries(APIS).map(([k, a]) => [k, a.label])), ...EXTRA_KINDS };

module.exports = { APIS, KINDS, KIND_LABELS };
