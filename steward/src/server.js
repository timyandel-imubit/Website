import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, getProfile, setProfile } from "./db.js";
import { computeOverview, listAccounts, listHoldings, history, recordSnapshot, LIABILITY_KINDS } from "./overview.js";
import { estimateTax, taxLossHarvesting, unrealizedGains, contributionRoom } from "./tax.js";
import { estateSummary, listEstateDocs, CORE_DOCS } from "./estate.js";
import { generateInsights } from "./insights.js";
import * as plaid from "./plaid.js";
import * as ai from "./ai.js";
import rules from "./rules/2026.js";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4100);
const PASSWORD = process.env.STEWARD_PASSWORD;
const LOOPBACK = ["127.0.0.1", "localhost", "::1"].includes(HOST);
if (!LOOPBACK && !PASSWORD) {
  console.error(`Refusing to listen on ${HOST} without STEWARD_PASSWORD set. Your financial data would be exposed.`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

if (PASSWORD) {
  const expected = Buffer.from(PASSWORD);
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || "").split(" ");
    const given = scheme === "Basic" && encoded ? Buffer.from(Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":")) : Buffer.alloc(0);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.set("WWW-Authenticate", 'Basic realm="Steward"').status(401).send("Authentication required");
  });
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
app.use(express.static(path.join(ROOT, "public")));
// Front-end libraries are served locally so no third-party CDN sees your usage (Plaid Link is the exception).
const vendor = { "chart.js": "chart.js/dist/chart.umd.min.js", "marked.js": "marked/lib/marked.umd.js", "purify.js": "dompurify/dist/purify.min.js" };
for (const [name, file] of Object.entries(vendor)) app.get(`/vendor/${name}`, (req, res) => res.sendFile(path.join(ROOT, "node_modules", file)));

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
  }
};

const ACCOUNT_FIELDS = ["institution", "name", "kind", "subtype", "balance", "tax_treatment", "owner", "beneficiary", "cost_basis", "acquired_date", "death_benefit", "notes", "hidden"];
const pick = (body, fields) => Object.fromEntries(fields.filter((f) => body[f] !== undefined).map((f) => [f, body[f] === "" ? null : body[f]]));

// ---- status & overview
app.get("/api/status", wrap(() => ({
  plaid: plaid.plaidEnabled, plaid_env: process.env.PLAID_ENV || "sandbox",
  ai: ai.aiEnabled, model: ai.MODEL, rules_year: rules.year, rules_verified: rules.verified,
})));
app.get("/api/overview", wrap(() => computeOverview()));
app.get("/api/history", wrap((req) => history(Number(req.query.days) || 3650)));
app.get("/api/insights", wrap(() => generateInsights()));

