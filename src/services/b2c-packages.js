// Packages of the SatyaSakshi Praman consumer app (B2C).
//   kind 'person'  : the person being checked gets a WhatsApp link, agrees and takes a short AI video call
//                    (ID photos, face + liveness, live location, questions). SatyaSakshi's team reviews it.
//   kind 'vehicle' : instant record checks on a vehicle number (no person involved).
//   self: true     : the buyer checks themself and gets a shareable "Praman Verified" certificate.
// Prices are set by the Super Admin (Super Admin > Consumer app). A package with no price cannot be bought,
// unless test mode is on.
const PACKAGES = {
  tenant: {
    name: 'Tenant check', short: 'Tenant', icon: 'home', kind: 'person', who: 'Your tenant or PG resident',
    tagline: 'Know who you are renting to',
    checks: ['ID card photos (Aadhaar and PAN)', 'Face match and liveness', 'Live location and current address', 'Work and income questions', 'Previous address and reason for moving', 'Self-declared police or court cases', 'Recorded video statement'],
    questions: [
      ['employment', 'occupation', 'What work do you do, and where? How long have you been doing it?'],
      ['employment', 'income', 'What is your approximate monthly income?'],
      ['address', 'previous_address', 'Where did you live before this, and why are you moving?'],
      ['custom', 'occupants', 'How many people will live with you, and how are they related to you?'],
      ['custom', 'purpose', 'For how long do you plan to rent this place?']
    ]
  },
  domestic: {
    name: 'Maid, cook, nanny or caregiver check', short: 'Domestic help', icon: 'users', kind: 'person', who: 'Your maid, cook, nanny or caregiver',
    tagline: 'Know who comes into your home',
    checks: ['ID card photos (Aadhaar and PAN)', 'Face match and liveness', 'Live location and home address', 'Past work and references', 'Self-declared police or court cases', 'Recorded video statement'],
    questions: [
      ['employment', 'past_work', 'In which homes or places have you worked before, and for how long?'],
      ['employment', 'leaving', 'Why did you leave your last work?'],
      ['address', 'native_place', 'What is your native place, and who lives there?']
    ]
  },
  driver: {
    name: 'Driver check', short: 'Driver', icon: 'car', kind: 'person', who: 'Your personal or office driver',
    tagline: 'Know who is behind the wheel',
    checks: ['ID card photos (Aadhaar and PAN)', 'Driving licence questions and photo', 'Face match and liveness', 'Live location and current address', 'Past driving jobs and accidents', 'Self-declared police or court cases'],
    questions: [
      ['employment', 'licence', 'What is your driving licence number, and which vehicles can you drive with it?'],
      ['employment', 'past_work', 'Where have you worked as a driver before, and for how long?'],
      ['custom', 'accidents', 'Have you ever been in an accident while driving? Please tell me what happened.'],
      ['custom', 'challans', 'Do you have any unpaid traffic challans?']
    ]
  },
  matrimonial: {
    name: 'Matrimonial check', short: 'Matrimonial', icon: 'heart', kind: 'person', who: 'A prospective bride or groom (with their consent)',
    tagline: 'Verify before you say yes',
    checks: ['ID card photos (Aadhaar and PAN)', 'Face match and liveness', 'Live location and address', 'Education, job and income questions', 'Earlier marriage declaration', 'Self-declared police or court cases'],
    questions: [
      ['education', 'qualification', 'What is your highest qualification, and from which college?'],
      ['employment', 'occupation', 'Where do you work, what is your designation, and since when?'],
      ['employment', 'income', 'What is your approximate yearly income?'],
      ['custom', 'marital', 'Have you been married or engaged before?'],
      ['custom', 'family', 'Please tell me briefly about your family: parents and siblings, and what they do.']
    ]
  },
  deal: {
    name: 'Buyer or seller check', short: 'Buyer / seller', icon: 'shop', kind: 'person', who: 'Someone you will pay or sell to online',
    tagline: 'Check before you pay a stranger',
    checks: ['ID card photos (Aadhaar and PAN)', 'Face match and liveness', 'Live location', 'Questions about the item or deal', 'Recorded video statement'],
    questions: [
      ['custom', 'item', 'What are you selling or buying, and since when do you own it?'],
      ['custom', 'proof', 'Do you have the bill or ownership papers for it?'],
      ['custom', 'payment', 'How do you want the payment, and in whose name is that account?']
    ]
  },
  vehicle: {
    name: 'Used vehicle check', short: 'Used vehicle', icon: 'car', kind: 'vehicle', who: 'A car or bike you plan to buy',
    tagline: 'Check the vehicle before you pay',
    checks: ['RC details: owner, model, fuel, insurance and fitness', 'Pending e-challans', 'FASTag status'],
    apis: ['rc_detailed', 'echallan', 'fastag'],
    inputs: [{ key: 'vehicleNumber', label: 'Vehicle number', placeholder: 'e.g. UP16AB1234' }]
  },
  self: {
    name: 'Praman Verified certificate', short: 'Verify myself', icon: 'badge', kind: 'person', self: true, who: 'You',
    tagline: 'Show landlords and clients you are genuine',
    checks: ['ID card photos (Aadhaar and PAN)', 'Face match and liveness', 'Live location and address', 'Work questions', 'A certificate link you can share, valid for 6 months'],
    questions: [
      ['employment', 'occupation', 'What work do you do, and where?'],
      ['address', 'previous_address', 'Where did you live before your current address?']
    ]
  }
};

// Questions every person check asks (the AI call adds name, ID photos, face, liveness and location itself).
const COMMON = [
  ['identity', 'dob', 'Please tell me your date of birth.'],
  ['identity', 'father_name', "What is your father's full name?"],
  ['address', 'current_address', 'What is your current address, and since when have you lived there?'],
  ['address', 'at_address', 'Are you at this address right now?'],
  ['address', 'permanent_address', 'What is your permanent address?']
];
const CLOSING = [
  ['declaration', 'criminal', 'Has any police case or court case ever been filed against you?'],
  ['references', 'reference', 'Please tell me the name and phone number of one person who knows you well.'],
  ['identity', 'age', 'To confirm, how old are you, in years?']
];
function questionsFor(pkgId) {
  const p = PACKAGES[pkgId];
  return [...COMMON, ...((p && p.questions) || []), ...CLOSING];
}

module.exports = { PACKAGES, questionsFor };
