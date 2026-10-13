process.env.ANTIGRAVITY_CLIENT_ID = "fake-test-client";
process.env.ANTIGRAVITY_CLIENT_SECRET = "fake-test-secret";

import assert from "node:assert/strict";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { createHostFetch, OAUTH_NETWORK_DOMAINS } from "../src/desktop/host-fetch.js";
import { createProviderOAuth } from "../src/desktop/provider-oauth.js";
import { scopedAntigravityFetch } from "../src/utils/fetch-context.js";
import type { PluginHostApi } from "../src/desktop/native-contract.js";

let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run(); passed++; console.log(`PASS ${name}`);
}
const originalFetch = globalThis.fetch;
const originalDispatcher = getGlobalDispatcher();
const mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
// A direct Undici request fails against MockAgent; native fetch must never be used.
globalThis.fetch = async () => { throw new Error("Direct Node fetch must not be used for Desktop OAuth"); };
const events: Record<string, unknown>[] = [];
const api: PluginHostApi = { providers: { oauth: {
  async notify(_id, event) { events.push(event); },
  async prompt() {
    const auth = events.findLast(event => event.kind === "authUrl")!;
    return `http://localhost:51121/oauth-callback?code=fake-code&state=${new URL(String(auth.url)).searchParams.get("state")}`;
  },
} } };
const credential = { accessToken: "fake-old-access", refreshToken: "fake-refresh", expiresAt: 0,
  accountLabel: "Google account", headers: { "x-pi-antigravity-project": "fake-project" } };
