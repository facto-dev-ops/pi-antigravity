import assert from "node:assert/strict";
import { createServer } from "node:http";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { loginAntigravity, refreshAntigravityToken, resolveOAuthClient, TOKEN_URL, type OAuthLoginCallbacks } from "../src/auth/oauth.js";
import { withAntigravityFetch } from "../src/utils/fetch-context.js";

const names = ["ANTIGRAVITY_CLIENT_ID", "ANTIGRAVITY_CLIENT_SECRET", "NOAGY_CLIENT_ID", "NOAGY_CLIENT_SECRET"];
const previous = names.map(name => process.env[name]);
const dispatcher = getGlobalDispatcher();
const mock = new MockAgent();
mock.disableNetConnect();
setGlobalDispatcher(mock);
const clear = () => names.forEach(name => { delete process.env[name]; });
const credentials = { access: "fake-old-access", refresh: "fake-refresh", expires: 0, projectId: "fake-project" };
let notifications = 0;
const callbacks: OAuthLoginCallbacks = {
  onAuth: () => { notifications++; },
  onPrompt: async () => { throw new Error("Must not prompt without configuration"); },
};
try {
  clear();
  assert.throws(resolveOAuthClient, /ANTIGRAVITY_CLIENT_ID.*ANTIGRAVITY_CLIENT_SECRET/);
  // Occupy the callback port: the configuration error must take precedence over EADDRINUSE.
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(51121, "127.0.0.1", resolve);
  });
  let requests = 0;
  try {
    await withAntigravityFetch((async () => { requests++; throw new Error("Unexpected network request"); }) as typeof fetch, async () => {
      await assert.rejects(loginAntigravity(callbacks), /OAuth client is not configured/);
      await assert.rejects(refreshAntigravityToken(credentials), /OAuth client is not configured/);
      process.env.ANTIGRAVITY_CLIENT_ID = "fake-client-only";
      await assert.rejects(loginAntigravity(callbacks), /OAuth client is not configured/);
      process.env.ANTIGRAVITY_CLIENT_SECRET = "  ";
      await assert.rejects(refreshAntigravityToken(credentials), /OAuth client is not configured/);
    });
    assert.equal(requests, 0);
    assert.equal(notifications, 0);
  } finally {
    await new Promise<void>(resolve => occupied.close(() => resolve()));
  }
  clear();
  process.env.NOAGY_CLIENT_ID = " fake-legacy-client ";
  process.env.NOAGY_CLIENT_SECRET = " fake-legacy-secret ";
  assert.deepEqual(resolveOAuthClient(), { clientId: "fake-legacy-client", clientSecret: "fake-legacy-secret" });
  process.env.ANTIGRAVITY_CLIENT_ID = "fake-runtime-client";
  process.env.ANTIGRAVITY_CLIENT_SECRET = "fake-runtime-secret/+";
  const runtimeClient = resolveOAuthClient();
  assert.equal(runtimeClient.clientId, "fake-runtime-client");
  assert.equal(runtimeClient.clientSecret, "fake-runtime-secret/+");
  // Re-reading after import/config changes must not capture a stale value.
  process.env.ANTIGRAVITY_CLIENT_ID = "fake-updated-client";
  assert.equal(resolveOAuthClient().clientId, "fake-updated-client");
  process.env.ANTIGRAVITY_CLIENT_ID = runtimeClient.clientId;
  let state = "";
  let challenge = "";
  await withAntigravityFetch((async (input, init) => {
    assert.equal(String(input), TOKEN_URL);
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("client_id"), runtimeClient.clientId);
    assert.equal(body.get("client_secret"), runtimeClient.clientSecret);
    if (body.get("grant_type") === "refresh_token") {
      assert.equal(body.get("refresh_token"), credentials.refresh);
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: `echo ${runtimeClient.clientSecret} ${encodeURIComponent(runtimeClient.clientSecret)} ${credentials.refresh}` }), { status: 400 });
    }
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "fake-code");
    assert.ok(body.get("code_verifier"));
    assert.notEqual(body.get("code_verifier"), state);
    assert.notEqual(body.get("code_verifier"), challenge);
    return new Response(JSON.stringify({ error: "invalid_grant", error_description: `echo ${runtimeClient.clientSecret} fake-code ${body.get("code_verifier")}` }), { status: 400 });
  }) as typeof fetch, async () => {
    const safeError = (error: unknown) => {
      const message = String(error);
      assert.match(message, /invalid_grant/);
      assert.ok(!message.includes(runtimeClient.clientSecret));
      assert.ok(!message.includes(encodeURIComponent(runtimeClient.clientSecret)));
      assert.ok(!message.includes(credentials.refresh));
      assert.ok(!message.includes("fake-code"));
      return true;
    };
    await assert.rejects(refreshAntigravityToken(credentials), safeError);
    await assert.rejects(loginAntigravity({
      onAuth: info => {
        const url = new URL(info.url);
        assert.equal(url.searchParams.get("client_id"), runtimeClient.clientId);
        assert.equal(url.searchParams.get("client_secret"), null);
        assert.ok(!info.url.includes(runtimeClient.clientSecret));
        state = url.searchParams.get("state")!;
        challenge = url.searchParams.get("code_challenge")!;
      },
      onPrompt: async () => `http://localhost:51121/oauth-callback?code=fake-code&state=${state}`,
    }), safeError);
  });
  console.log("OAuth runtime config, fail-before-listen/network, request parameters and error redaction passed");
} finally {
  names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  setGlobalDispatcher(dispatcher);
  await mock.close();
}