// ---- accounts & holdings
app.get("/api/accounts", wrap(() => listAccounts({ includeHidden: true })));
app.post("/api/accounts", wrap((req) => {
  const a = pick(req.body, ACCOUNT_FIELDS);
  if (!a.name || !a.kind) throw Object.assign(new Error("name and kind are required"), { status: 400 });
  const cols = Object.keys(a).concat("is_liability");
  const r = db.prepare(`INSERT INTO accounts (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .run(...Object.values(a), LIABILITY_KINDS.has(a.kind) ? 1 : 0);
  recordSnapshot();
  return { id: Number(r.lastInsertRowid) };
}));
app.patch("/api/accounts/:id", wrap((req) => {
  const a = pick(req.body, ACCOUNT_FIELDS);
  if (!Object.keys(a).length) return { ok: true };
  if (a.kind) a.is_liability = LIABILITY_KINDS.has(a.kind) ? 1 : 0;
  const touchesValue = "balance" in a;
  db.prepare(`UPDATE accounts SET ${Object.keys(a).map((k) => `${k} = ?`).join(", ")}${touchesValue ? ", updated_at = datetime('now')" : ""} WHERE id = ?`)
    .run(...Object.values(a), Number(req.params.id));
  recordSnapshot();
  return { ok: true };
}));
app.delete("/api/accounts/:id", wrap((req) => {
  const acct = db.prepare("SELECT source FROM accounts WHERE id = ?").get(Number(req.params.id));
  if (acct?.source === "plaid") throw Object.assign(new Error("Linked accounts are removed by unlinking the institution (or hide the account instead)."), { status: 400 });
  db.prepare("DELETE FROM accounts WHERE id = ?").run(Number(req.params.id));
  recordSnapshot();
  return { ok: true };
}));
app.get("/api/holdings", wrap(() => listHoldings()));
app.post("/api/holdings", wrap((req) => {
  const { account_id, symbol, name, quantity, price, cost_basis, acquired_date, security_type } = req.body;
  const value = Number(quantity) * Number(price);
  const r = db.prepare("INSERT INTO holdings (account_id, symbol, name, security_type, quantity, price, value, cost_basis, acquired_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(Number(account_id), symbol || null, name || null, security_type || null, Number(quantity), Number(price), value, cost_basis === "" || cost_basis == null ? null : Number(cost_basis), acquired_date || null);
  return { id: Number(r.lastInsertRowid) };
}));
app.patch("/api/holdings/:id", wrap((req) => {
  const h = pick(req.body, ["cost_basis", "acquired_date"]);
  if (Object.keys(h).length) db.prepare(`UPDATE holdings SET ${Object.keys(h).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(h), Number(req.params.id));
  return { ok: true };
}));
app.delete("/api/holdings/:id", wrap((req) => { db.prepare("DELETE FROM holdings WHERE id = ?").run(Number(req.params.id)); return { ok: true }; }));

// ---- plaid
app.post("/api/plaid/link-token", wrap(async (req) => ({ link_token: await plaid.createLinkToken(req.body?.mode) })));
app.post("/api/plaid/exchange", wrap(async (req) => ({ item_id: await plaid.exchangePublicToken(req.body.public_token, req.body.institution) })));
app.get("/api/plaid/items", wrap(() => plaid.listItems()));
app.delete("/api/plaid/items/:id", wrap(async (req) => { await plaid.removeItem(req.params.id); recordSnapshot(); return { ok: true }; }));
app.post("/api/sync", wrap(async () => ({ results: await plaid.syncAll() })));

// ---- tax & estate
app.get("/api/tax", wrap(() => ({ estimate: estimateTax(), harvesting: taxLossHarvesting(), gains: unrealizedGains(), room: contributionRoom() })));
app.post("/api/tax/scenario", wrap((req) => {
  const base = estimateTax(), scenario = estimateTax(req.body || {});
  return { baseline: base, scenario, delta_total_tax: scenario.total_tax - base.total_tax };
}));
app.get("/api/estate", wrap(() => ({ summary: estateSummary(), docs: listEstateDocs(), doc_types: CORE_DOCS.concat({ doc_type: "guardianship", label: "Guardian nomination" }) })));
app.post("/api/estate/docs", wrap((req) => {
  const { doc_type, person = "joint", status = "signed", last_reviewed, location, notes } = req.body;
  const r = db.prepare("INSERT INTO estate_docs (doc_type, person, status, last_reviewed, location, notes) VALUES (?, ?, ?, ?, ?, ?)")
    .run(doc_type, person, status, last_reviewed || null, location || null, notes || null);
  return { id: Number(r.lastInsertRowid) };
}));
app.delete("/api/estate/docs/:id", wrap((req) => { db.prepare("DELETE FROM estate_docs WHERE id = ?").run(Number(req.params.id)); return { ok: true }; }));

// ---- profile, memory, advisor questions
app.get("/api/profile", wrap(() => getProfile()));
app.put("/api/profile", wrap((req) => { setProfile(req.body || {}); return getProfile(); }));
app.get("/api/memories", wrap(() => db.prepare("SELECT * FROM memories ORDER BY id DESC").all()));
app.post("/api/memories", wrap((req) => ({ id: Number(db.prepare("INSERT INTO memories (text) VALUES (?)").run(String(req.body.text)).lastInsertRowid) })));
app.delete("/api/memories/:id", wrap((req) => { db.prepare("DELETE FROM memories WHERE id = ?").run(Number(req.params.id)); return { ok: true }; }));
app.get("/api/questions", wrap(() => db.prepare("SELECT * FROM advisor_questions ORDER BY status = 'done', id DESC").all()));
app.patch("/api/questions/:id", wrap((req) => { db.prepare("UPDATE advisor_questions SET status = ? WHERE id = ?").run(req.body.status === "done" ? "done" : "open", Number(req.params.id)); return { ok: true }; }));
app.delete("/api/questions/:id", wrap((req) => { db.prepare("DELETE FROM advisor_questions WHERE id = ?").run(Number(req.params.id)); return { ok: true }; }));

// ---- advisor chat (server-sent events over a POST response)
app.get("/api/conversations", wrap(() => ai.listConversations()));
app.get("/api/conversations/:id", wrap((req) => ai.getConversation(Number(req.params.id)) || Promise.reject(Object.assign(new Error("Not found"), { status: 404 }))));
app.delete("/api/conversations/:id", wrap((req) => { ai.deleteConversation(Number(req.params.id)); return { ok: true }; }));
app.post("/api/chat", async (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const emit = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  try {
    await ai.chat({ conversationId: req.body.conversation_id, message: String(req.body.message || "") }, emit, controller.signal);
  } catch (e) {
    if (!controller.signal.aborted) { console.error(e); emit({ type: "error", text: e.message }); }
  }
  res.end();
});

// ---- export everything you own (minus Plaid credentials)
app.get("/api/export", wrap((req, res) => {
  const dump = {};
  for (const t of ["accounts", "holdings", "transactions", "snapshots", "profile", "memories", "estate_docs", "advisor_questions", "conversations"]) {
    dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
  }
  res.set("Content-Disposition", `attachment; filename="steward-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(dump);
}));

app.listen(PORT, HOST, () => {
  console.log(`Steward running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`  AI advisor: ${ai.aiEnabled ? ai.MODEL : "off (set ANTHROPIC_API_KEY)"}  |  Plaid: ${plaid.plaidEnabled ? process.env.PLAID_ENV || "sandbox" : "off (manual accounts only)"}`);
  recordSnapshot();
});

// Refresh linked accounts and take a net-worth snapshot every 6 hours.
setInterval(() => plaid.syncAll().catch((e) => console.error("Scheduled sync failed:", e.message)), 6 * 3600 * 1000).unref();
