// Rules-based findings that run on every dashboard load — no AI call, no cost.
// The advisor chat can then dig into any of them.
import { computeOverview, listAccounts } from "./overview.js";
import { estimateTax, taxLossHarvesting, contributionRoom } from "./tax.js";
import { estateSummary } from "./estate.js";

const usd = (n) => "$" + Math.round(n).toLocaleString("en-US");

export function generateInsights() {
  const out = [];
  const add = (severity, area, title, detail, ask) => out.push({ severity, area, title, detail, ask });
  const o = computeOverview();
  if (!o.account_count) return [{ severity: "info", area: "setup", title: "Add your first account", detail: "Link an institution or add a manual asset to get started.", ask: null }];

  // Cash drag
  if (o.est_monthly_spending > 0) {
    const months = o.liquid_cash / o.est_monthly_spending;
    if (months > 9) {
      const excess = o.liquid_cash - o.est_monthly_spending * 6;
      add("opportunity", "cash", `~${months.toFixed(0)} months of spending sitting in cash`,
        `About ${usd(excess)} above a 6-month reserve. Check it's earning a competitive yield or has a job to do.`,
        `I have about ${usd(excess)} more cash than a 6-month reserve. What should I consider doing with it given my goals and tax situation?`);
    } else if (months < 3) {
      add("warning", "cash", "Thin cash reserve", `Liquid cash covers ~${months.toFixed(1)} months of recent spending.`, "Is my emergency reserve adequate for my situation?");
    }
  }

  // Credit card balances
  const cc = listAccounts().filter((a) => a.kind === "credit" && a.balance > 1000);
  if (cc.length) {
    const total = cc.reduce((t, a) => t + a.balance, 0);
    add("warning", "debt", `${usd(total)} on credit cards`, "If any of this is revolving rather than paid in full, it is likely your highest-cost debt.", null);
  }

  // Concentration in single securities (diversified funds are excluded)
  const DIVERSIFIED = new Set(["etf", "mutual fund", "fixed income"]);
  for (const p of o.top_positions.filter((p) => p.pct_of_investable >= 10 && !DIVERSIFIED.has(p.security_type))) {
    add("warning", "risk", `${p.symbol} is ${p.pct_of_investable}% of investable assets`,
      `Single-position concentration of ${usd(p.value)}.`,
      `${p.symbol} is ${p.pct_of_investable}% of my investable assets. What are tax-aware ways to reduce this concentration?`);
  }

  // Tax
  try {
    const tlh = taxLossHarvesting();
    if (tlh.total_harvestable_loss >= 3000) {
      add("opportunity", "tax", `${usd(tlh.total_harvestable_loss)} of harvestable losses`,
        `${tlh.candidates.length} taxable position(s) below cost basis. Up to ~${usd(tlh.est_total_tax_value_upper_bound)} of tax value.`,
        "Walk me through my tax-loss harvesting candidates, including wash-sale risks and replacement ideas.");
    }
    const est = estimateTax();
    if (est.zero_pct_ltcg_headroom > 5000 && tlh.gain_harvesting_candidates.length) {
      add("opportunity", "tax", `${usd(est.zero_pct_ltcg_headroom)} of 0% capital-gains room`,
        "You could realize long-term gains this year at a 0% federal rate and reset basis higher.",
        "Should I harvest gains at the 0% rate this year? Which positions?");
    }
    const room = contributionRoom();
    for (const person of room.people) {
      if (person.k401_contributed_ytd > 0 && person.k401_remaining > 0) add("opportunity", "tax", `${usd(person.k401_remaining)} of 401(k) room left (${person.person})`, `Limit ${usd(person.k401_limit)} for ${room.tax_year}.`, null);
    }
  } catch (e) {
    add("info", "tax", "Tax checks skipped", String(e.message), null);
  }

  // Estate
  const es = estateSummary();
  if (es.beneficiary_gaps.length) {
    const total = es.beneficiary_gaps.reduce((t, a) => t + a.balance, 0);
    add("warning", "estate", `${es.beneficiary_gaps.length} account(s) with no beneficiary recorded`,
      `${usd(total)} may pass through probate or by default rules. Record the designation (or confirm TOD/POD) for each.`,
      "Which of my accounts lack beneficiaries, and how should I think about designations given my family and any trust?");
  }
  const missing = es.document_checklist.filter((d) => d.status !== "signed");
  if (missing.length) {
    add("warning", "estate", `${missing.length} core estate document(s) not signed`, missing.slice(0, 4).map((d) => `${d.label} (${d.person})`).join("; "),
      "Help me prioritize my missing estate planning documents and prepare for a meeting with an estate attorney.");
  }
  if (es.headroom < es.exemption_available * 0.25) {
    add("warning", "estate", "Estate is near or above the federal exemption",
      `Estimated headroom ${usd(es.headroom)}; potential federal estate tax today ${usd(es.est_federal_estate_tax_if_death_today)}.`,
      "My estate is close to the federal exemption. What strategies should I discuss with my estate attorney?");
  }

  // Stale manual valuations
  const stale = listAccounts().filter((a) => a.source === "manual" && ["real_estate", "vehicle", "collectible", "private"].includes(a.kind) && Date.now() - new Date(a.updated_at + "Z").getTime() > 180 * 864e5);
  if (stale.length) add("info", "data", `${stale.length} manual valuation(s) older than 6 months`, stale.map((a) => a.name).join(", "), null);

  const rank = { warning: 0, opportunity: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
