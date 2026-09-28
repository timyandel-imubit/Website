import Anthropic from "@anthropic-ai/sdk";
import { db, getProfile, setProfile } from "./db.js";
import { computeOverview, listAccounts, listHoldings, history } from "./overview.js";
import { estimateTax, taxLossHarvesting, unrealizedGains, contributionRoom } from "./tax.js";
import { estateSummary } from "./estate.js";
import { generateInsights } from "./insights.js";

export const MODEL = process.env.STEWARD_MODEL || "claude-opus-5-5";
export const aiEnabled = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = aiEnabled ? new Anthropic() : null;

const SYSTEM = `You are Steward, a private wealth advisor for one household. You have tool access to their real, current financial data: linked bank, brokerage, retirement, crypto and credit accounts, plus manually tracked real estate, vehicles, collectibles and private investments. You also have deterministic calculators for federal tax and estate estimates.

How you work:
- Ground every number in a tool result. Never estimate balances, taxes or totals in your head when a tool can compute them; for "what if" questions, call estimate_tax with overrides and compare against the baseline.
- Be an advisor, not a cheerleader. Lead with what the person may be missing: the assumption that doesn't hold, the risk they haven't priced, the question they should be asking. Skip flattery.
- Tag load-bearing claims with your confidence: [certain] when it comes straight from their data or settled law, [likely] for strong inference, [guessing] when filling gaps. If most of an answer is guessing, say so up front.
- Tax and estate law changes. The calculators use a rules file that may be unverified; say so when it matters, and use web search to check current thresholds, deadlines or recent legislation before relying on a specific figure you are not sure of. Prefer irs.gov and primary sources.
- Be specific and personalized: name the accounts, positions, dollar amounts and deadlines involved. Rank ideas by expected dollar impact and note what each would cost (fees, taxes triggered, liquidity, complexity).
- You are not a licensed CPA or attorney. When an idea needs professional sign-off (entity or trust structures, gifting strategies, anything with filing requirements), say so plainly and use add_advisor_question to queue the exact question to bring to their CPA or attorney, with the context they need.
- When the person tells you a durable fact, goal or concern (family changes, income, risk tolerance, upcoming liquidity events), store it with save_memory; when they give profile inputs like income or ages, save them with update_profile so the calculators use them.
- Keep answers tight. Use short headers, bullet points and small tables when they help. No disclaimers boilerplate beyond what the situation needs.`;

const PROFILE_KEYS = [
  "filing_status", "state", "state_tax_rate", "married", "children", "self_age", "spouse_age",
  "wages", "self_employment_income", "other_ordinary_income", "interest_income", "ordinary_dividends",
  "qualified_dividends", "realized_st_gains", "realized_lt_gains", "pretax_contributions", "itemized_deductions",
  "children_under_17", "self_401k_ytd", "spouse_401k_ytd", "self_ira_ytd", "spouse_ira_ytd", "hsa_coverage", "hsa_ytd",
  "risk_tolerance", "irrevocable_trust_assets",
];

const obj = (properties, required = []) => ({ type: "object", properties, required });
const TOOLS = [
  { name: "get_overview", description: "Net worth, assets and liabilities by category, tax treatment and owner, top positions and concentration, liquid cash, and estimated monthly spending.", input_schema: obj({}) },
  { name: "list_accounts", description: "All accounts and assets with balance, kind, owner, tax treatment, beneficiary, cost basis and notes. Optionally filter by kind.", input_schema: obj({ kind: { type: "string", description: "cash|investment|retirement|crypto|credit|loan|mortgage|real_estate|vehicle|collectible|private|insurance|other" } }) },
  { name: "get_holdings", description: "Investment positions with quantity, value, cost basis and the account they sit in. Optionally filter by account_id or symbol.", input_schema: obj({ account_id: { type: "integer" }, symbol: { type: "string" } }) },
  {
    name: "query_transactions",
    description: "Search and aggregate transactions. amount > 0 is money out, < 0 is money in. Use group_by to get totals by category, merchant or month instead of raw rows.",
    input_schema: obj({
      start_date: { type: "string", description: "YYYY-MM-DD" },
      end_date: { type: "string", description: "YYYY-MM-DD" },
      category: { type: "string", description: "Plaid primary category, e.g. FOOD_AND_DRINK, TRAVEL" },
      search: { type: "string", description: "Substring match on name or merchant" },
      group_by: { type: "string", enum: ["none", "category", "merchant", "month"] },
      limit: { type: "integer" },
    }),
  },
  {
    name: "estimate_tax",
    description: "Deterministic federal (plus rough state) income tax estimate from the household profile. Pass overrides to model scenarios, e.g. {\"realized_lt_gains\": 150000} or {\"pretax_contributions\": 47000}. Returns AGI, taxable income, marginal rates, bracket headroom, 0% LTCG headroom, NIIT and caveats.",
    input_schema: obj({ overrides: { type: "object", description: "Any of: filing_status, wages, self_employment_income, other_ordinary_income, interest_income, ordinary_dividends, qualified_dividends, realized_st_gains, realized_lt_gains, pretax_contributions, itemized_deductions, children_under_17, state_tax_rate" } }),
  },
  { name: "tax_loss_harvesting", description: "Taxable positions trading below cost basis, estimated tax value, wash-sale risk across accounts, and gain-harvesting candidates if there is 0% LTCG headroom.", input_schema: obj({ min_loss: { type: "number" } }) },
  { name: "unrealized_gains", description: "Unrealized gains and losses by taxable position, split short vs long term.", input_schema: obj({}) },
  { name: "contribution_room", description: "Remaining 401(k), IRA and HSA contribution room this year per person.", input_schema: obj({}) },
  { name: "estate_summary", description: "Gross estate by spouse, federal exemption headroom, estimated estate tax, gifting capacity to children, accounts missing beneficiaries, and the estate document checklist.", input_schema: obj({}) },
  { name: "net_worth_history", description: "Daily net worth snapshots.", input_schema: obj({ days: { type: "integer" } }) },
  { name: "get_insights", description: "The rules-based findings currently shown on the dashboard.", input_schema: obj({}) },
  { name: "save_memory", description: "Remember a durable fact, goal or concern about the household for future conversations.", input_schema: obj({ text: { type: "string" } }, ["text"]) },
  { name: "update_profile", description: `Save household profile inputs used by the calculators. Allowed keys: ${PROFILE_KEYS.join(", ")}. filing_status is one of single|mfj|hoh|mfs; state_tax_rate is a decimal (0.05); children is an array of {name, age}.`, input_schema: obj({ patch: { type: "object" } }, ["patch"]) },
  { name: "add_advisor_question", description: "Queue a question for the household's CPA, estate attorney or financial planner, with enough context for the professional to answer it.", input_schema: obj({ audience: { type: "string", enum: ["cpa", "attorney", "planner"] }, question: { type: "string" }, context: { type: "string" } }, ["audience", "question"]) },
].map((t) => ({ ...t, eager_input_streaming: true }));

