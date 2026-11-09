import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The owner's sign-in: a password form that sets a signed, HttpOnly cookie, in place of the browser's Basic Auth prompt.
 *
 * Cookie value: v1.<expires, unix seconds>.<HMAC-SHA256, base64url>
 * The key mixes in the owner password, so changing REMIT_OWNER_PASSWORD signs everyone out.
 */

export const SESSION_COOKIE = "remit_session";
export const SESSION_TTL_S = 30 * 24 * 60 * 60;

export class OwnerSessions {
  private readonly key: Buffer;
  private readonly passwordHash: Buffer;

  constructor(
    secret: string,
    password: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!secret || !password) throw new Error("OwnerSessions needs a secret and a password.");
    this.key = createHmac("sha256", secret).update(`owner-session:${password}`).digest();
    this.passwordHash = sha256(password);
  }

  /** Constant-time, whatever the lengths. */
  checkPassword(input: string) {
    return timingSafeEqual(sha256(input), this.passwordHash);
  }

  issue() {
    const body = `v1.${Math.floor(this.now() / 1000) + SESSION_TTL_S}`;
    return `${body}.${this.mac(body)}`;
  }

  verify(token: string | undefined) {
    if (!token) return false;
    const match = /^(v1\.(\d{1,12}))\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) return false;
    const [, body, expires, mac] = match;
    const expected = Buffer.from(this.mac(body!), "base64url");
    const given = Buffer.from(mac!, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    return Number(expires) * 1000 > this.now();
  }

  private mac(body: string) {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }
}

/** Slows down password guessing: after `max` failures from one address in `windowMs`, refuse until the window passes. */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  blocked(who: string) {
    return this.recent(who).length >= this.max;
  }

  fail(who: string) {
    const list = this.recent(who);
    list.push(this.now());
    this.failures.set(who, list);
    // Keep the map from growing without bound under a spray of addresses.
    if (this.failures.size > 10_000) for (const key of this.failures.keys()) if (!this.recent(key).length) this.failures.delete(key);
  }

  clear(who: string) {
    this.failures.delete(who);
  }

  private recent(who: string) {
    const since = this.now() - this.windowMs;
    return (this.failures.get(who) ?? []).filter((t) => t > since);
  }
}

/** Where to go after signing in: a path on this site only, never another host. */
export function safeNext(next: string | undefined | null, fallback = "/app") {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(next)) return fallback;
  return next;
}

function sha256(text: string) {
  return createHash("sha256").update(text, "utf8").digest();
}
