// Website text: the instant checks we offer and one page per industry.
// Edit here, then run:  node scripts/build-site-pages.js
// (it rewrites public/industries/*.html, public/instant-checks.html, sitemap.xml, robots.txt and the
//  marked blocks of public/login.html). Never name the data provider on the website.

const SITE = 'https://pramanservices.space';

// Instant checks, grouped. Run with the person's consent; results are saved to the case.
const CHECKS = {
  identity: { icon: '🪪', name: 'Identity documents', items: [
    'PAN check: name, date of birth and Aadhaar link status',
    'Aadhaar through DigiLocker (masked number only)',
    'Voter ID check',
    'Driving licence check: validity and vehicle classes',
    'Passport check',
    'Read the details from a photo of the card: PAN, Aadhaar, Voter ID, licence, passport'] },
  face: { icon: '🙂', name: 'Face, liveness and deepfake', items: [
    'Face match between the selfie and the ID photo',
    'Liveness check from a selfie',
    'Deepfake check for photos',
    'Deepfake check for voice recordings'] },
  mobile: { icon: '📱', name: 'Mobile number and digital checks', items: [
    'Name linked to a mobile number',
    'PAN linked to a mobile number',
    'WhatsApp profile check (business or personal, profile photo)',
    'Digital footprint: online accounts linked to the number',
    'UPI ID linked to the number'] },
  vehicle: { icon: '🚗', name: 'Vehicle checks', items: [
    'RC details: owner, make, model, fuel, insurance and fitness',
    'Vehicle number from the chassis number',
    'Pending e-challans (traffic fines)',
    'FASTag status and history'] },
  employment: { icon: '💼', name: 'Employment and income checks', items: [
    'UAN from PAN or mobile number',
    'Employment history from EPFO: employer, joining and leaving dates',
    'Employer (establishment) check',
    'Read a salary slip: company, designation, pay'] },
  business: { icon: '🏢', name: 'Business checks', items: [
    'GST number details, and GST numbers held by a PAN',
    'Udyam (MSME) registration',
    'Company (CIN) and director (DIN) details',
    'TAN check',
    'FSSAI food licence check'] },
  bank: { icon: '🏦', name: 'Bank, payment and credit checks', items: [
    'Bank account holder name (penny drop)',
    'UPI ID holder name',
    'IFSC and branch details',
    'Read a cheque or bank statement',
    'Credit score, with the person’s consent'] },
  court: { icon: '⚖️', name: 'Court record check', items: [
    'Civil and criminal court records by name, father’s name and address'] },
  address: { icon: '📍', name: 'Address and location', items: [
    'Address to map location, and map location to address',
    'Distance between two places (DIGIPIN)',
    'Electricity bill details as address proof',
    'Live location and time on every call'] },
  esign: { icon: '✍️', name: 'Aadhaar eSign', items: [
    'Consent forms and declarations signed with Aadhaar OTP'] }
};

const STEPS = [
  ['Add the case', 'Enter it, upload many from Excel, or send it from your system through the API.'],
  ['Customer gets the link', 'One WhatsApp message with their name, the reason and the call link. No app to install.'],
  ['Call and instant checks', 'A video call (AI or executive) collects answers, photos and documents. ID, vehicle, bank or court checks run with consent.'],
  ['Report and sign-off', 'Everything comes together in one report. A person approves the final verdict.']
];