const SERVER_TOOLS = [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }];

function queryTransactions({ start_date, end_date, category, search, group_by = "none", limit = 100 }) {
  const where = ["1=1"], args = [];
  if (start_date) { where.push("t.date >= ?"); args.push(start_date); }
  if (end_date) { where.push("t.date <= ?"); args.push(end_date); }
  if (category) { where.push("t.category = ?"); args.push(category); }
  if (search) { where.push("(t.name LIKE ? OR t.merchant LIKE ?)"); args.push(`%${search}%`, `%${search}%`); }
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const groups = { category: "t.category", merchant: "COALESCE(t.merchant, t.name)", month: "substr(t.date, 1, 7)" };
  if (groups[group_by]) {
    return db.prepare(
      `SELECT ${groups[group_by]} AS key, ROUND(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 2) AS money_out,
              ROUND(-SUM(CASE WHEN t.amount < 0 THEN t.amount ELSE 0 END), 2) AS money_in, COUNT(*) AS count
       FROM transactions t WHERE ${where.join(" AND ")} GROUP BY key ORDER BY money_out DESC LIMIT ${lim}`,
    ).all(...args);
  }
  return db.prepare(
    `SELECT t.date, t.amount, t.name, t.merchant, t.category, a.name AS account FROM transactions t
     JOIN accounts a ON a.id = t.account_id WHERE ${where.join(" AND ")} ORDER BY t.date DESC LIMIT ${lim}`,
  ).all(...args);
}

const HANDLERS = {
  get_overview: () => computeOverview(),
  list_accounts: ({ kind }) => listAccounts().filter((a) => !kind || a.kind === kind).map(({ plaid_item_id, plaid_account_id, hidden, ...a }) => a),
  get_holdings: ({ account_id, symbol }) => listHoldings().filter((h) => (!account_id || h.account_id === account_id) && (!symbol || h.symbol === symbol)),
  query_transactions: queryTransactions,
  estimate_tax: ({ overrides }) => {
    const base = estimateTax();
    if (!overrides || !Object.keys(overrides).length) return base;
    const scenario = estimateTax(overrides);
    return { baseline: base, scenario, delta_total_tax: scenario.total_tax - base.total_tax };
  },
  tax_loss_harvesting: ({ min_loss }) => taxLossHarvesting({ min_loss: min_loss ?? 500 }),
  unrealized_gains: () => unrealizedGains(),
  contribution_room: () => contributionRoom(),
  estate_summary: () => estateSummary(),
  net_worth_history: ({ days }) => history(days || 365),
  get_insights: () => generateInsights(),
  save_memory: ({ text }) => {
    const r = db.prepare("INSERT INTO memories (text) VALUES (?)").run(String(text).slice(0, 2000));
    return { saved: true, id: Number(r.lastInsertRowid) };
  },
  update_profile: ({ patch }) => {
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => PROFILE_KEYS.includes(k)));
    const rejected = Object.keys(patch || {}).filter((k) => !PROFILE_KEYS.includes(k));
    setProfile(clean);
    return { saved: Object.keys(clean), rejected };
  },
  add_advisor_question: ({ audience, question, context }) => {
    const r = db.prepare("INSERT INTO advisor_questions (audience, question, context) VALUES (?, ?, ?)").run(audience || "cpa", String(question), context || null);
    return { queued: true, id: Number(r.lastInsertRowid) };
  },
};