const request = { operation: "refresh" as const, providerId: "antigravity", credential };
const context = () => ({ signal: new AbortController().signal });
const tokenJson = (access = "fake-host-access") => JSON.stringify({ access_token: access, refresh_token: "fake-host-refresh", expires_in: 3600 });
try {
  await test("real refresh uses host net.fetch without a global proxy dispatcher", async () => {
    let calls = 0;
    const host: PluginHostApi = { ...api, net: { async fetch(input) {
      calls++; assert.equal(input.url, "https://oauth2.googleapis.com/token");
      assert.equal(input.method, "POST"); assert.equal(input.timeoutMs, 30000);
      assert.equal(new URLSearchParams(input.body).get("refresh_token"), credential.refreshToken);
      return { status: 200, headers: { "content-encoding": "gzip" }, bodyText: tokenJson() };
    } } };
    const result = await createProviderOAuth(host)(request, context());
    assert.equal(calls, 1); assert.equal(result.accessToken, "fake-host-access");
    assert.equal(result.accountLabel, "Google account"); assert.equal(result.headers!["x-pi-antigravity-project"], "fake-project");
    assert.equal(scopedAntigravityFetch(), undefined);
  });
  await test("refresh without project discovers it through the same host transport", async () => {
    const paths: string[] = [];
    const host: PluginHostApi = { ...api, net: { async fetch(input) {
      paths.push(new URL(input.url).pathname);
      if (input.url.endsWith("/token")) return { status: 200, bodyText: tokenJson("fake-discovery-access") };
      assert.equal(input.headers.authorization, "Bearer fake-discovery-access");
      return { status: 200, bodyText: JSON.stringify({ cloudaicompanionProject: "discovered-project" }) };
    } } };
    const result = await createProviderOAuth(host)({ ...request, credential: { ...credential, headers: {} } }, context());
    assert.deepEqual(paths, ["/token", "/v1internal:loadCodeAssist"]);
    assert.equal(result.headers!["x-pi-antigravity-project"], "discovered-project");
  });
  await test("real login exchange, user info and discovery use host transport", async () => {
    const paths: string[] = [];
    const host: PluginHostApi = { ...api, net: { async fetch(input) {
      paths.push(new URL(input.url).pathname);
      if (input.url.endsWith("/token")) {
        assert.equal(new URLSearchParams(input.body).get("grant_type"), "authorization_code");
        return { status: 200, bodyText: tokenJson("fake-login-access") };
      }
      if (input.url.includes("/userinfo")) return { status: 200, bodyText: JSON.stringify({ email: "user@example.test" }) };
      return { status: 200, bodyText: JSON.stringify({ cloudaicompanionProject: "login-project" }) };
    } } };
    const result = await createProviderOAuth(host)({ operation: "login", providerId: "antigravity", loginId: "fake-login" }, context());
    assert.equal(result.accessToken, "fake-login-access");
    assert.ok(paths.includes("/token") && paths.includes("/oauth2/v1/userinfo") && paths.includes("/v1internal:loadCodeAssist"));
    assert.equal(result.headers!["x-pi-antigravity-project"], "login-project");
    assert.ok(!JSON.stringify(events).includes(result.accessToken));
  });
  await test("concurrent accounts retain separate host transports", async () => {
    const run = (label: string) => createProviderOAuth({ ...api, net: { async fetch(input) {
      await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(new URLSearchParams(input.body).get("refresh_token"), label);
      return { status: 200, bodyText: tokenJson(`fake-${label}`) };
    } } })({ ...request, credential: { ...credential, refreshToken: label } }, context());
    const results = await Promise.all([run("account-a"), run("account-b")]);
    assert.deepEqual(results.map(value => value.accessToken), ["fake-account-a", "fake-account-b"]);
    assert.equal(scopedAntigravityFetch(), undefined);
  });
  await test("cancelled refresh retires promptly and discards late host credentials", async () => {
    let finish!: (value: { status: number; bodyText: string }) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pendingHost = new Promise<{ status: number; bodyText: string }>(resolve => { finish = resolve; });
    const host: PluginHostApi = { ...api, net: { fetch() { started(); return pendingHost; } } };
    const abort = new AbortController();
    const pending = createProviderOAuth(host)(request, { signal: abort.signal });
    await ready; abort.abort();
    await assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
    finish({ status: 200, bodyText: tokenJson() });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(scopedAntigravityFetch(), undefined);
  });
  await test("pre-cancelled request never reaches the host", async () => {
    let calls = 0; const abort = new AbortController(); abort.abort();
    await assert.rejects(createHostFetch({ ...api, net: { async fetch() { calls++; return { status: 200, bodyText: "{}" }; } } })("https://oauth2.googleapis.com/token", { signal: abort.signal }));
    assert.equal(calls, 0);
  });
  await test("missing permission/API cannot silently fall back to direct fetch", async () => {
    await assert.rejects(createProviderOAuth(api)(request, context()), /net.fetch/);
    await assert.rejects(createHostFetch({ ...api, net: { async fetch() { throw new Error(`secret ${credential.refreshToken}`); } } })("https://oauth2.googleapis.com/token"), error => /Desktop/.test(String(error)) && !String(error).includes(credential.refreshToken));
  });
  await test("foreign, plaintext and non-default-port origins are rejected before host dispatch", async () => {
    let calls = 0; const fetcher = createHostFetch({ ...api, net: { async fetch() { calls++; return { status: 200, bodyText: "{}" }; } } });
    for (const url of ["https://oauth2.googleapis.com.evil.test/token", "http://oauth2.googleapis.com/token", "https://oauth2.googleapis.com:444/token", "https://user@oauth2.googleapis.com/token"])
      await assert.rejects(fetcher(url), /unexpected origin/);
    assert.equal(calls, 0); assert.equal(OAUTH_NETWORK_DOMAINS.length, 5);
  });
  await test("host HTTP error is preserved as OAuth failure, not fetch failed", async () => {
    await assert.rejects(createProviderOAuth({ ...api, net: { async fetch() { return { status: 400, bodyText: '{"error":"invalid_grant"}' }; } } })(request, context()), /invalid_grant/);
  });
  await test("redirects and malformed host responses are rejected", async () => {
    await assert.rejects(createHostFetch({ ...api, net: { async fetch() { return { status: 302, bodyText: "" }; } } })("https://oauth2.googleapis.com/token"), /redirect/);
    await assert.rejects(createHostFetch({ ...api, net: { async fetch() { return { status: 0, bodyText: "" }; } } })("https://oauth2.googleapis.com/token"), /invalid/);
  });
  console.log(`Desktop host OAuth transport: ${passed} tests passed; no external requests or real credentials.`);
} finally {
  globalThis.fetch = originalFetch; setGlobalDispatcher(originalDispatcher); await mock.close();
}
