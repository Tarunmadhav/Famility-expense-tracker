// First-run dataset, carried over from the original offline planner.
// Personal contact book entries are intentionally NOT bundled - use
// Settings > Import Google Contacts CSV to load your own address book.

export const SETTINGS = {
  mobile: '+91 8985800099',
  alertTime: '06:00',
  channel: 'Push + in-app',
  currency: 'INR',
  household: 'Gudipati Family',
};

export const FAMILY = [
  { name: 'Suneel Kumar Gudipati', relation: 'Self', role: 'Adult', mobile: '+91 8985800099', alt: '', email: 'gudipatiskumar19@gmail.com', bday: '', occupation: 'Corporate Affairs', ice: 'Yes', notes: 'Primary account holder' },
  { name: 'Padmasri Gudipati', relation: 'Spouse', role: 'Adult', mobile: '+91 9490100000', alt: '+91 7013003659', email: 'gudipatipadmasri@gmail.com', bday: '', occupation: 'Homemaker', ice: 'Yes', notes: 'Nominee on policies and loans' },
  { name: 'Madhu Gayatri Gudipati', relation: 'Daughter', role: 'Child', mobile: '+91 9493872469', alt: '', email: 'gudipati.madhugayatri@outlook.com', bday: '', occupation: 'Student', ice: 'No', notes: 'Dependent in health floater' },
  { name: 'Khushi Gudipati', relation: 'Daughter', role: 'Child', mobile: '+91 9490200000', alt: '', email: '', bday: '', occupation: 'Student', ice: 'No', notes: 'Dependent in health floater' },
  { name: 'Gudipati Koteswara Rao', relation: 'Father', role: 'Senior', mobile: '+91 8942231123', alt: '', email: '', bday: '', occupation: 'Retired', ice: 'Yes', notes: 'Covered by senior citizen top-up' },
  { name: 'Gudipati Vara Lakshmi', relation: 'Mother', role: 'Senior', mobile: '+91 6281222142', alt: '+91 8985461829', email: '', bday: '', occupation: 'Homemaker', ice: 'Yes', notes: 'Covered by senior citizen top-up' },
];

export const SUBSCRIPTIONS = [
  { service: 'Netflix', plan: 'Standard', category: 'Entertainment', amount: 499, cycle: 'Monthly', nextDue: '2026-11-08', method: 'Credit Card', account: 'gudipatiskumar19@gmail.com', status: 'Active', url: 'https://netflix.com', notes: 'Shared with family' },
  { service: 'Airtel Fiber', plan: '200 Mbps unlimited', category: 'Internet', amount: 1199, cycle: 'Monthly', nextDue: '2026-11-15', method: 'Auto-debit', account: 'Suneel', status: 'Active', url: 'https://airtel.in', notes: 'Broadband line' },
  { service: 'Amazon Prime', plan: 'Prime + Video', category: 'Shopping', amount: 1499, cycle: 'Yearly', nextDue: '2027-02-01', method: 'UPI', account: 'gudipatiskumar19@gmail.com', status: 'Active', url: 'https://amazon.in/prime', notes: 'Renews early next year' },
  { service: 'Google One', plan: '200 GB', category: 'Storage', amount: 210, cycle: 'Monthly', nextDue: '2026-11-21', method: 'Credit Card', account: 'gudipatiskumar19@gmail.com', status: 'Active', url: 'https://one.google.com', notes: 'Phone backups' },
  { service: 'Kids Tuition App', plan: 'Class 8 Maths', category: 'Education', amount: 2400, cycle: 'Quarterly', nextDue: '2026-12-05', method: 'UPI', account: 'Padmasri', status: 'Active', url: '', notes: 'Quarterly instalments' },
];

