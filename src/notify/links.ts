import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * One-tap links in notifications. Each link is signed for one action on one record and expires,
 * so it works without the owner password but can't be reused for anything else.
 *
 * Format: <action>.<ref>.<expires, unix seconds>.<HMAC-SHA256, base64url>
 */

export type LinkAction = "approve" | "decline" | "plan" | "override";

export const LINK_ACTIONS: readonly LinkAction[] = ["approve", "decline", "plan", "override"];
export const LINK_TTL_MS = 24 * 60 * 60 * 1000;

export interface LinkClaim {
  action: LinkAction;
  /** A request id for approve and decline; a period id for plan; a purchase id for override (Pay anyway). */
  ref: string;
  expiresAt: Date;
}

export type LinkCheck = { ok: true; claim: LinkClaim } | { ok: false; why: "malformed" | "bad_signature" | "expired" | "wrong_action" };

const REF = /^[a-z]+_[0-9a-f]{6,32}$/;

export class LinkSigner {
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly now: () => Date = () => new Date(),
    readonly ttlMs = LINK_TTL_MS,
  ) {
    if (!secret) throw new Error("LinkSigner needs a secret.");
    this.key = Buffer.from(secret, "utf8");
  }

  /** A random secret for when REMIT_LINK_SECRET isn't set. Links signed with it die on restart. */
  static randomSecret() {
    return randomBytes(32).toString("base64url");
  }

  sign(action: LinkAction, ref: string, ttlMs = this.ttlMs): string {
    if (!REF.test(ref)) throw new Error(`Can't sign a link for "${ref}".`);
    const expires = Math.floor((this.now().getTime() + ttlMs) / 1000);
    const body = `${action}.${ref}.${expires}`;
    return `${body}.${this.mac(body)}`;
  }

  /** Checks the signature, the expiry and, when given, that the link is for this action. */
  verify(code: string, expect?: LinkAction): LinkCheck {
    const parts = code.split(".");
    if (parts.length !== 4) return { ok: false, why: "malformed" };
    const [action, ref, expires, sig] = parts as [string, string, string, string];
    if (!LINK_ACTIONS.includes(action as LinkAction) || !REF.test(ref) || !/^\d{1,12}$/.test(expires)) return { ok: false, why: "malformed" };
    const want = Buffer.from(this.mac(`${action}.${ref}.${expires}`));
    const got = Buffer.from(sig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, why: "bad_signature" };
    const expiresAt = new Date(Number(expires) * 1000);
    if (expiresAt.getTime() <= this.now().getTime()) return { ok: false, why: "expired" };
    if (expect && action !== expect) return { ok: false, why: "wrong_action" };
    return { ok: true, claim: { action: action as LinkAction, ref, expiresAt } };
  }

  private mac(body: string) {
    return createHmac("sha256", this.key).update(`remit-link:v1:${body}`).digest("base64url");
  }
}
