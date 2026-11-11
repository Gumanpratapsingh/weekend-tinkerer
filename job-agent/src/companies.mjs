// Well-known employers, so the apply queue can go to them first (config.company_focus, src/apply.mjs). All confirmed interview invites up to
// 2026-11-03 came from companies like these (3 of 129 applications, against 0 of 795 elsewhere). Add more per person in company_focus.top.
import { getKv } from './db.mjs';
const clean = (s) => ` ${String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()} `;

// Distinctive names: matched as whole words anywhere in the company name.
const NAMES = ['Accenture', 'Capgemini', 'Cognizant', 'Infosys', 'Tata Consultancy', 'Wipro', 'HCLTech', 'HCL Technologies', 'Tech Mahindra', 'LTIMindtree',
  'Mphasis', 'Thoughtworks', 'Publicis Sapient', 'Virtusa', 'Hexaware', 'Coforge', 'NTT DATA', 'EPAM', 'Globant', 'Zensar', 'Sopra Steria', 'Nagarro', 'Genpact', 'CGI',
  'Deloitte', 'KPMG', 'PwC', 'PricewaterhouseCoopers', 'Ernst & Young', 'McKinsey', 'Boston Consulting', 'Bain & Company', 'Gartner', 'Mercer', 'Marsh McLennan',
  'Microsoft', 'Google', 'Amazon', 'Netflix', 'Adobe', 'Salesforce', 'Oracle', 'IBM', 'Intel', 'NVIDIA', 'Cisco', 'VMware', 'Broadcom', 'Qualcomm', 'Samsung', 'Hewlett Packard', 'Atlassian',
  'ServiceNow', 'Intuit', 'Autodesk', 'Workday', 'Ericsson', 'Nokia', 'Thomson Reuters', 'Siemens', 'Bosch', 'Honeywell', 'Philips', 'Schneider Electric', 'GE Vernova', 'GE Healthcare', 'TE Connectivity',
  'SAP Labs', 'SAP India', 'Uber', 'LinkedIn', 'Expedia', 'Booking Holdings', 'Agoda', 'Airbnb', 'Walmart', 'Tesco', "Lowe's", 'Unilever', 'Nestle', 'Maersk', 'FedEx', 'Icertis', 'Postman', 'BrowserStack', 'Freshworks', 'Zoho',
  'Goldman Sachs', 'Morgan Stanley', 'JPMorgan', 'JPMorganChase', 'J.P. Morgan', 'Citibank', 'Citicorp', 'Barclays', 'Wells Fargo', 'HSBC', 'Deutsche Bank', 'Bank of America', 'Standard Chartered', 'BlackRock', 'State Street',
  'Northern Trust', 'Nomura', 'NatWest', 'Lloyds', 'Societe Generale', 'BNP Paribas', 'Synchrony', 'American Express', 'Mastercard', 'PayPal', 'Fiserv', 'Broadridge', 'Synechron', 'Fidelity', 'LSEG', 'S&P Global', "Moody's", 'Equifax', 'TransUnion',
  'Optum', 'UnitedHealth', 'Elevance Health', 'Evernorth', 'Flipkart', 'Myntra', 'Swiggy', 'Zomato', 'Eternal Limited', 'PhonePe', 'Razorpay', 'Paytm', 'Meesho', 'Nykaa', 'Zerodha', 'Groww', 'MakeMyTrip', 'Airtel', 'Reliance', 'Maruti Suzuki',
  'OpenAI', 'GitLab', 'MongoDB', 'Twilio', 'Okta', 'Coinbase', 'Samsara', 'HighRadius', 'Morningstar', 'Cargill', 'Amgen', 'Birlasoft', 'Luxoft', 'Info Edge', 'Rupeek', 'Kapiva', 'ValueLabs', 'Teleperformance'];
// Short or everyday words ("Meta Infotech", "Target Staffing" are other firms): only the name itself, plus legal words.
const SHORT = ['TCS', 'HCL', 'EY', 'HP', 'HPE', 'Meta', 'Apple', 'AWS', 'SAP', 'Dell', 'Dell Technologies', 'Citi', 'UBS', 'BNY', 'BNY Mellon', 'Visa', 'Target', 'FIS', 'ABB', 'Shell', 'BP', 'DHL', 'UPS', 'Bain', 'Stripe', 'Persistent Systems', 'Cred', 'TP', 'UST', 'EXL', 'EXL Service', 'Turing'];
// Local firms whose name contains a big one.
const NOT = ['Apex Infosys'].map(clean);
const LEGAL = /\b(india|global|group|inc|incorporated|corp|corporation|company|co|pvt|private|ltd|limited|llp|plc|gds|gcc)\b/g;
const WORDS = NAMES.map(clean);
const WHOLE = new Set(SHORT.map((s) => clean(s).trim()));

// Companies the owner approved in Cupboard (src/topcompanies.mjs), kept in the agent's own db so they survive deploys.
let approvedRaw = '', approved = [];
export function approvedCompanies() {
  const raw = getKv('top_extra', '[]');
  if (raw !== approvedRaw) { approvedRaw = raw; try { approved = JSON.parse(raw).map(clean); } catch { approved = []; } }
  return approved;
}

export function isTopCompany(company, extra = []) {
  const c = clean(company);
  if (NOT.some((w) => c.includes(w))) return false;
  return WORDS.some((w) => c.includes(w)) || WHOLE.has(c.replace(LEGAL, ' ').replace(/\s+/g, ' ').trim()) || extra.some((w) => c.includes(clean(w))) || approvedCompanies().some((w) => c.includes(w));
}

// One key for the spellings of a company: "Optum", "Optum India", "Optum Global Solutions (India) Private Limited".
const FILLER = /\b(india|global|group|inc|incorporated|corp|corporation|company|co|pvt|private|ltd|limited|llp|plc|solutions?|services?|technolog(y|ies)|tech|software|labs?|it|the|in)\b/g;
const ALIAS = { tcs: 'tata consultancy', aws: 'amazon', hcltech: 'hcl', 'hcl technologies': 'hcl', jpmorganchase: 'jpmorgan', 'jpmorgan chase': 'jpmorgan', 'j p morgan': 'jpmorgan', ey: 'ernst and young', pricewaterhousecoopers: 'pwc', citibank: 'citi' };
export function companyKey(name) {
  const full = clean(name).trim(), key = full.replace(FILLER, ' ').replace(/\s+/g, ' ').trim() || full;
  return ALIAS[key] || key;
}

// For the Rules page.
export const TOP_COMPANIES = [...new Set([...NAMES, ...SHORT])].sort((a, b) => a.localeCompare(b));
