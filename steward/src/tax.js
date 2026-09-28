// Deterministic federal tax math. The AI calls these functions instead of doing
// arithmetic in its head, so every number it quotes is reproducible.
import rules from "./rules/2026.js";
import { getProfile } from "./db.js";
import { listHoldings } from "./overview.js";

const round = (n) => Math.round(n);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const STATUSES = ["single", "mfj", "hoh", "mfs"];

function bracketTax(income, brackets) {
  let tax = 0, lower = 0;
  for (const [upper, rate] of brackets) {
    if (income <= lower) break;
    tax += (Math.min(income, upper) - lower) * rate;
    lower = upper;
  }
  return tax;
}

function marginal(income, brackets) {
  let lower = 0;
  for (const [upper, rate] of brackets) {
    if (income < upper) return { rate, room_in_bracket: upper === Infinity ? null : round(upper - income), next_threshold: upper === Infinity ? null : upper };
    lower = upper;
  }
  return { rate: brackets.at(-1)[1], room_in_bracket: null, next_threshold: null };
}

// Preferential income sits on top of ordinary income in the LTCG brackets.
function prefTax(ordinaryTaxable, prefIncome, brackets) {
  let tax = 0, lower = 0;
  const start = ordinaryTaxable, end = ordinaryTaxable + prefIncome;
  for (const [upper, rate] of brackets) {
    const lo = Math.max(start, lower), hi = Math.min(end, upper);
    if (hi > lo) tax += (hi - lo) * rate;
    lower = upper;
  }
  return tax;
}

export function taxInputsFromProfile(overrides = {}) {
  const p = { ...getProfile(), ...overrides };
  return {
    filing_status: STATUSES.includes(p.filing_status) ? p.filing_status : "mfj",
    wages: num(p.wages),
    self_employment_income: num(p.self_employment_income),
    other_ordinary_income: num(p.other_ordinary_income),
    interest_income: num(p.interest_income),
    ordinary_dividends: num(p.ordinary_dividends),
    qualified_dividends: num(p.qualified_dividends),
    realized_st_gains: num(p.realized_st_gains),
    realized_lt_gains: num(p.realized_lt_gains),
    pretax_contributions: num(p.pretax_contributions),
    itemized_deductions: num(p.itemized_deductions),
    children_under_17: num(p.children_under_17),
    state_tax_rate: num(p.state_tax_rate),
  };
}

