const env = process.env;

const appUrl = (env.APP_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/$/, "");

export const config = {
  port: Number(env.PORT ?? 3000),
  appUrl,
  dbPath: env.REMIT_DB ?? "data/remit.db",
  currency: "USD",
  // PayPal won't take INR, so money stays in USD; the app and agent also show an approximate rupee figure. 0 turns it off.
  inrRate: Number(env.REMIT_INR_RATE ?? 88) || 0,
  maxRequestCents: Math.round(Number(env.REMIT_MAX_REQUEST ?? 500) * 100),
  paypal: {
    clientId: env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: env.PAYPAL_CLIENT_SECRET ?? "",
    baseUrl: "https://api-m.sandbox.paypal.com",
  },
  anthropic: {
    model: env.REMIT_MODEL ?? "claude-opus-5-5",
    reviewer: (env.REMIT_REVIEWER ?? "on") !== "off",
    // The SDK can also find credentials elsewhere, but an explicit key is how this app expects to be configured.
    configured: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
  },
  channel3Key: env.CHANNEL3_API_KEY ?? "",
  agentToken: env.REMIT_AGENT_TOKEN ?? "",
};

export const paypalMode = config.paypal.clientId && config.paypal.clientSecret ? "sandbox" : "simulated";