// One page per industry.  checks: keys of CHECKS, most useful first.
const PAGES = [
  { slug: 'insurance-claim-investigation', icon: '🛡️', nav: 'Claim investigation',
    title: 'Insurance Claim Investigation Software (Health, Motor, Death Claims) | Praman',
    h1: 'Insurance claim investigation, done on a video call',
    desc: 'Investigate health, motor and death claims faster with Praman: WhatsApp video calls, AI questions in Indian languages, RC, e-challan, PAN and court record checks, and a clear evidence report.',
    lead: 'Praman helps insurers, TPAs and investigation agencies check claims without a field visit for most cases. The claimant joins a recorded video call from a WhatsApp link, answers in their own language, shows documents and the site, and you get a report with every piece of evidence behind it.',
    uses: ['Health claims: hospital stay, treatment and bills', 'Motor claims: accident, vehicle damage, driver and garage', 'Death claims: nominee, cause and documents', 'Theft, fire, marine, crop and cattle claims', 'Travel, accident and gadget claims'],
    checks: ['vehicle', 'identity', 'face', 'court', 'bank', 'mobile', 'address'],
    faq: [
      ['Can a claim be investigated without a field visit?', 'Yes, for most cases. The claimant joins a recorded video call from a WhatsApp link. Location, time, photos, documents and answers are saved to the case. A field visit is added only when the case really needs it.'],
      ['Which checks help in a motor claim?', 'RC details of the vehicle, vehicle number from the chassis number, pending e-challans, FASTag history and the driving licence. These run in seconds and are saved with the case.'],
      ['Does the AI decide the claim?', 'No. The AI asks questions and raises flags. An investigator reviews the evidence and approves every final verdict.'],
      ['Which languages are supported?', 'The call can run in Hindi, English and other Indian languages. Answers are written down and translated into English for the report.']] },
  { slug: 'pivc-policy-verification', icon: '📝', nav: 'PIVC / PLVC',
    title: 'Digital PIVC and PLVC for Life, Term and Health Insurance | Praman',
    h1: 'Digital PIVC and PLVC for life, term and health policies',
    desc: 'Run pre-issuance (PIVC) and post-login (PLVC) verification calls with Praman: AI video calls in Indian languages, face and liveness checks, PAN check, income and mis-selling questions, and an audit-ready report.',
    lead: 'Before a policy is issued, Praman confirms that the customer is real, understands the policy and was not mis-sold. The customer joins a short video call from WhatsApp at a time that suits them. Answers, photos and consent are recorded for your audit file.',
    uses: ['Life and term insurance PIVC', 'Health insurance PIVC and medical disclosure', 'Post-login verification (PLVC)', 'Mis-selling checks: promised returns, cash payments, forged signatures', 'Income and occupation confirmation for high cover'],
    checks: ['identity', 'face', 'employment', 'bank', 'mobile', 'esign'],
    faq: [
      ['What does a PIVC call check?', 'Identity, date of birth and address, the premium and term the customer expects, health disclosure, income and occupation, nominee, and whether anyone promised guaranteed returns or asked for cash.'],
      ['Is the customer recorded with consent?', 'Yes. The customer is told the call is recorded and agrees before the camera, microphone and location are used.'],
      ['Can the call run without an executive?', 'Yes. An AI call asks the questions in the customer’s language. Unclear answers are flagged, and the customer can ask for a person at any time.'],
      ['How is a high-value policy handled?', 'Cases above your set value can be marked for a live video call with an executive in addition to the automated call.']] },
  { slug: 'loan-verification', icon: '🏦', nav: 'Loan verification',
    title: 'Borrower and Loan Verification for Banks, NBFCs and MFIs | Praman',
    h1: 'Borrower verification for banks, NBFCs and microfinance',
    desc: 'Verify borrowers on a video call with Praman: identity, live location for residence and business, employment from EPFO, GST and Udyam checks, bank account and UPI name match.',
    lead: 'Praman lets lenders check a borrower, their home and their business on a recorded video call, with live location and time. Instant checks confirm PAN, employment, GST or Udyam registration and the bank account before you disburse.',
    uses: ['Residence and business address checks with live location', 'Income and employment confirmation', 'Gold, vehicle, tractor and two-wheeler loans', 'Merchant and shop verification', 'Collections and address trace'],
    checks: ['identity', 'face', 'employment', 'business', 'bank', 'address', 'mobile'],
    faq: [
      ['Can residence verification be done on video?', 'Yes. The borrower shows the house and the area on a recorded video call. Live location and time are saved, and the distance from the stated address can be worked out.'],
      ['How is income confirmed?', 'Employment history from EPFO, employer checks, salary slip reading and the bank account holder name can all be added to the case.'],
      ['Is consent taken?', 'Yes. Checks run only with the person’s consent, and the consent is stored with the case.']] },
  { slug: 'employee-background-verification', icon: '👷', nav: 'Employee BGV',
    title: 'Employee Background Verification (BGV) on Video | Praman',
    h1: 'Employee background verification for white-collar and blue-collar hiring',
    desc: 'Run employee background checks with Praman: identity and face match, employment history from EPFO, court record check, address with live location, and candidate declarations signed with Aadhaar eSign.',
    lead: 'Praman checks a candidate’s identity, past jobs, address and records in days, not weeks. The candidate joins a short video call, confirms their details and signs the declaration. Instant checks add EPFO history and court records.',
    uses: ['White-collar and blue-collar hiring', 'Security guards, drivers and delivery staff', 'Gig partner onboarding', 'Contract and manpower agencies', 'Domestic help and caregivers'],
    checks: ['identity', 'face', 'employment', 'court', 'address', 'esign'],
    faq: [
      ['How are past jobs verified?', 'Employment history from EPFO shows employers with joining and leaving dates. It can be compared with what the candidate declared.'],
      ['Is a court record check included?', 'A civil and criminal court record search by name, father’s name and address can be added to the case.'],
      ['Can we verify many candidates at once?', 'Yes. Upload candidates from Excel, and each one gets a WhatsApp link to their own call.']] },
  { slug: 'tenant-verification', icon: '🏠', nav: 'Tenant verification',
    title: 'Tenant and PG Resident Verification | Praman',
    h1: 'Tenant, PG and co-living resident verification',
    desc: 'Verify tenants and PG residents with Praman: ID and face match, court record check, employment check and a recorded video call, all saved in one report.',
    lead: 'Owners, brokers and co-living operators use Praman to confirm who is moving in. The tenant joins a short video call, shows their ID and confirms their details. Court records and employment can be checked in the same case.',
    uses: ['Tenant verification for owners and brokers', 'PG, hostel and co-living residents', 'Owner and possession checks', 'Builder project site visits'],
    checks: ['identity', 'face', 'court', 'employment', 'mobile'],
    faq: [
      ['What does a tenant check include?', 'Identity document check, face match with the ID photo, a recorded video statement, and optional court record and employment checks.'],
      ['Does the tenant need an app?', 'No. They open a WhatsApp link in their phone browser.']] },
  { slug: 'vendor-due-diligence', icon: '📦', nav: 'Vendor due diligence',
    title: 'Vendor, Dealer and Merchant Due Diligence | Praman',
    h1: 'Vendor, dealer and merchant due diligence',
    desc: 'Check that a business is real before you trade with it: GST, Udyam, company and director details, bank account name match, court records and a live video tour of the premises with Praman.',
    lead: 'Before you onboard a supplier, dealer, franchise or seller, Praman confirms the business is real. A live video tour shows the premises with location and time, and instant checks confirm GST, Udyam, company, director and bank details.',
    uses: ['Supplier and factory audits on video', 'Dealer, distributor and franchise checks', 'E-commerce seller and payment merchant onboarding', 'Trade credit: is the business real', 'Godown and stock checks'],
    checks: ['business', 'bank', 'identity', 'court', 'address', 'face'],
    faq: [
      ['Which business records can be checked?', 'GST number details, GST numbers held by a PAN, Udyam (MSME) registration, company and director details, TAN and FSSAI licence.'],
      ['Can we see the premises?', 'Yes. The owner gives a live video tour. Location and time are recorded and photos are saved to the case.']] },
  { slug: 'vehicle-and-driver-verification', icon: '🚚', nav: 'Vehicle & driver',
    title: 'Vehicle and Driver Verification (RC, Challan, FASTag, DL) | Praman',
    h1: 'Vehicle and driver verification',
    desc: 'Check vehicles and drivers with Praman: RC details, vehicle number from chassis, pending e-challans, FASTag history, driving licence, face match and court records.',
    lead: 'Fleet owners, rental companies, used-vehicle marketplaces and insurers use Praman to check the vehicle and the person driving it. A video call shows the vehicle, number plate and chassis number, and instant checks confirm the records.',
    uses: ['Drivers for fleets, rentals and car sharing', 'Used vehicle inspection and sale', 'Motor insurance inspection before cover', 'Commercial vehicle onboarding'],
    checks: ['vehicle', 'identity', 'face', 'court'],
    faq: [
      ['What vehicle records can be checked?', 'RC details (owner, make, model, fuel, insurance, fitness), vehicle number from the chassis number, pending e-challans and FASTag status.'],
      ['Can the driver be checked too?', 'Yes. Driving licence check, face match with the licence photo, and a court record search.']] },
  { slug: 'hospital-and-tpa-verification', icon: '🏥', nav: 'Hospital & TPA',
    title: 'Hospital, Network and Patient Verification for TPAs | Praman',
    h1: 'Hospital, network and patient verification for insurers and TPAs',
    desc: 'Verify hospitals, network providers and patients with Praman: live video audits with location, GST and registration checks, patient identity and face match, and evidence-backed reports.',
    lead: 'Praman helps insurers and TPAs confirm that a hospital exists and works as declared, and that the patient is who they say they are. Live video audits record the location and time, and instant checks confirm business and identity details.',
    uses: ['Hospital existence and audit', 'Network empanelment checks', 'Patient identity checks during admission', 'Clinic and diagnostic centre audits'],
    checks: ['business', 'address', 'identity', 'face', 'bank'],
    faq: [
      ['How is a hospital audited remotely?', 'A staff member gives a live video tour of the reception, wards and equipment. Location and time are saved with every photo.'],
      ['Can the patient be verified?', 'Yes. The patient joins a short video call, shows their ID, and a face match and liveness check are run.']] }
];

