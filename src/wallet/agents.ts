import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { newId, type Db } from "../db.ts";
import { WalletError } from "./wallet.ts";

/**
 * The agent registry: which agents may call the wallet, by token, and whether they are paused.
 * The wallet asks it before every money call; the agent API asks it to turn a token into an agent.
 */

/** The shared REMIT_AGENT_TOKEN from .env. Keeps the README's MCP setup working. */
export const DEFAULT_AGENT_ID = "default";
/** Remit's own shopping agent, which runs in the server and needs no token. */
export const BUILTIN_AGENT_ID = "remit";

export type AgentStatus = "active" | "paused" | "revoked";

export interface AgentRecord {
  id: string;
  name: string;
  status: AgentStatus;
  builtin: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  token_hash: string | null;
  status: AgentStatus;
  builtin: number;
  created_at: string;
  last_used_at: string | null;
}

const TOKEN_PREFIX = "remit_agt_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Before the registry, purchases recorded "mcp" for the shared token. Same agent as "default". */
export function normalizeAgentId(id: string): string {
  return id === "mcp" ? DEFAULT_AGENT_ID : id;
}

/**
 * The agent behind an Authorization header ("Bearer <token>"), or null. This is the one place a
 * token becomes an agent: the shared REMIT_AGENT_TOKEN is the built-in "default" agent, and any
 * other token is looked up by its hash. Revoked agents have no token, so they don't resolve.
 * Paused agents do: they can still read, and the wallet refuses their money calls.
 */
export function agentFromAuthHeader(registry: AgentRegistry, header: string | undefined, sharedToken?: string): AgentRecord | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match ? registry.resolveToken(match[1], sharedToken) : null;
}

export class AgentRegistry {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {
    const insert = db.prepare("INSERT OR IGNORE INTO agents (id, name, status, builtin, created_at) VALUES (?, ?, 'active', 1, ?)");
    insert.run(BUILTIN_AGENT_ID, "Remit’s shopping agent", this.iso());
    insert.run(DEFAULT_AGENT_ID, "Shared token (REMIT_AGENT_TOKEN)", this.iso());
    db.prepare("UPDATE purchases SET agent = ? WHERE agent = 'mcp'").run(DEFAULT_AGENT_ID);
  }

  resolveToken(token: string, sharedToken?: string): AgentRecord | null {
    if (!token) return null;
    const row =
      sharedToken && sameSecret(token, sharedToken)
        ? this.row(DEFAULT_AGENT_ID)
        : (this.db.prepare("SELECT * FROM agents WHERE token_hash = ? AND status != 'revoked'").get(hashToken(token)) as unknown as AgentRow | undefined);
    if (!row) return null;
    this.db.prepare("UPDATE agents SET last_used_at = ? WHERE id = ?").run(this.iso(), row.id);
    return toRecord({ ...row, last_used_at: this.iso() });
  }

  get(id: string): AgentRecord | null {
    const row = this.row(normalizeAgentId(id));
    return row ? toRecord(row) : null;
  }

  /** A short name for the activity feed and refusal messages. */
  label(id: string): string {
    return this.get(id)?.name ?? id;
  }

  /** Why this agent may not move money right now, or null if it may. */
  blocked(id: string): { code: string; message: string } | null {
    const agent = this.get(id);
    if (!agent) return { code: "UNKNOWN_AGENT", message: `The wallet doesn't know an agent "${id}".` };
    if (agent.status === "paused") {
      return {
        code: "AGENT_PAUSED",
        message: `The owner has paused ${agent.name}. You can still check the balance and history, but you can't spend or ask for money until the owner resumes you in the Remit app.`,
      };
    }
    if (agent.status === "revoked") return { code: "AGENT_REVOKED", message: `The owner revoked ${agent.name}. It can't use the wallet.` };
    return null;
  }

  /** Every agent that isn't revoked, built-ins first, with what it spent in the given period. */
  list(periodId?: string) {
    const rows = this.db.prepare("SELECT * FROM agents WHERE status != 'revoked' ORDER BY builtin DESC, created_at").all() as unknown as AgentRow[];
    const spent = this.db.prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM purchases WHERE period_id = ? AND agent = ? AND status IN ('captured','refunded')",
    );
    const refused = this.db.prepare("SELECT COUNT(*) AS n FROM purchases WHERE period_id = ? AND agent = ? AND status = 'refused'");
    const lines = this.db.prepare("SELECT COUNT(*) AS n FROM envelopes WHERE period_id = ? AND agent_id = ?");
    return rows.map((row) => ({
      ...toRecord(row),
      spentCents: periodId ? (spent.get(periodId, row.id) as { n: number }).n : 0,
      refusedCount: periodId ? (refused.get(periodId, row.id) as { n: number }).n : 0,
      lineCount: periodId ? (lines.get(periodId, row.id) as { n: number }).n : 0,
    }));
  }

  /** Owner only. Returns the token once; only its hash is stored. */
  create(name: string) {
    const clean = name.trim();
    if (!clean) throw new WalletError("MISSING", "Give the agent a name.");
    if (clean.length > 60) throw new WalletError("TOO_LONG", "The name must be at most 60 characters.");
    const id = newId("agt");
    const token = `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
    this.db
      .prepare("INSERT INTO agents (id, name, token_hash, status, builtin, created_at) VALUES (?, ?, ?, 'active', 0, ?)")
      .run(id, clean, hashToken(token), this.iso());
    return { agent: this.get(id)!, token };
  }

  /** Owner only: pause or resume. A paused agent can read but not spend or ask for money. */
  setStatus(id: string, status: "active" | "paused") {
    const agent = this.require(id);
    if (agent.status === "revoked") throw new WalletError("AGENT_REVOKED", `${agent.name} was revoked. Add a new agent instead.`);
    this.db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, agent.id);
    return this.get(agent.id)!;
  }

  /** Owner only: the token stops working for good. The agent's past purchases stay in the ledger. */
  revoke(id: string) {
    const agent = this.require(id);
    if (agent.builtin) {
      throw new WalletError(
        "BUILTIN_AGENT",
        agent.id === DEFAULT_AGENT_ID
          ? "The shared token comes from REMIT_AGENT_TOKEN. Pause it here, or remove it from .env and restart."
          : "The built-in agent can't be revoked. Pause it instead.",
      );
    }
    this.db.prepare("UPDATE agents SET status = 'revoked', token_hash = NULL WHERE id = ?").run(agent.id);
    return this.get(agent.id)!;
  }

  private require(id: string): AgentRecord {
    const agent = this.get(id);
    if (!agent) throw new WalletError("NOT_FOUND", "No such agent.", 404);
    return agent;
  }

  private row(id: string) {
    return this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as unknown as AgentRow | undefined;
  }

  private iso() {
    return this.now().toISOString();
  }
}

function toRecord(row: AgentRow): AgentRecord {
  return { id: row.id, name: row.name, status: row.status, builtin: !!row.builtin, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}

/** Compare two secrets without leaking where they differ. */
function sameSecret(a: string, b: string) {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
