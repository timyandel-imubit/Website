import rules from "./rules/2026.js";
import { db, getProfile } from "./db.js";
import { listAccounts } from "./overview.js";

const round = (n) => Math.round(n);

// Accounts where a beneficiary designation (or TOD/POD) overrides the will.
const DESIGNATION_KINDS = new Set(["retirement", "insurance", "investment", "cash"]);

export const CORE_DOCS = [
  { doc_type: "will", label: "Will (pour-over if you have a trust)" },
  { doc_type: "revocable_trust", label: "Revocable living trust" },
  { doc_type: "durable_poa", label: "Durable financial power of attorney" },
  { doc_type: "healthcare_directive", label: "Healthcare directive / proxy" },
  { doc_type: "hipaa_release", label: "HIPAA authorization" },
];

export function listEstateDocs() {
  return db.prepare("SELECT * FROM estate_docs ORDER BY person, doc_type").all();
}

export function estateSummary() {
  const p = getProfile();
  const married = p.filing_status === "mfj" || p.filing_status === "mfs" || p.married === true;
  const children = Array.isArray(p.children) ? p.children : [];
  const minors = children.filter((c) => Number(c.age) < 18);
  const accounts = listAccounts();

  // Gross estate by person. Joint property split 50/50 between spouses;
  // revocable trust assets stay in the grantors' estates; child-owned assets are excluded.
  const byPerson = { self: 0, spouse: 0 };
  let trustOwned = 0, excluded = 0;
  for (const a of accounts) {
    const v = a.is_liability ? -a.balance : a.kind === "insurance" ? Math.max(a.balance, a.death_benefit || 0) : a.balance;
    if (a.owner === "self") byPerson.self += v;
    else if (a.owner === "spouse") byPerson.spouse += v;
    else if (a.owner === "joint" || a.owner === "trust") {
      if (a.owner === "trust") trustOwned += v;
      if (married) { byPerson.self += v / 2; byPerson.spouse += v / 2; } else byPerson.self += v;
    } else excluded += v;
  }
  if (p.irrevocable_trust_assets) excluded += Number(p.irrevocable_trust_assets) || 0;

  const exemption = rules.estate.exemptionPerPerson;
  const combined = byPerson.self + (married ? byPerson.spouse : 0);
  const available = married ? exemption * 2 : exemption; // assumes portability is elected
  const taxableExcess = Math.max(0, combined - available);

  const missingBeneficiaries = accounts
    .filter((a) => !a.is_liability && DESIGNATION_KINDS.has(a.kind) && a.owner !== "trust" && !a.beneficiary)
    .map((a) => ({ id: a.id, name: a.name, kind: a.kind, balance: round(a.balance) }));

  const docs = listEstateDocs();
  const people = married ? ["self", "spouse"] : ["self"];
  const required = [...CORE_DOCS];
  if (minors.length) required.push({ doc_type: "guardianship", label: "Guardian nomination for minor children" });
  const checklist = [];
  for (const person of people) {
    for (const d of required) {
      const found = docs.find((x) => x.doc_type === d.doc_type && (x.person === person || x.person === "joint"));
      const stale = found?.last_reviewed && Date.now() - new Date(found.last_reviewed).getTime() > 3 * 365 * 864e5;
      checklist.push({ person, doc_type: d.doc_type, label: d.label, status: found?.status || "missing", last_reviewed: found?.last_reviewed || null, needs_review: Boolean(stale) });
    }
  }

  const donors = married ? 2 : 1;
  const annual = rules.gift.annualExclusion;

  const lifeInsurance = accounts.filter((a) => a.kind === "insurance" && a.owner !== "trust").reduce((t, a) => t + (a.death_benefit || 0), 0);

  return {
    tax_year: rules.year,
    rules_verified: rules.verified,
    married,
    children: children.length,
    minor_children: minors.length,
    gross_estate_self: round(byPerson.self),
    gross_estate_spouse: married ? round(byPerson.spouse) : null,
    combined_estate: round(combined),
    trust_owned_assets: round(trustOwned),
    life_insurance_in_estate: round(lifeInsurance),
    excluded_assets: round(excluded),
    exemption_per_person: exemption,
    exemption_available: available,
    headroom: round(available - combined),
    est_federal_estate_tax_if_death_today: round(taxableExcess * rules.estate.topRate),
    gifting: {
      annual_exclusion: annual,
      max_annual_tax_free_gifts_to_children: annual * donors * children.length,
      superfund_529_per_child: annual * 5 * donors,
    },
    beneficiary_gaps: missingBeneficiaries,
    document_checklist: checklist,
    notes: [
      "Estimate assumes portability of the deceased spouse's unused exemption is elected on a timely Form 706.",
      "State estate or inheritance taxes (e.g. MA, NY, WA, IL, OR) can apply at far lower thresholds and are not modeled.",
      "Life insurance owned by you is in your estate; policies held in an ILIT are not — set the account owner accordingly.",
    ],
  };
}
