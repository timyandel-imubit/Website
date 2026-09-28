// Tax-year 2026 federal parameters. These are sourced from IRS Rev. Proc. 2025-32,
// IRS Notice 2025-67 and the 2025 reconciliation act (OBBBA) as understood when this
// file was written. VERIFY against irs.gov before relying on them — the app shows
// this warning wherever these numbers are used.
export default {
  year: 2026,
  verified: false,
  source: "Rev. Proc. 2025-32; Notice 2025-67; P.L. 119-21 (OBBBA)",

  standardDeduction: { single: 16100, mfj: 32200, hoh: 24150, mfs: 16100 },

  // [upper bound of bracket, rate]; last bracket has Infinity
  ordinaryBrackets: {
    single: [[12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [Infinity, 0.37]],
    mfj: [[24800, 0.10], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [Infinity, 0.37]],
    hoh: [[17700, 0.10], [67450, 0.12], [105700, 0.22], [201750, 0.24], [256200, 0.32], [640600, 0.35], [Infinity, 0.37]],
    mfs: [[12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [384350, 0.35], [Infinity, 0.37]],
  },

  // Long-term capital gains / qualified dividends: taxable-income thresholds
  ltcgBrackets: {
    single: [[49450, 0], [545500, 0.15], [Infinity, 0.20]],
    mfj: [[98900, 0], [613700, 0.15], [Infinity, 0.20]],
    hoh: [[66200, 0], [579600, 0.15], [Infinity, 0.20]],
    mfs: [[49450, 0], [306850, 0.15], [Infinity, 0.20]],
  },

  // Net investment income tax — thresholds are statutory and not indexed.
  niit: { rate: 0.038, threshold: { single: 200000, mfj: 250000, hoh: 200000, mfs: 125000 } },

  capitalLossOrdinaryOffset: { default: 3000, mfs: 1500 },

  contributionLimits: {
    k401: 24500,
    k401CatchUp50: 8000,
    k401CatchUp60to63: 11250,
    ira: 7500,
    iraCatchUp50: 1100,
    hsaSelf: 4400,
    hsaFamily: 8750,
    hsaCatchUp55: 1000,
  },

  // Child tax credit per qualifying child under 17 (OBBBA: $2,200, indexed after 2025)
  childTaxCredit: 2200,

  gift: { annualExclusion: 19000 },
  estate: { exemptionPerPerson: 15000000, topRate: 0.40 },
};