function runTool(block) {
  const handler = HANDLERS[block.name];
  const input = block.input;
  if (!handler) return { content: `Unknown tool ${block.name}`, is_error: true };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { content: "INVALID_JSON: tool input must be a JSON object. Re-issue the call.", is_error: true };
  }
  const tool = TOOLS.find((t) => t.name === block.name);
  const missing = (tool.input_schema.required || []).filter((k) => input[k] == null);
  if (missing.length) return { content: `Missing required field(s): ${missing.join(", ")}`, is_error: true };
  try {
    return { content: JSON.stringify(handler(input)) };
  } catch (e) {
    return { content: `Tool error: ${e.message}`, is_error: true };
  }
}

// Snapshot injected once at the start of each conversation, so the history stays append-only.
function contextBlock() {
  const profile = getProfile();
  const memories = db.prepare("SELECT text, created_at FROM memories ORDER BY id").all();
  const o = computeOverview();
  return `<household_context as_of="${new Date().toISOString().slice(0, 10)}">
Profile: ${JSON.stringify(profile)}
Remembered: ${memories.length ? memories.map((m) => `\n- (${m.created_at.slice(0, 10)}) ${m.text}`).join("") : "nothing yet"}
Snapshot: net worth ${o.net_worth}, assets ${o.total_assets}, liabilities ${o.total_liabilities}, investable ${o.investable_assets}, cash ${o.liquid_cash}, ${o.account_count} accounts.
</household_context>`;
}

export function listConversations() {
  return db.prepare("SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 100").all();
}

// Renderable view of a stored conversation: user text and assistant text/tool activity.
export function getConversation(id) {
  const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
  if (!row) return null;
  const view = [];
  for (const m of JSON.parse(row.messages)) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const visible = text.replace(/<household_context[\s\S]*?<\/household_context>\s*/, "").trim();
      if (visible) view.push({ role: "user", text: visible });
    } else if (m.role === "assistant") {
      const last = view.at(-1)?.role === "assistant" ? view.at(-1) : (view.push({ role: "assistant", text: "", tools: [] }), view.at(-1));
      for (const b of m.content) {
        if (b.type === "text") last.text += b.text;
        else if (b.type === "tool_use" || b.type === "server_tool_use") last.tools.push(b.name);
      }
    }
  }
  return { id: row.id, title: row.title, messages: view };
}

export function deleteConversation(id) {
  db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
}

/**
 * Runs one user turn through the agentic loop, streaming events to `emit`.
 * Events: {type:"conversation", id} | {type:"text", text} | {type:"thinking", text}
 *         {type:"tool", name} | {type:"notice", text} | {type:"done"}
 */
export async function chat({ conversationId, message }, emit, signal) {
  if (!client) throw new Error("Set ANTHROPIC_API_KEY to enable the advisor.");
  let row = conversationId ? db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) : null;
  const messages = row ? JSON.parse(row.messages) : [];
  if (!row) {
    const r = db.prepare("INSERT INTO conversations (title) VALUES (?)").run(message.slice(0, 80));
    row = { id: Number(r.lastInsertRowid) };
    messages.push({ role: "user", content: [{ type: "text", text: contextBlock() }, { type: "text", text: message }] });
  } else {
    messages.push({ role: "user", content: message });
  }
  emit({ type: "conversation", id: row.id });
  const save = () => db.prepare("UPDATE conversations SET messages = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(messages), row.id);
  save();

  for (let turn = 0; turn < 25; turn++) {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 64000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
        cache_control: { type: "ephemeral" },
        system: SYSTEM,
        tools: [...TOOLS, ...SERVER_TOOLS],
        messages,
      },
      { signal },
    );
    stream.on("streamEvent", (ev) => {
      if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") emit({ type: "text", text: ev.delta.text });
        else if (ev.delta.type === "thinking_delta") emit({ type: "thinking", text: ev.delta.thinking });
      } else if (ev.type === "content_block_start" && (ev.content_block.type === "tool_use" || ev.content_block.type === "server_tool_use")) {
        emit({ type: "tool", name: ev.content_block.name });
      }
    });
    const response = await stream.finalMessage();
    messages.push({ role: "assistant", content: response.content });
    save();

    if (response.stop_reason === "refusal") { emit({ type: "notice", text: "The model declined this request." }); break; }
    if (response.stop_reason === "max_tokens") { emit({ type: "notice", text: "Response hit the length limit. Ask me to continue." }); break; }
    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason !== "tool_use") break;

    const results = response.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ type: "tool_result", tool_use_id: b.id, ...runTool(b) }));
    messages.push({ role: "user", content: results });
    save();
  }
  emit({ type: "done" });
}
