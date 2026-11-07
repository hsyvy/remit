import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLocalUrl } from "../src/config.ts";
import { createApp, type AppDeps } from "../src/server/app.ts";

const modes = { paypal: "simulated", search: "demo", agent: "off", reviewer: "off", model: "test" };

describe("hosting", () => {
  it("answers /healthz without the owner password", async () => {
    const app = createApp({ modes, ownerPassword: "secret" } as unknown as AppDeps);
    const health = await app.request("/healthz");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal((await app.request("/api/state")).status, 401);
  });

  it("treats only this machine as local", () => {
    assert.ok(isLocalUrl("http://localhost:3000"));
    assert.ok(isLocalUrl("http://127.0.0.1:3105"));
    assert.ok(isLocalUrl("http://[::1]:3000"));
    assert.ok(isLocalUrl("http://remit.localhost"));
    assert.ok(!isLocalUrl("https://remit.onrender.com"));
    assert.ok(!isLocalUrl("https://localhost.example.com"));
  });
});
