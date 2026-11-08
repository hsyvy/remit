import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA = `
-- One budget period at a time: pending (awaiting approval) -> open -> closed, or declined.
CREATE TABLE IF NOT EXISTS periods (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'live',
  created_at TEXT NOT NULL,
  closed_at TEXT
);

-- A budget request or a top-up, written by the agent and decided by the owner.
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES periods(id),
  kind TEXT NOT NULL,              -- budget | topup
  status TEXT NOT NULL,            -- pending | checkout | approved | declined | expired
  reason TEXT NOT NULL,
  paypal_order_id TEXT,
  approval_check TEXT,             -- JSON: what PayPal last said about an order the owner didn't finish approving
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS request_lines (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  line_key TEXT NOT NULL,
  label TEXT NOT NULL,
  reason TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,   -- as the agent asked
  approved_cents INTEGER,          -- as the owner sent to PayPal; 0 means removed
  position INTEGER NOT NULL
);

-- An approved plan line. Spending is checked against these.
CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES periods(id),
  line_key TEXT NOT NULL,
  label TEXT NOT NULL,
  reason TEXT NOT NULL,
  limit_cents INTEGER NOT NULL,
  UNIQUE (period_id, line_key)
);

-- A PayPal authorization. The money stays the owner's until captured.
CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES periods(id),
  request_id TEXT NOT NULL REFERENCES requests(id),
  authorization_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  captured_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,            -- active | captured | voided | lapsing
  authorized_at TEXT NOT NULL,
  honor_until TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reauthorized INTEGER NOT NULL DEFAULT 0,
  release_note TEXT
);

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES periods(id),
  envelope_id TEXT REFERENCES envelopes(id),
  line_key TEXT NOT NULL,
  status TEXT NOT NULL,            -- pending | captured | refused | failed | refunded
  amount_cents INTEGER NOT NULL,
  from_line_cents INTEGER NOT NULL DEFAULT 0,
  from_buffer_cents INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  merchant TEXT NOT NULL,
  url TEXT,
  reasoning TEXT NOT NULL,
  agent TEXT NOT NULL,             -- which agent asked: remit | mcp
  refusal TEXT,
  review TEXT,                     -- JSON from the purpose check
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchases(id),
  hold_id TEXT NOT NULL REFERENCES holds(id),
  capture_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  final INTEGER NOT NULL,
  refund_id TEXT,
  from_line_cents INTEGER,         -- how much of this capture paid the purchase's line; NULL before funding was tracked
  from_buffer_cents INTEGER,       -- and how much paid the buffer part
  created_at TEXT NOT NULL
);

-- How much of a line's limit each hold funded. The budget hold funds the plan's lines and buffer,
-- a top-up hold funds its line, and a move between lines moves funding with the limit.
-- Lines with less funding here than their limit (rows from before this table) count the rest as the budget hold's.
CREATE TABLE IF NOT EXISTS line_funding (
  period_id TEXT NOT NULL REFERENCES periods(id),
  envelope_id TEXT NOT NULL REFERENCES envelopes(id),
  hold_id TEXT NOT NULL REFERENCES holds(id),
  cents INTEGER NOT NULL,
  PRIMARY KEY (envelope_id, hold_id)
);

-- The owner moving unspent money from one line to another. Total and holds don't change.
CREATE TABLE IF NOT EXISTS line_moves (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES periods(id),
  from_line_key TEXT NOT NULL,
  to_line_key TEXT NOT NULL,
  cents INTEGER NOT NULL,
  who TEXT NOT NULL,               -- owner
  created_at TEXT NOT NULL
);

-- Human-readable activity feed for the ledger.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The agent's conversation, append-only, stored exactly as the API returned it.
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Agents that can call the wallet. Only a hash of each token is kept; the owner sees the token once.
-- "default" (the shared REMIT_AGENT_TOKEN) and "remit" (the built-in shopping agent) are built in and have no stored token.
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE,          -- sha256 hex; NULL for built-ins and revoked agents
  status TEXT NOT NULL,            -- active | paused | revoked
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

-- State for the simulated PayPal used when no sandbox credentials are set.
CREATE TABLE IF NOT EXISTS sim_paypal (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- order | authorization | capture
  data TEXT NOT NULL
);
`;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  // Columns added after the first release. CREATE TABLE IF NOT EXISTS doesn't add them to an existing database.
  addColumn(db, "requests", "approval_check", "TEXT");
  // Which agent asked, and which agent a line belongs to. NULL: from before agents, usable by any agent.
  addColumn(db, "requests", "agent_id", "TEXT");
  addColumn(db, "envelopes", "agent_id", "TEXT");
  addColumn(db, "captures", "from_line_cents", "INTEGER");
  addColumn(db, "captures", "from_buffer_cents", "INTEGER");
  return db;
}

function addColumn(db: Db, table: string, column: string, type: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
