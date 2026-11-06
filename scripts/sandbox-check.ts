import { createInterface } from "node:readline/promises";
import { config, paypalMode } from "../src/config.ts";
import { PayPalError } from "../src/paypal/gateway.ts";
import { RestPayPal } from "../src/paypal/rest.ts";

/**
 * Day-1 check from the brief: does the PayPal sandbox behave the way the hold model needs?
 *   1. Authorize $30, capture $10 and $5 partially, then try to void the rest (risk 2).
 *   2. Capture with final_capture: true and see that the rest is closed.
 *   3. Authorize $20 and void it with nothing captured.
 * You approve each order in the browser with your sandbox personal (buyer) account.
 *
 *   npm run sandbox-check
 */

if (paypalMode !== "sandbox") {
  console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first (sandbox app credentials).");
  process.exit(1);
}

const paypal = new RestPayPal({ ...config.paypal, currency: config.currency });
const rl = createInterface({ input: process.stdin, output: process.stdout });
const results: [string, string][] = [];

async function step(name: string, fn: () => Promise<string>) {
  try {
    const outcome = await fn();
    results.push([name, `ok: ${outcome}`]);
    console.log(`  ✓ ${name}: ${outcome}`);
  } catch (err) {
    const text = err instanceof PayPalError ? `${err.issue ?? err.status}: ${err.message}` : String(err);
    results.push([name, `refused: ${text}`]);
    console.log(`  ✗ ${name}: ${text}`);
  }
}

async function approvedOrder(cents: number, label: string) {
  const { orderId, approveUrl } = await paypal.createAuthorizeOrder({
    referenceId: `check-${Date.now()}`,
    description: `Remit sandbox check: ${label}`,
    items: [{ name: label, description: "Sandbox check", cents }],
    returnUrl: `${config.appUrl}/?sandbox-check=approved`,
    cancelUrl: `${config.appUrl}/?sandbox-check=cancelled`,
  });
  console.log(`\nOpen this link, sign in as the sandbox buyer and approve:\n  ${approveUrl}`);
  for (;;) {
    await rl.question("Press Enter after approving… ");
    const status = await paypal.getOrderStatus(orderId);
    if (status === "APPROVED") break;
    console.log(`  Order is ${status}, not APPROVED yet.`);
  }
  return paypal.authorizeOrder(orderId);
}

console.log("Order A: authorize $30.00");
const a = await approvedOrder(3000, "Partial capture test");
console.log(`  hold ${a.authorizationId}, expires ${a.expiresAt}`);
await step("A: partial capture $10.00", async () => (await paypal.capture(a.authorizationId, { cents: 1000, finalCapture: false, note: "check 1", idempotencyKey: `${a.authorizationId}-1` })).status);
await step("A: partial capture $5.00", async () => (await paypal.capture(a.authorizationId, { cents: 500, finalCapture: false, note: "check 2", idempotencyKey: `${a.authorizationId}-2` })).status);
await step("A: capture $20.00 (over the $15 left)", async () => (await paypal.capture(a.authorizationId, { cents: 2000, finalCapture: false, note: "over", idempotencyKey: `${a.authorizationId}-3` })).status);
await step("A: void the $15 left after partial captures", async () => {
  await paypal.voidAuthorization(a.authorizationId);
  return "voided";
});
await step("A: final capture $1.00", async () => (await paypal.capture(a.authorizationId, { cents: 100, finalCapture: true, note: "final", idempotencyKey: `${a.authorizationId}-4` })).status);
await step("A: capture again after final", async () => (await paypal.capture(a.authorizationId, { cents: 100, finalCapture: false, note: "after", idempotencyKey: `${a.authorizationId}-5` })).status);

console.log("\nOrder B: authorize $20.00 and void it untouched");
const b = await approvedOrder(2000, "Void test");
await step("B: void with nothing captured", async () => {
  await paypal.voidAuthorization(b.authorizationId);
  return "voided";
});

rl.close();
console.log("\nResults");
for (const [name, outcome] of results) console.log(`  ${name.padEnd(46)} ${outcome}`);
console.log(`
What decides hold vs prepaid:
  - If "void the $15 left" was refused, the wallet can't release leftovers early; they lapse when the hold expires.
  - If "final capture" worked and "capture again" was refused, a final capture closes the hold and releases the rest.
Check the buyer's sandbox account (sandbox.paypal.com) to see when the uncaptured amount is released.`);