export function estimateTax(overrides = {}) {
  const i = taxInputsFromProfile(overrides);
  const fs = i.filing_status;

  // Net capital gains/losses per Schedule D ordering.
  let st = i.realized_st_gains, lt = i.realized_lt_gains;
  let stOrdinary = 0, ltPref = 0, lossDeduction = 0, carryforward = 0;
  const net = st + lt;
  if (net < 0) {
    const cap = fs === "mfs" ? rules.capitalLossOrdinaryOffset.mfs : rules.capitalLossOrdinaryOffset.default;
    lossDeduction = Math.min(cap, -net);
    carryforward = -net - lossDeduction;
  } else if (st >= 0 && lt >= 0) { stOrdinary = st; ltPref = lt; }
  else if (st < 0) { ltPref = lt + st; }
  else { stOrdinary = st + lt; }

  // Half of SE tax is deductible; SE tax itself is approximated at 15.3% on 92.35% (cap ignored).
  const seTax = i.self_employment_income > 0 ? i.self_employment_income * 0.9235 * 0.153 : 0;
  const nonQualDiv = Math.max(0, i.ordinary_dividends - i.qualified_dividends);
  const ordinaryIncome =
    i.wages + i.self_employment_income + i.other_ordinary_income + i.interest_income + nonQualDiv +
    stOrdinary - lossDeduction - i.pretax_contributions - seTax / 2;
  const prefIncome = ltPref + i.qualified_dividends;
  const agi = ordinaryIncome + prefIncome;
  const standard = rules.standardDeduction[fs];
  const deduction = Math.max(standard, i.itemized_deductions);
  const taxable = Math.max(0, agi - deduction);
  const taxableOrdinary = Math.max(0, taxable - prefIncome);
  const taxablePref = taxable - taxableOrdinary;

  const ordinaryTax = bracketTax(taxableOrdinary, rules.ordinaryBrackets[fs]);
  const capitalGainsTax = prefTax(taxableOrdinary, taxablePref, rules.ltcgBrackets[fs]);

  const nii = Math.max(0, i.interest_income + i.ordinary_dividends + stOrdinary + ltPref);
  const niitExcess = Math.max(0, agi - rules.niit.threshold[fs]);
  const niit = Math.min(nii, niitExcess) * rules.niit.rate;

  const ctcPhaseStart = fs === "mfj" ? 400000 : 200000;
  const ctcGross = i.children_under_17 * rules.childTaxCredit;
  const ctcReduction = Math.ceil(Math.max(0, agi - ctcPhaseStart) / 1000) * 50;
  const ctc = Math.max(0, ctcGross - ctcReduction);

  const incomeTax = Math.max(0, ordinaryTax + capitalGainsTax - ctc);
  const federal = incomeTax + niit + seTax;
  const state = taxable * i.state_tax_rate;

  const ordMarg = marginal(taxableOrdinary, rules.ordinaryBrackets[fs]);
  const ltcgTop = marginal(taxable, rules.ltcgBrackets[fs]);
  const zeroPctCeiling = rules.ltcgBrackets[fs][0][0];

  return {
    tax_year: rules.year,
    rules_verified: rules.verified,
    inputs: i,
    agi: round(agi),
    deduction_used: deduction === standard ? "standard" : "itemized",
    deduction: round(deduction),
    taxable_income: round(taxable),
    ordinary_taxable_income: round(taxableOrdinary),
    preferential_income: round(taxablePref),
    ordinary_tax: round(ordinaryTax),
    capital_gains_tax: round(capitalGainsTax),
    child_tax_credit: round(ctc),
    niit: round(niit),
    self_employment_tax: round(seTax),
    federal_total: round(federal),
    state_estimate: round(state),
    total_tax: round(federal + state),
    effective_rate_pct: agi > 0 ? Math.round(((federal + state) / agi) * 1000) / 10 : 0,
    marginal_ordinary_rate: ordMarg.rate,
    room_in_ordinary_bracket: ordMarg.room_in_bracket,
    marginal_ltcg_rate: ltcgTop.rate + (niitExcess > 0 ? rules.niit.rate : 0),
    zero_pct_ltcg_headroom: round(Math.max(0, zeroPctCeiling - taxable)),
    capital_loss_carryforward: round(carryforward),
    caveats: [
      "Federal estimate only; AMT, QBI deduction, SALT cap details, phase-outs other than the child tax credit, and credits beyond the CTC are not modeled.",
      "State tax is a flat-rate approximation using your profile's state_tax_rate.",
      rules.verified ? null : `Tax-year ${rules.year} parameters have not been verified against IRS publications in this install.`,
    ].filter(Boolean),
  };
}

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
function term(acquired) {
  if (!acquired) return "unknown";
  return Date.now() - new Date(acquired).getTime() > YEAR_MS ? "long" : "short";
}

export function unrealizedGains() {
  const holdings = listHoldings().filter((h) => h.tax_treatment === "taxable" && h.cost_basis != null && h.security_type !== "cash");
  const rows = holdings.map((h) => ({
    holding_id: h.id,
    account: h.account_name,
    symbol: h.symbol,
    name: h.name,
    value: round(h.value),
    cost_basis: round(h.cost_basis),
    gain: round(h.value - h.cost_basis),
    term: term(h.acquired_date),
    acquired_date: h.acquired_date,
  }));
  const total = (f) => round(rows.filter(f).reduce((t, r) => t + r.gain, 0));
  return {
    positions: rows.sort((a, b) => a.gain - b.gain),
    total_unrealized_gain: total(() => true),
    long_term_gain: total((r) => r.term === "long" && r.gain > 0),
    short_term_gain: total((r) => r.term === "short" && r.gain > 0),
    harvestable_losses: total((r) => r.gain < 0),
  };
}

