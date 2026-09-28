// Loads a fictional household so you can try Steward without linking accounts.
// Usage: npm run seed  (use a separate STEWARD_DATA_DIR to keep it away from real data)
import { db, setProfile, tx } from "../src/db.js";

const existing = db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
if (existing && !process.argv.includes("--force")) {
  console.error(`Database already has ${existing} accounts. Re-run with --force to wipe it and load demo data.`);
  process.exit(1);
}

const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

tx(() => {
  for (const t of ["transactions", "holdings", "accounts", "snapshots", "profile", "memories", "estate_docs", "advisor_questions", "conversations"]) db.exec(`DELETE FROM ${t}`);

  setProfile({
    filing_status: "mfj", state: "FL", state_tax_rate: 0, married: true,
    self_age: 41, spouse_age: 39,
    children: [{ name: "Ava", age: 11 }, { name: "Leo", age: 9 }, { name: "Mia", age: 6 }, { name: "Sam", age: 3 }],
    children_under_17: 4,
    wages: 420000, qualified_dividends: 18000, ordinary_dividends: 21000, interest_income: 9000,
    realized_lt_gains: 35000, realized_st_gains: 0, pretax_contributions: 24500, itemized_deductions: 41000,
    self_401k_ytd: 18000, spouse_401k_ytd: 0, self_ira_ytd: 0, spouse_ira_ytd: 0,
    hsa_coverage: "family", hsa_ytd: 4000, risk_tolerance: "moderately aggressive",
  });

  const acct = db.prepare(
    `INSERT INTO accounts (source, institution, name, kind, subtype, mask, balance, is_liability, tax_treatment, owner, beneficiary, cost_basis, acquired_date, notes, updated_at, death_benefit)
     VALUES ('manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const A = (inst, name, kind, sub, mask, bal, liab, tt, owner, bene, basis, acq, notes, updated = daysAgo(3), deathBenefit = null) =>
    Number(acct.run(inst, name, kind, sub, mask, bal, liab, tt, owner, bene, basis, acq, notes, updated, deathBenefit).lastInsertRowid);

  const checking = A("Chase", "Total Checking", "cash", "checking", "4412", 38200, 0, "taxable", "joint", null, null, null, null);
  A("Marcus", "High-Yield Savings", "cash", "savings", "9031", 212000, 0, "taxable", "joint", null, null, null, null);
  const brokerage = A("Fidelity", "Joint Brokerage", "investment", "brokerage", "7720", 0, 0, "taxable", "joint", "Spouse (TOD)", null, null, null);
  const k401 = A("Fidelity", "401(k)", "retirement", "401k", "1180", 0, 0, "tax_deferred", "self", "Spouse", null, null, null);
  const roth = A("Schwab", "Roth IRA", "retirement", "roth", "5502", 0, 0, "tax_free", "spouse", null, null, null, null);
  A("Fidelity", "HSA", "retirement", "hsa", "3301", 31000, 0, "hsa", "self", null, null, null, null);
  const crypto = A("Coinbase", "Coinbase", "crypto", "crypto exchange", null, 0, 0, "taxable", "self", null, null, null, null);
  A(null, "Primary residence", "real_estate", "home", null, 1850000, 0, "taxable", "joint", null, 1200000, "2019-06-15", "Zillow estimate", daysAgo(250));
  A(null, "Beach condo (rental)", "real_estate", "rental", null, 720000, 0, "taxable", "joint", null, 540000, "2021-03-01", null, daysAgo(40));
  A(null, "2023 Rivian R1S", "vehicle", null, null, 61000, 0, "taxable", "joint", null, null, null, null, daysAgo(200));
  A(null, "Watch collection", "collectible", null, null, 95000, 0, "taxable", "self", null, 70000, null, "3 pieces, insured", daysAgo(400));
  A(null, "Seed-stage angel investments (4)", "private", null, null, 250000, 0, "taxable", "self", null, 250000, "2022-01-01", "Held at cost; QSBS-eligible?", daysAgo(90));
  A(null, "Term life (20yr, $3M)", "insurance", "term", null, 0, 0, "taxable", "self", "Spouse", null, null, "Owned personally, not in an ILIT", daysAgo(30), 3000000);
  A("Rocket", "Mortgage — primary", "mortgage", "mortgage", "0091", 940000, 1, "taxable", "joint", null, null, null, "6.1% fixed");
  A("Chase", "Mortgage — condo", "mortgage", "mortgage", "0112", 410000, 1, "taxable", "joint", null, null, null, "6.8% fixed");
  A("Amex", "Platinum", "credit", "credit card", "1009", 14300, 1, "taxable", "self", null, null, null, null);

  const H = db.prepare("INSERT INTO holdings (account_id, symbol, name, security_type, quantity, price, value, cost_basis, acquired_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const pos = (acct, sym, name, type, qty, px, basis, acq) => H.run(acct, sym, name, type, qty, px, qty * px, basis, acq);
  pos(brokerage, "VTI", "Vanguard Total Stock Market ETF", "etf", 2100, 318, 420000, "2020-04-02");
  pos(brokerage, "NVDA", "NVIDIA Corp", "equity", 2600, 178, 61000, "2019-11-12");
  pos(brokerage, "ARKK", "ARK Innovation ETF", "etf", 3000, 62, 312000, "2021-02-10");
  pos(brokerage, "PYPL", "PayPal Holdings", "equity", 1400, 68, 205000, "2021-07-20");
  pos(brokerage, "VXUS", "Vanguard Total Intl Stock ETF", "etf", 1500, 71, 118000, daysAgo(200));
  pos(brokerage, "SPAXX", "Fidelity Govt Money Market", "cash", 45000, 1, 45000, null);
  pos(k401, "FXAIX", "Fidelity 500 Index", "mutual fund", 2900, 225, null, null);
  pos(k401, "VXUS", "Vanguard Total Intl Stock ETF", "etf", 900, 71, null, null);
  pos(roth, "QQQ", "Invesco QQQ", "etf", 310, 590, null, null);
  pos(crypto, "BTC", "Bitcoin", "cryptocurrency", 3.1, 112000, 98000, "2020-12-01");
  pos(crypto, "ETH", "Ethereum", "cryptocurrency", 40, 4100, 150000, daysAgo(150));

  db.exec("UPDATE accounts SET balance = (SELECT COALESCE(SUM(value), 0) FROM holdings WHERE account_id = accounts.id) WHERE id IN (SELECT DISTINCT account_id FROM holdings)");

  // ~6 months of spending
  const T = db.prepare("INSERT INTO transactions (id, account_id, date, amount, name, merchant, category) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const spend = [
    ["Whole Foods", "FOOD_AND_DRINK", 420, 9], ["Delta Air Lines", "TRAVEL", 1850, 40], ["Tuition — Oakwood School", "GENERAL_SERVICES", 7400, 30],
    ["Blue Bottle Coffee", "FOOD_AND_DRINK", 14, 3], ["Amazon", "GENERAL_MERCHANDISE", 180, 4], ["FPL Electric", "RENT_AND_UTILITIES", 610, 30],
    ["Equinox", "PERSONAL_CARE", 560, 30], ["Nobu", "FOOD_AND_DRINK", 640, 21], ["Nanny payroll", "GENERAL_SERVICES", 4200, 14],
  ];
  let n = 0;
  for (let d = 180; d >= 0; d--) {
    for (const [name, cat, amt, every] of spend) {
      if (d % every === 0) T.run(`demo-${n++}`, checking, daysAgo(d), Math.round(amt * (0.85 + Math.random() * 0.3)), name, name, cat);
    }
    if (d % 14 === 0) T.run(`demo-${n++}`, checking, daysAgo(d), -11800, "Payroll deposit", "Employer", "INCOME");
  }

  // Net-worth history (synthetic)
  const S = db.prepare("INSERT INTO snapshots (date, assets, liabilities, net_worth) VALUES (?, ?, ?, ?)");
  const assetsNow = db.prepare("SELECT SUM(balance) s FROM accounts WHERE is_liability = 0").get().s;
  const liabNow = db.prepare("SELECT SUM(balance) s FROM accounts WHERE is_liability = 1").get().s;
  for (let d = 730; d >= 1; d -= 7) {
    const f = 1 - d / 730 * 0.28 + Math.sin(d / 45) * 0.025;
    const a = assetsNow * f, l = liabNow * (1 + d / 730 * 0.06);
    S.run(daysAgo(d), a, l, a - l);
  }

  db.prepare("INSERT INTO estate_docs (doc_type, person, status, last_reviewed, location) VALUES (?, ?, ?, ?, ?)").run("will", "self", "signed", "2019-08-01", "Home safe");
  db.prepare("INSERT INTO estate_docs (doc_type, person, status, last_reviewed, location) VALUES (?, ?, ?, ?, ?)").run("will", "spouse", "signed", "2019-08-01", "Home safe");
  db.prepare("INSERT INTO estate_docs (doc_type, person, status) VALUES (?, ?, ?)").run("healthcare_directive", "self", "draft");

  db.prepare("INSERT INTO memories (text) VALUES (?)").run("Wants all four kids' college fully funded; oldest starts in ~7 years.");
  db.prepare("INSERT INTO memories (text) VALUES (?)").run("Considering selling the beach condo in the next 1-2 years.");
});

console.log("Demo household loaded. Start the app with: npm start");