export const SEED = {
  family: FAMILY,
  subscriptions: SUBSCRIPTIONS,
  contacts: [
    { name: 'Suneel Kumar Gudipati', rel: 'Self', mobile: '+91 8985800099', alt: '', email: 'gudipatiskumar19@gmail.com', bday: '', org: 'Corporate Affairs, Adani Group - AP', module: 'Primary Profile / All Sheets', remarks: 'Account Holder & Primary Contact' },
    { name: 'Padmasri Gudipati', rel: 'Spouse / Family', mobile: '+91 9490100000', alt: '+91 7013003659', email: 'gudipatipadmasri@gmail.com', bday: '', org: 'Family / Co-Applicant', module: 'Insurance / Budget / Loans', remarks: 'Nominee & Co-signatory' },
    { name: 'Gudipati Madhu Gayatri', rel: 'Daughter', mobile: '+91 9493872469', alt: '', email: 'gudipati.madhugayatri@outlook.com', bday: '', org: '-', module: 'Contacts Directory', remarks: 'myContacts' },
    { name: 'Khushi Gudipati', rel: 'Daughter / Family', mobile: '+91 9490200000', alt: '', email: '', bday: '', org: 'Family Member', module: 'Insurance / Daily Diary', remarks: 'Dependent in Health Floater' },
    { name: 'Gudipati Koteswara Rao', rel: 'Father', mobile: '+91 8942231123', alt: '', email: '', bday: '', org: 'అల్లినగరం', module: 'Contacts Directory', remarks: 'myContacts' },
    { name: 'Gudipati Vara Lakshmi', rel: 'Mother', mobile: '+91 6281222142', alt: '+91 8985461829', email: '', bday: '', org: '-', module: 'Contacts Directory', remarks: 'ICE' },
    { name: 'SBI Relationship Manager (R. Sharma)', rel: 'Bank Manager (Mortgage)', mobile: '+91 9848011223', alt: '0866-2489000', email: 'rm.homeloan.sbi@sbi.co.in', bday: '', org: 'State Bank of India, Ring Road', module: 'Loans & Credit / Payments', remarks: 'Direct POC for Home Loan MCLR/Rate Reset' },
    { name: 'ICICI Car Loan Officer (K. Venkat)', rel: 'Auto Loan Executive', mobile: '+91 9849122334', alt: '1800-1080', email: 'venkat.k@icicibank.com', bday: '', org: 'ICICI Bank Auto Loans Dept', module: 'Loans & Credit / Payments', remarks: 'POC for Car Loan NOC & Pre-closure' },
    { name: 'HDFC Credit Card Desk', rel: 'Card Concierge', mobile: '+91 9966088888', alt: '1800-266-4332', email: 'prioritycards@hdfcbank.com', bday: '', org: 'HDFC Bank Cards Wing', module: 'Loans & Credit / Payments', remarks: 'Statement Queries & Limit Enhancements' },
    { name: 'Star Health Advisor (V. Rajesh)', rel: 'Insurance Advisor', mobile: '+91 9701234567', alt: '1800-425-2255', email: 'rajesh.insurance@starhealth.in', bday: '', org: 'Star Health Senior Agent', module: 'Insurance Register / Dashboard', remarks: 'Health Floater Policy Renewal & Claims' },
    { name: 'Bajaj Allianz Motor Agent (M. Prasad)', rel: 'Motor Insurance Desk', mobile: '+91 9989012345', alt: '1800-209-5858', email: 'prasad.motor@bajajallianz.co.in', bday: '', org: 'Bajaj Allianz General', module: 'Insurance Register / Dashboard', remarks: 'Car Insurance Zero-Dep Renewal & RSA' },
    { name: 'Fresh Produce & Milk Vendor (Suresh)', rel: 'Daily Vendor', mobile: '+91 9700887766', alt: '', email: '', bday: '', org: 'Daily Essentials Vendor', module: 'Daily Expenses', remarks: 'Fortnightly Settlement via UPI' },
    { name: 'Home Maintenance & AC Tech (Ramesh)', rel: 'Service Vendor', mobile: '+91 9866554433', alt: '', email: '', org: 'Local Smart Services', module: 'Daily Expenses / Diary', remarks: 'AC Servicing, Electrical, Plumbing' },
    { name: 'Society Treasurer (M. Srinivas)', rel: 'Housing', mobile: '+91 9848099881', alt: '', email: '', bday: '', org: 'Apartment Society', module: 'Payments', remarks: 'Maintenance collection' },
    { name: 'School Class Teacher (Mrs. Lakshmi)', rel: 'School', mobile: '+91 8662551122', alt: '', email: '', bday: '', org: 'Children School', module: 'Daily Diary', remarks: 'Academic progress POC' },
    { name: 'Family Physician (Dr. Rao)', rel: 'Doctor', mobile: '+91 9848119900', alt: '', email: '', bday: '', org: 'Family Clinic', module: 'Daily Diary / Healthcare', remarks: 'Routine checkups' },
  ],
  expenses: [
    { date: '2026-10-25', item: 'Vegetables & Provisions', cat: 'Groceries', method: 'UPI (PhonePe)', amount: 1250, status: 'Paid', merchant: 'Suresh (Fresh Mart)', phone: '+91 9700887766', ref: 'UPI-99281726', remarks: 'Weekly fresh market produce' },
    { date: '2026-10-26', item: 'Vehicle Petrol Refill', cat: 'Fuel & Transport', method: 'Credit Card', amount: 2500, status: 'Paid', merchant: 'HPCL Pump Station Manager', phone: '+91 8662451100', ref: 'POS-119284', remarks: 'Tank full at Ring Road' },
    { date: '2026-10-27', item: 'Pharmacy & Daily Medicines', cat: 'Healthcare', method: 'UPI (Google Pay)', amount: 480, status: 'Paid', merchant: 'Apollo Pharmacy Desk', phone: '+91 8662589000', ref: 'UPI-88192019', remarks: 'Prescription medicines for family' },
    { date: '2026-10-28', item: 'Daily Milk & Dairy Delivery', cat: 'Groceries', method: 'Cash', amount: 650, status: 'Paid', merchant: 'K. Rambabu (Milk Delivery)', phone: '+91 9848123490', ref: 'CASH-REC', remarks: 'Fortnightly dairy settlement' },
    { date: '2026-10-29', item: 'Coffee & Snacks with Colleagues', cat: 'Dining / Personal', method: 'UPI (Paytm)', amount: 320, status: 'Paid', merchant: 'Cafe Barista Desk', phone: '+91 8662998877', ref: 'UPI-77182901', remarks: 'Work break meeting' },
    { date: '2026-10-30', item: 'Home RO Water Purifier Filter', cat: 'Household Maintenance', method: 'Cash On Delivery', amount: 1200, status: 'Paid', merchant: 'Ramesh (Smart Services)', phone: '+91 9866554433', ref: 'INV-66190', remarks: 'Filter replaced by technician' },
    { date: '2026-10-31', item: 'Weekly Organic Fruits', cat: 'Groceries', method: 'UPI', amount: 550, status: 'Unpaid', merchant: 'G. Krishna (Fruit Vendor)', phone: '+91 9959112233', ref: 'PENDING', remarks: 'To pay vendor tomorrow morning' },
  ],
  payments: [
    { txn: '2026-10-01', due: '2026-10-01', payee: 'Home Mortgage Loan EMI', cat: 'Debt / Mortgage', amount: 65000, mode: 'Bank Auto-Debit', status: 'Paid', contact: 'SBI Relationship Manager (R. Sharma)', phone: '+91 9848011223', ref: 'ACH-88910245', alert: '+91 8985800099', remarks: 'Successfully debited on 1st' },
    { txn: '2026-10-05', due: '2026-10-05', payee: 'Electricity Bill (State Discom)', cat: 'Utilities', amount: 3450, mode: 'UPI (PhonePe)', status: 'Paid', contact: 'APCPDCL Helpdesk', phone: '1912', ref: 'UPI-TXN-90214', alert: '+91 8985800099', remarks: 'Paid via electricity portal' },
    { txn: '2026-10-10', due: '2026-10-10', payee: 'Car Loan Auto EMI', cat: 'Debt / Vehicle', amount: 18500, mode: 'Bank Auto-Debit', status: 'Paid', contact: 'ICICI Car Loan Officer (K. Venkat)', phone: '+91 9849122334', ref: 'ACH-7729104', alert: '+91 8985800099', remarks: 'Automated NACH debit' },
    { txn: '2026-10-15', due: '2026-10-15', payee: 'Broadband Fiber Internet', cat: 'Utilities', amount: 1199, mode: 'Net Banking', status: 'Paid', contact: 'Airtel Broadband Care', phone: '121', ref: 'TXN-338190', alert: '+91 8985800099', remarks: 'Quarterly advance cycle' },
    { txn: '2026-10-25', due: '2026-10-25', payee: 'Credit Card Monthly Statement', cat: 'Credit Cards', amount: 22800, mode: 'IMPS', status: 'Paid', contact: 'HDFC Credit Card Desk', phone: '+91 9966088888', ref: 'IMPS-449102', alert: '+91 8985800099', remarks: 'Full bill cleared' },
    { txn: 'Pending', due: '2026-11-05', payee: 'Vehicle Comprehensive Insurance', cat: 'Insurance', amount: 16500, mode: 'Net Banking / UPI', status: 'Unpaid', contact: 'Bajaj Allianz Motor Agent (M. Prasad)', phone: '+91 9989012345', ref: 'PENDING-01', alert: '+91 8985800099', remarks: 'Due soon; alert enabled' },
    { txn: 'Pending', due: '2026-11-10', payee: 'Apartment Maintenance', cat: 'Housing', amount: 4500, mode: 'UPI', status: 'Unpaid', contact: 'Society Treasurer (M. Srinivas)', phone: '+91 9848099881', ref: 'PENDING-02', alert: '+91 8985800099', remarks: 'Pay society treasurer' },
    { txn: 'Pending', due: '2026-11-20', payee: 'Family Health Insurance Premium', cat: 'Insurance', amount: 28500, mode: 'Net Banking', status: 'Unpaid', contact: 'Star Health Advisor (V. Rajesh)', phone: '+91 9701234567', ref: 'PENDING-03', alert: '+91 8985800099', remarks: 'Annual renewal; urgent alert set' },
  ],
  loans: [
    { name: 'Primary Residential Home Loan', type: 'Home Loan', lender: 'State Bank of India', officer: 'SBI RM (R. Sharma)', phone: '+91 9848011223', rate: 0.0845, principal: 5000000, emi: 65000, outstanding: 4210000, closure: '2038-04-30', status: 'Active', autodebit: 'SBI Savings *4910', remarks: 'Rate reset annually, MCLR linked' },
    { name: 'SUV Car Financing Loan', type: 'Auto Loan', lender: 'ICICI Bank', officer: 'ICICI Officer (K. Venkat)', phone: '+91 9849122334', rate: 0.0875, principal: 1200000, emi: 18500, outstanding: 640000, closure: '2028-09-15', status: 'Active', autodebit: 'ICICI Salary *1021', remarks: 'Hypothecation on vehicle' },
    { name: 'Premium Travel Credit Card', type: 'Credit Card', lender: 'HDFC Bank', officer: 'HDFC Card Concierge', phone: '+91 9966088888', rate: 0.42, principal: 500000, emi: 5000, outstanding: 22800, closure: 'Monthly Revolving', status: 'Active', autodebit: 'Manual Pay via App', remarks: 'Reward points accumulation card' },
    { name: 'Solar Rooftop Energy Loan', type: 'Green Energy Loan', lender: 'Canara Bank', officer: 'Branch Manager (M. Satish)', phone: '+91 9440123890', rate: 0.075, principal: 250000, emi: 4800, outstanding: 142000, closure: '2029-12-01', status: 'Active', autodebit: 'SBI Savings *4910', remarks: 'Govt subsidy credited' },
    { name: 'Education Loan', type: 'Student Loan', lender: 'SBI Education Wing', officer: 'Chief Manager (P. V. Reddy)', phone: '+91 9441223344', rate: 0.0815, principal: 800000, emi: 12000, outstanding: 95000, closure: '2027-06-30', status: 'Active', autodebit: 'SBI Savings *4910', remarks: 'Last 8 installments remaining' },
  ],
  insurance: [
    { name: 'Comprehensive Family Health Optima', cat: 'Health Floater', insurer: 'Star Health / HDFC ERGO', policyno: 'POL-98745210', insured: 'Self, Spouse, Children', sum: 2500000, premium: 28500, renewal: '2026-11-20', freq: 'Annual', nominee: 'Padmasri Gudipati (Spouse)', advisor: 'Star Health Advisor (V. Rajesh)', phone: '+91 9701234567', alert: 'Active Alert (30/15/7/1d)', remarks: 'Cashless network empanelled' },
    { name: 'Pure Term Life Protection Cover', cat: 'Term Life', insurer: 'LIC / HDFC Life', policyno: 'POL-11223344', insured: 'Self', sum: 20000000, premium: 32000, renewal: '2026-12-15', freq: 'Annual', nominee: 'Padmasri Gudipati (Spouse 100%)', advisor: 'LIC Senior Development Officer', phone: '+91 9848556677', alert: 'Active Alert (30/15/7/1d)', remarks: 'Critical illness rider included' },
    { name: 'Vehicle Comprehensive Motor Policy', cat: 'Vehicle - Car', insurer: 'Bajaj Allianz / ICICI Lombard', policyno: 'MOT-55667788', insured: 'Family Car (AP 16 XX 0001)', sum: 1250000, premium: 16500, renewal: '2026-11-05', freq: 'Annual', nominee: 'Self', advisor: 'Bajaj Allianz Motor Agent (M. Prasad)', phone: '+91 9989012345', alert: 'Active Alert (30/15/7/1d)', remarks: 'Zero depreciation + RSA included' },
    { name: 'Home & Fire Structure Cover', cat: 'Property', insurer: 'Tata AIG General', policyno: 'PROP-334411', insured: 'Primary Residence', sum: 7500000, premium: 5800, renewal: '2027-03-31', freq: 'Annual', nominee: 'Padmasri Gudipati (Spouse)', advisor: 'Tata AIG Agency Support Desk', phone: '1800-266-7780', alert: 'Active Alert (30/15/7/1d)', remarks: 'Structure + contents up to 15L' },
    { name: 'Senior Citizen Health Top-Up', cat: 'Health Super Top-Up', insurer: 'Care Health Insurance', policyno: 'SUP-77889900', insured: 'Parents / Family', sum: 1500000, premium: 14200, renewal: '2027-01-10', freq: 'Annual', nominee: 'Self', advisor: 'Care Health Direct Advisor', phone: '+91 9849223311', alert: 'Active Alert (30/15/7/1d)', remarks: 'Deductible of 5 Lakhs' },
  ],
  diary: [
    { date: '2026-10-28', cat: 'Family Matter', title: 'Children School Academic Discussion', notes: 'Reviewed quarterly academic progress and upcoming science project supplies.', contact: 'School Class Teacher (Mrs. Lakshmi)', phone: '+91 8662551122', follow: 'Order project kit from online store', priority: 'Medium', status: 'Completed', remarks: 'Done and verified', due: '' },
    { date: '2026-10-29', cat: 'Financial', title: 'Insurance Policy Comparative Analysis', notes: 'Checked renewal quotes for car insurance. Decided to continue with existing zero-dep package.', contact: 'Bajaj Allianz Motor Agent (M. Prasad)', phone: '+91 9989012345', follow: 'Initiate premium payment before Nov 5th', priority: 'High', status: 'Incomplete', remarks: 'Daily alert enabled', due: '2026-11-04' },
    { date: '2026-10-30', cat: 'Personal / Health', title: 'Routine Family Health Checkup', notes: 'Completed annual blood profile tests at medical lab. Doctor reports normal parameters.', contact: 'Family Physician (Dr. Rao)', phone: '+91 9848119900', follow: 'Collect printed lab reports on Saturday', priority: 'Low', status: 'Completed', remarks: 'Reports reviewed', due: '' },
    { date: '2026-10-31', cat: 'Household', title: 'Electrical & AC Winter Servicing', notes: 'AC servicing completed for master bedroom. Filter cleaned and gas pressure checked.', contact: 'Technician Ramesh (Smart Services)', phone: '+91 9866554433', follow: 'Schedule second unit service next weekend', priority: 'Medium', status: 'Pending', remarks: 'Daily alert enabled', due: '2026-11-07' },
    { date: '2026-11-01', cat: 'Reminders', title: 'Monthly Utility Bills Audit', notes: 'Review water, broadband, electricity and maid salary settlements for current month.', contact: 'Society Treasurer (M. Srinivas)', phone: '+91 9848099881', follow: 'Clear utility bills by 5th Nov', priority: 'High', status: 'Pending', remarks: 'Daily alert enabled', due: '2026-11-05' },
  ],
  budgetIn: [
    { source: 'Primary Salary / Professional Income', planned: 250000, actual: 250000, payer: 'Employer Accounts Wing', phone: '0866-2200111', remarks: 'Credited to primary account' },
    { source: 'Spouse / Family Income', planned: 120000, actual: 120000, payer: 'Padmasri Gudipati', phone: '+91 9490100000', remarks: 'Credited on 1st' },
    { source: 'Rental Income from Property', planned: 35000, actual: 35000, payer: 'Tenant (K. V. Subbarao)', phone: '+91 9848554411', remarks: 'Direct bank transfer from tenant' },
    { source: 'Dividends / Fixed Deposit Interest', planned: 15000, actual: 18200, payer: 'SBI Wealth Desk', phone: '+91 9848011223', remarks: 'Quarterly interest credited' },
    { source: 'Consulting / Other Inflows', planned: 20000, actual: 25000, payer: 'Corporate Affairs Client Desk', phone: '+91 9988776655', remarks: 'Additional client project' },
  ],
  budgetEx: [
    { source: 'Loan EMIs (Home + Car Loan)', planned: 83500, actual: 83500, payer: 'SBI & ICICI Loan Desks', phone: '+91 9848011223', remarks: 'Fixed committed outflow' },
    { source: 'Groceries & Provisions (Auto from Daily)', planned: 25000, actual: 26800, payer: 'Suresh (Fresh Mart Vendor)', phone: '+91 9700887766', remarks: 'Tracked via Daily Expenses' },
    { source: 'Utilities (Power, Water, Gas, Internet)', planned: 10000, actual: 9400, payer: 'APCPDCL / Airtel Fiber Care', phone: '1912 / 121', remarks: 'Within expected winter band' },
    { source: 'Insurance Allocations (Health, Life, Motor)', planned: 15000, actual: 15000, payer: 'Star Health / Bajaj Desk', phone: '+91 9701234567', remarks: 'Annualized monthly reserve' },
    { source: 'Fuel & Commuting / Transport', planned: 12000, actual: 11500, payer: 'HPCL Fuel Station Ring Road', phone: '+91 8662451100', remarks: 'Local and office travel' },
    { source: 'Dining Out, Leisure & Family Events', planned: 15000, actual: 18200, payer: 'Family / Local Restaurants', phone: '-', remarks: 'Family dinner & festival treats' },
    { source: 'Children Education & Extracurriculars', planned: 30000, actual: 30000, payer: 'School Accounts & Administration', phone: '+91 8662551122', remarks: 'School tuition & sports academy' },
    { source: 'Healthcare & Medical Reserve', planned: 8000, actual: 6200, payer: 'Family Physician (Dr. Rao)', phone: '+91 9848119900', remarks: 'Routine checkups & vitamins' },
    { source: 'Personal Care & Apparel', planned: 10000, actual: 12000, payer: 'Local Retailers & Online', phone: '-', remarks: 'Diwali / festival shopping' },
    { source: 'Monthly Investments (PPF / SIPs / Emergency)', planned: 100000, actual: 100000, payer: 'Mutual Fund Advisory Desk', phone: '+91 9849001122', remarks: 'Automatic SIP transfer' },
  ],
};
