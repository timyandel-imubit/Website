import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
import { db, tx } from "./db.js";
import { encrypt, decrypt } from "./secrets.js";
import { recordSnapshot } from "./overview.js";

export const plaidEnabled = Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);

const client = plaidEnabled
  ? new PlaidApi(
      new Configuration({
        basePath: PlaidEnvironments[process.env.PLAID_ENV || "sandbox"],
        baseOptions: { headers: { "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID, "PLAID-SECRET": process.env.PLAID_SECRET } },
      }),
    )
  : null;

function requirePlaid() {
  if (!client) throw Object.assign(new Error("Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET."), { status: 400 });
}

const TAX_FREE = /roth/i;
const RETIREMENT = /401|403|457|ira|pension|keogh|retirement|tsp|hsa|profit sharing|thrift/i;

function classify(acct) {
  const sub = acct.subtype || "";
  switch (acct.type) {
    case "depository": return { kind: "cash", is_liability: 0, tax_treatment: sub === "hsa" ? "hsa" : "taxable" };
    case "credit": return { kind: "credit", is_liability: 1, tax_treatment: "taxable" };
    case "loan": return { kind: sub === "mortgage" || sub === "home equity" ? "mortgage" : "loan", is_liability: 1, tax_treatment: "taxable" };
    case "investment": {
      if (sub === "crypto exchange") return { kind: "crypto", is_liability: 0, tax_treatment: "taxable" };
      if (sub === "hsa") return { kind: "retirement", is_liability: 0, tax_treatment: "hsa" };
      if (RETIREMENT.test(sub)) return { kind: "retirement", is_liability: 0, tax_treatment: TAX_FREE.test(sub) ? "tax_free" : "tax_deferred" };
      return { kind: "investment", is_liability: 0, tax_treatment: "taxable" };
    }
    default: return { kind: "other", is_liability: 0, tax_treatment: "taxable" };
  }
}

export async function createLinkToken(mode = "banking") {
  requirePlaid();
  const investing = mode === "investing";
  const res = await client.linkTokenCreate({
    user: { client_user_id: "steward-owner" },
    client_name: "Steward",
    language: "en",
    country_codes: [CountryCode.Us],
    products: [investing ? Products.Investments : Products.Transactions],
    optional_products: investing ? [Products.Transactions] : [Products.Liabilities, Products.Investments],
  });
  return res.data.link_token;
}

export async function exchangePublicToken(publicToken, institution) {
  requirePlaid();
  const res = await client.itemPublicTokenExchange({ public_token: publicToken });
  db.prepare("INSERT OR REPLACE INTO plaid_items (item_id, access_token_enc, institution) VALUES (?, ?, ?)")
    .run(res.data.item_id, encrypt(res.data.access_token), institution || null);
  await syncItem(res.data.item_id);
  return res.data.item_id;
}

function upsertAccounts(itemId, institution, accounts) {
  const find = db.prepare("SELECT id FROM accounts WHERE plaid_account_id = ?");
  const insert = db.prepare(
    `INSERT INTO accounts (source, plaid_item_id, plaid_account_id, institution, name, kind, subtype, mask, balance, is_liability, tax_treatment)
     VALUES ('plaid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Only balances refresh on sync; your edits to kind/owner/beneficiary/tax treatment are kept.
  const update = db.prepare("UPDATE accounts SET balance = ?, updated_at = datetime('now') WHERE id = ?");
  const ids = {};
  for (const a of accounts) {
    const c = classify(a);
    const balance = a.balances.current ?? a.balances.available ?? 0;
    const existing = find.get(a.account_id);
    if (existing) { update.run(balance, existing.id); ids[a.account_id] = existing.id; }
    else {
      const r = insert.run(itemId, a.account_id, institution, a.official_name || a.name, c.kind, a.subtype || null, a.mask || null, balance, c.is_liability, c.tax_treatment);
      ids[a.account_id] = Number(r.lastInsertRowid);
    }
  }
  return ids;
}

export async function syncItem(itemId) {
  requirePlaid();
  const item = db.prepare("SELECT * FROM plaid_items WHERE item_id = ?").get(itemId);
  const accessToken = decrypt(item.access_token_enc);
  try {
    const bal = await client.accountsBalanceGet({ access_token: accessToken });
    const ids = tx(() => upsertAccounts(itemId, item.institution, bal.data.accounts));

    // Holdings (not every institution supports investments)
    try {
      const h = await client.investmentsHoldingsGet({ access_token: accessToken });
      const securities = Object.fromEntries(h.data.securities.map((s) => [s.security_id, s]));
      tx(() => {
        const accountIds = [...new Set(h.data.holdings.map((x) => ids[x.account_id]).filter(Boolean))];
        for (const id of accountIds) db.prepare("DELETE FROM holdings WHERE account_id = ?").run(id);
        const ins = db.prepare("INSERT INTO holdings (account_id, symbol, name, security_type, quantity, price, value, cost_basis) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        for (const x of h.data.holdings) {
          const s = securities[x.security_id] || {};
          if (!ids[x.account_id]) continue;
          ins.run(ids[x.account_id], s.ticker_symbol || null, s.name || null, s.is_cash_equivalent ? "cash" : s.type || null, x.quantity, x.institution_price, x.institution_value, x.cost_basis);
        }
      });
    } catch (e) {
      if (!/PRODUCTS_NOT_SUPPORTED|PRODUCT_NOT_READY|NO_INVESTMENT_ACCOUNTS|ADDITIONAL_CONSENT_REQUIRED|INVALID_PRODUCT/.test(e.response?.data?.error_code || "")) throw e;
    }

    // Transactions (cursor-based incremental sync)
    try {
      let cursor = item.tx_cursor || undefined, hasMore = true;
      while (hasMore) {
        const r = await client.transactionsSync({ access_token: accessToken, cursor, count: 500 });
        tx(() => {
          const up = db.prepare(
            `INSERT INTO transactions (id, account_id, date, amount, name, merchant, category, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET date = excluded.date, amount = excluded.amount, name = excluded.name,
               merchant = excluded.merchant, category = excluded.category, pending = excluded.pending`,
          );
          for (const t of [...r.data.added, ...r.data.modified]) {
            if (!ids[t.account_id]) continue;
            up.run(t.transaction_id, ids[t.account_id], t.date, t.amount, t.name, t.merchant_name || null, t.personal_finance_category?.primary || null, t.pending ? 1 : 0);
          }
          for (const t of r.data.removed) db.prepare("DELETE FROM transactions WHERE id = ?").run(t.transaction_id);
        });
        cursor = r.data.next_cursor;
        hasMore = r.data.has_more;
      }
      db.prepare("UPDATE plaid_items SET tx_cursor = ? WHERE item_id = ?").run(cursor, itemId);
    } catch (e) {
      if (!/PRODUCTS_NOT_SUPPORTED|PRODUCT_NOT_READY|ADDITIONAL_CONSENT_REQUIRED|INVALID_PRODUCT/.test(e.response?.data?.error_code || "")) throw e;
    }

    db.prepare("UPDATE plaid_items SET last_synced = datetime('now'), last_error = NULL WHERE item_id = ?").run(itemId);
  } catch (e) {
    const msg = e.response?.data?.error_message || e.message;
    db.prepare("UPDATE plaid_items SET last_error = ? WHERE item_id = ?").run(msg, itemId);
    throw new Error(`Sync failed for ${item.institution || itemId}: ${msg}`);
  }
}

export async function syncAll() {
  const results = [];
  if (plaidEnabled) {
    for (const { item_id } of db.prepare("SELECT item_id FROM plaid_items").all()) {
      try { await syncItem(item_id); results.push({ item_id, ok: true }); }
      catch (e) { results.push({ item_id, ok: false, error: e.message }); }
    }
  }
  recordSnapshot();
  return results;
}

export async function removeItem(itemId) {
  requirePlaid();
  const item = db.prepare("SELECT * FROM plaid_items WHERE item_id = ?").get(itemId);
  if (!item) return;
  try { await client.itemRemove({ access_token: decrypt(item.access_token_enc) }); } catch { /* already revoked */ }
  db.prepare("DELETE FROM plaid_items WHERE item_id = ?").run(itemId);
}

export function listItems() {
  return db.prepare("SELECT item_id, institution, last_synced, last_error FROM plaid_items").all();
}
