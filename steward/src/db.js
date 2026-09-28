import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.resolve(process.env.STEWARD_DATA_DIR || "./data");
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

export const db = new DatabaseSync(path.join(DATA_DIR, "steward.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS plaid_items (
  item_id TEXT PRIMARY KEY,
  access_token_enc TEXT NOT NULL,
  institution TEXT,
  tx_cursor TEXT,
  last_synced TEXT,
  last_error TEXT
);

-- One row per account or asset, whether linked through Plaid or entered by hand.
-- kind: cash | investment | retirement | crypto | credit | loan | mortgage |
--       real_estate | vehicle | collectible | private | insurance | other
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'manual',
  plaid_item_id TEXT REFERENCES plaid_items(item_id) ON DELETE CASCADE,
  plaid_account_id TEXT UNIQUE,
  institution TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  subtype TEXT,
  mask TEXT,
  balance REAL NOT NULL DEFAULT 0,
  is_liability INTEGER NOT NULL DEFAULT 0,
  tax_treatment TEXT NOT NULL DEFAULT 'taxable',  -- taxable | tax_deferred | tax_free | hsa
  owner TEXT NOT NULL DEFAULT 'joint',            -- self | spouse | joint | trust | child
  beneficiary TEXT,
  cost_basis REAL,
  acquired_date TEXT,
  death_benefit REAL,                             -- life insurance: counts toward the estate
  notes TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol TEXT,
  name TEXT,
  security_type TEXT,
  quantity REAL NOT NULL DEFAULT 0,
  price REAL,
  value REAL NOT NULL DEFAULT 0,
  cost_basis REAL,
  acquired_date TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,          -- positive = money out, negative = money in (Plaid convention)
  name TEXT,
  merchant TEXT,
  category TEXT,
  pending INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tx_date ON transactions(date);

CREATE TABLE IF NOT EXISTS snapshots (
  date TEXT PRIMARY KEY,
  assets REAL NOT NULL,
  liabilities REAL NOT NULL,
  net_worth REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS profile (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Things the advisor should always remember (goals, concerns, family facts).
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Estate documents and their review status.
CREATE TABLE IF NOT EXISTS estate_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL,
  person TEXT NOT NULL DEFAULT 'joint',
  status TEXT NOT NULL DEFAULT 'missing',          -- missing | draft | signed
  last_reviewed TEXT,
  location TEXT,
  notes TEXT
);

-- Questions the advisor wants you to put to your CPA / attorney.
CREATE TABLE IF NOT EXISTS advisor_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audience TEXT NOT NULL DEFAULT 'cpa',           -- cpa | attorney | planner
  question TEXT NOT NULL,
  context TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  messages TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Additive migrations for databases created by earlier versions.
const accountCols = new Set(db.prepare("PRAGMA table_info(accounts)").all().map((c) => c.name));
if (!accountCols.has("death_benefit")) db.exec("ALTER TABLE accounts ADD COLUMN death_benefit REAL");

export function getProfile() {
  const rows = db.prepare("SELECT key, value FROM profile").all();
  const out = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

export function setProfile(patch) {
  const stmt = db.prepare(
    "INSERT INTO profile (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v));
}

export function tx(fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