// Questions for the home page (also sent to Google as FAQ data).
const HOME_FAQ = [
  ['What is Praman?', 'Praman is verification and investigation software by SatyaSakshi LLP for any industry that has to check a person, a business, an asset or a claim. The person joins a recorded video call from a WhatsApp link, and the result comes back as an evidence report with instant ID, vehicle, business, bank and court checks.'],
  ['Who uses Praman?', 'Banks, NBFCs and fintechs, insurers and TPAs, employers and HR firms, real estate and co-living operators, hospitals, marketplaces and e-commerce, fleet and mobility companies, businesses onboarding vendors and dealers, and government and welfare programmes.'],
  ['Does the customer need to install an app?', 'No. The customer opens a WhatsApp link in their phone browser. An Android app is available only when screen sharing is needed.'],
  ['Which instant checks are available?', 'PAN, Aadhaar through DigiLocker, Voter ID, driving licence, passport, face match and liveness, RC, e-challan, FASTag, EPFO employment history, GST, Udyam, company and director, bank account and UPI name, credit score with consent, and court records.'],
  ['Is personal data safe?', 'Checks run only with consent. Full Aadhaar numbers are never stored, each client sees only its own cases, every action is logged, and files are deleted after the period you set.']
];

// Industry cards on the home page: [icon, name, examples, page slug or '']
const INDUSTRIES = [
 ['🏦','Banks, NBFCs and microfinance',['Home and business address checks','Income and job confirmation','Gold, vehicle and tractor loans','Property inspection','Collections and address trace','Merchant and shop verification']],
 ['🛡️','Insurance',['Health and motor claims','Marine, fire and property claims','Crop and cattle claims','Death claim investigation','Travel and accident claims','Gadget and warranty claims','Agent and POSP onboarding','Verification before underwriting']],
 ['🏥','Hospitals and TPAs',['Hospital existence and audit','Network empanelment checks','Patient identity checks','Clinic and medical college audit','Clinical trial participants']],
 ['👷','Hiring and HR',['Blue-collar bulk hiring','Security, driver and delivery staff','Gig partner onboarding','Contract and manpower agencies','Domestic help and caregivers','Campus and fresher hiring','Franchise and dealer owners']],
 ['🏠','Real estate and rentals',['Tenant verification','PG, hostel and co-living residents','Owner and possession checks','Builder project site visits','Property broker checks']],
 ['🎓','Education',['Admission document checks','Scholarship beneficiary checks','Education loan student and institute checks','Overseas education consultants']],
 ['🏛️','Government and welfare',['Pension and subsidy beneficiaries','Self-help group and micro-enterprise checks','Land and ground verification','Surveys and field data collection']],
 ['⚖️','Legal and corporate',['Vendor and supplier due diligence','Dealer and distributor checks','Franchise audits','Video statements for legal matters','Recovery and asset verification']],
 ['📦','Business and trade',['Supplier factory audits on video','Importer and exporter checks','Trade credit: is the business real','Godown and stock checks','E-commerce seller onboarding']],
 ['📡','Telecom, utilities and mobility',['Customer and address verification','Electricity and gas connections','Driver checks for rental and fleet','Vehicle rental and car sharing']],
 ['🌐','Marketplaces and communities',['Seller and high-value item proof','Second-hand vehicle and electronics inspection','Matrimonial profile verification','NGO and crowdfunding beneficiaries','Freelancer verification']],
 ['📈','Investments and finance services',['Chit fund and co-operative members','Broker and advisor onboarding','Customer verification for investment platforms','Payment merchant onboarding']]
];
const IND_LINK = {
 "Banks, NBFCs and microfinance": "loan-verification",
 "Insurance": "insurance-claim-investigation",
 "Hospitals and TPAs": "hospital-and-tpa-verification",
 "Hiring and HR": "employee-background-verification",
 "Real estate and rentals": "tenant-verification",
 "Legal and corporate": "vendor-due-diligence",
 "Business and trade": "vendor-due-diligence",
 "Telecom, utilities and mobility": "vehicle-and-driver-verification"
};

module.exports = { SITE, CHECKS, STEPS, PAGES, HOME_FAQ, INDUSTRIES, IND_LINK };
