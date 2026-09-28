import { db } from "./db.js";

export const LIABILITY_KINDS = new Set(["credit", "loan", "mortgage"]);
export const INVESTABLE_KINDS = new Set(["investment", "retirement", "crypto"]);

export function listAccounts({ includeHidden = false } = {}) {
  return db
    .prepare(`SELECT * FROM accounts ${includeHidden ? "" : "WHERE hidden = 0"} ORDER BY is_liability, kind, balance DESC`)
    .all();
}

export function listHoldings() {
  return db
    .prepare(
      `SELECT h.*, a.name AS account_name, a.tax_treatment, a.owner, a.kind AS account_kind
       FROM holdings h JOIN accounts a ON a.id = h.account_id
       WHERE a.hidden = 0 ORDER BY h.value DESC`,
    )
    .all();
}

const sum = (xs, f) => xs.reduce((t, x) => t + (f(x) || 0), 0);
const round = (n) => Math.round(n * 100) / 100;

function groupSum(rows, keyFn) {
  const out = {};
  for (const r of rows) out[keyFn(r)] = round((out[keyFn(r)] || 0) + r.balance);
  return out;
}

export function monthlySpending(days = 90) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS spent FROM transactions
       WHERE amount > 0 AND pending = 0 AND date >= date('now', ?)
         AND COALESCE(category, '') NOT LIKE 'TRANSFER%'
         AND COALESCE(category, '') NOT LIKE 'LOAN_PAYMENTS%'`,
    )
    .get(`-${days} days`);
  return round((row.spent / days) * 30.4);
}

export function computeOverview() {
  const accounts = listAccounts();
  const assets = accounts.filter((a) => !a.is_liability);
  const liabilities = accounts.filter((a) => a.is_liability);
  const totalAssets = round(sum(assets, (a) => a.balance));
  const totalLiabilities = round(sum(liabilities, (a) => a.balance));

  const holdings = listHoldings();
  const investable = round(sum(assets.filter((a) => INVESTABLE_KINDS.has(a.kind)), (a) => a.balance));
  const bySymbol = {};
  for (const h of holdings) {
    if (!h.symbol || h.security_type === "cash") continue;
    bySymbol[h.symbol] ??= { value: 0, security_type: h.security_type };
    bySymbol[h.symbol].value += h.value;
  }
  const concentration = Object.entries(bySymbol)
    .map(([symbol, { value, security_type }]) => ({ symbol, security_type, value: round(value), pct_of_investable: investable ? round((value / investable) * 100) : 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  return {
    as_of: new Date().toISOString(),
    net_worth: round(totalAssets - totalLiabilities),
    total_assets: totalAssets,
    total_liabilities: totalLiabilities,
    investable_assets: investable,
    liquid_cash: round(sum(assets.filter((a) => a.kind === "cash"), (a) => a.balance)),
    assets_by_kind: groupSum(assets, (a) => a.kind),
    liabilities_by_kind: groupSum(liabilities, (a) => a.kind),
    assets_by_tax_treatment: groupSum(assets.filter((a) => INVESTABLE_KINDS.has(a.kind) || a.kind === "cash"), (a) => a.tax_treatment),
    assets_by_owner: groupSum(assets, (a) => a.owner),
    top_positions: concentration,
    est_monthly_spending: monthlySpending(),
    account_count: accounts.length,
  };
}

export function recordSnapshot() {
  const o = computeOverview();
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO snapshots (date, assets, liabilities, net_worth) VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET assets = excluded.assets, liabilities = excluded.liabilities, net_worth = excluded.net_worth`,
  ).run(date, o.total_assets, o.total_liabilities, o.net_worth);
  return o;
}

export function history(days = 3650) {
  return db.prepare("SELECT * FROM snapshots WHERE date >= date('now', ?) ORDER BY date").all(`-${days} days`);
}