export function taxLossHarvesting({ min_loss = 500 } = {}) {
  const est = estimateTax();
  const all = listHoldings();
  const { positions } = unrealizedGains();

  const candidates = positions
    .filter((p) => p.gain <= -Math.abs(min_loss))
    .map((p) => {
      // Wash-sale risk: the same security held in another account (IRAs count),
      // since reinvested dividends or recent buys there can trigger a wash sale.
      const elsewhere = all.filter((h) => h.symbol && h.symbol === p.symbol && h.id !== p.holding_id).map((h) => `${h.account_name} (${h.tax_treatment})`);
      const rate = p.term === "short" ? est.marginal_ordinary_rate : Math.max(est.marginal_ltcg_rate, 0.15);
      return {
        ...p,
        loss: -p.gain,
        est_tax_value: round(-p.gain * rate),
        rate_assumed: rate,
        wash_sale_risk: elsewhere.length ? `Also held in: ${elsewhere.join(", ")}` : null,
      };
    });

  const gainHarvest = est.zero_pct_ltcg_headroom > 0
    ? positions.filter((p) => p.term === "long" && p.gain > 0).map((p) => ({ ...p, note: "Could be realized at 0% federal LTCG within current headroom" }))
    : [];

  return {
    candidates,
    total_harvestable_loss: round(candidates.reduce((t, c) => t + c.loss, 0)),
    est_total_tax_value_upper_bound: round(candidates.reduce((t, c) => t + c.est_tax_value, 0)),
    zero_pct_ltcg_headroom: est.zero_pct_ltcg_headroom,
    gain_harvesting_candidates: gainHarvest,
    notes: [
      "Tax value is an upper bound: losses first offset realized gains, then up to $3,000 of ordinary income, then carry forward.",
      "Avoid buying the same or a substantially identical security within 30 days before or after the sale in ANY account, including IRAs and a spouse's accounts.",
      "Cost basis comes from your brokerage feed or manual entry — confirm lot-level basis with the broker before selling.",
    ],
  };
}

export function contributionRoom() {
  const p = getProfile();
  const L = rules.contributionLimits;
  const people = [];
  for (const who of ["self", "spouse"]) {
    const age = num(p[`${who}_age`]);
    if (!age) continue;
    const k401Limit = L.k401 + (age >= 60 && age <= 63 ? L.k401CatchUp60to63 : age >= 50 ? L.k401CatchUp50 : 0);
    const iraLimit = L.ira + (age >= 50 ? L.iraCatchUp50 : 0);
    people.push({
      person: who,
      age,
      k401_limit: k401Limit,
      k401_contributed_ytd: num(p[`${who}_401k_ytd`]),
      k401_remaining: Math.max(0, k401Limit - num(p[`${who}_401k_ytd`])),
      ira_limit: iraLimit,
      ira_contributed_ytd: num(p[`${who}_ira_ytd`]),
      ira_remaining: Math.max(0, iraLimit - num(p[`${who}_ira_ytd`])),
    });
  }
  const hsaLimit = p.hsa_coverage === "family" ? L.hsaFamily : p.hsa_coverage === "self" ? L.hsaSelf : 0;
  return {
    tax_year: rules.year,
    rules_verified: rules.verified,
    people,
    hsa: hsaLimit ? { coverage: p.hsa_coverage, limit: hsaLimit, contributed_ytd: num(p.hsa_ytd), remaining: Math.max(0, hsaLimit - num(p.hsa_ytd)) } : null,
    note: people.length ? null : "Add self_age / spouse_age in your profile to compute retirement contribution room.",
  };
}
