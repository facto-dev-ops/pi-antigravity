import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { loginAntigravity, refreshAntigravityToken, resolveOAuthClient, TOKEN_URL } from "../src/auth/oauth.js";
import { withAntigravityFetch } from "../src/utils/fetch-context.js";

const names = ["ANTIGRAVITY_CLIENT_ID", "ANTIGRAVITY_CLIENT_SECRET", "NOAGY_CLIENT_ID", "NOAGY_CLIENT_SECRET"];
const previous = names.map(name => process.env[name]);
const dispatcher = getGlobalDispatcher();
const mock = new MockAgent();
mock.disableNetConnect();
setGlobalDispatcher(mock);
const clear = () => names.forEach(name => { delete process.env[name]; });
const credentials = { access: "fake-old-access", refresh: "fake-refresh", expires: 0, projectId: "fake-project" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
try {
  clear();
  const defaults = resolveOAuthClient();
  // Fingerprints were independently recovered from the preserved 0.2.4 source.
  assert.ok(hash(defaults.clientId) === "bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea", "Default client ID provenance mismatch");
  assert.ok(hash(defaults.clientSecret) === "1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60", "Default client secret provenance mismatch");
  let state = "";
  let exchanges = 0;
  let refreshes = 0;
  await withAntigravityFetch((async (input, init) => {
    const url = String(input);
    if (url === TOKEN_URL) {
      const body = new URLSearchParams(String(init?.body));
      assert.ok(body.get("client_id") === defaults.clientId, "Token client ID mismatch");
      assert.ok(body.get("client_secret") === defaults.clientSecret, "Token client secret mismatch");
      if (body.get("grant_type") === "refresh_token") {
        refreshes++;
        assert.equal(body.get("refresh_token"), credentials.refresh);
      } else {
        exchanges++;
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.equal(body.get("code"), "fake-code");
        assert.ok(body.get("code_verifier"));
        assert.notEqual(body.get("code_verifier"), state);
      }
      return new Response(JSON.stringify({ access_token: "fake-new-access", refresh_token: "fake-new-refresh", expires_in: 3600 }));
    }
    if (url.startsWith("https://www.googleapis.com/oauth2/v1/userinfo")) return new Response(JSON.stringify({ email: "test@example.test" }));
    assert.ok(url.startsWith("https://daily-cloudcode-pa.googleapis.com/"), "Unexpected simulated endpoint");
    return new Response(JSON.stringify({ cloudaicompanionProject: "fake-project" }));
  }) as typeof fetch, async () => {
    const refreshed = await refreshAntigravityToken(credentials);
    assert.equal(refreshed.access, "fake-new-access");
    const loggedIn = await loginAntigravity({
      onAuth: info => {
        const url = new URL(info.url);
        assert.ok(url.searchParams.get("client_id") === defaults.clientId, "Authorization client mismatch");
        assert.equal(url.searchParams.get("client_secret"), null);
        assert.ok(!info.url.includes(defaults.clientSecret), "Secret leaked into authorization URL");
        state = url.searchParams.get("state")!;
      },
      onPrompt: async () => `http://localhost:51121/oauth-callback?code=fake-code&state=${state}`,
    });
    assert.equal(loggedIn.refresh, "fake-new-refresh");
    assert.equal(loggedIn.projectId, "fake-project");
  });
  assert.equal(exchanges, 1);
  assert.equal(refreshes, 1);

  let notifications = 0;
  let requests = 0;
  process.env.ANTIGRAVITY_CLIENT_ID = "fake-incomplete-client";
  await withAntigravityFetch((async () => { requests++; throw new Error("Unexpected network request"); }) as typeof fetch, async () => {
    await assert.rejects(loginAntigravity({ onAuth: () => { notifications++; }, onPrompt: async () => "" }), /Both.*CLIENT_ID.*CLIENT_SECRET/);
    await assert.rejects(refreshAntigravityToken(credentials), /Both.*CLIENT_ID.*CLIENT_SECRET/);
  });
  assert.equal(requests, 0);
  assert.equal(notifications, 0);
  clear();
  process.env.NOAGY_CLIENT_ID = " fake-legacy-client ";
  process.env.NOAGY_CLIENT_SECRET = " fake-legacy-secret ";
  assert.deepEqual(resolveOAuthClient(), { clientId: "fake-legacy-client", clientSecret: "fake-legacy-secret" });
  process.env.ANTIGRAVITY_CLIENT_ID = "fake-runtime-client";
  process.env.ANTIGRAVITY_CLIENT_SECRET = "fake-runtime-secret/+";
  const runtimeClient = resolveOAuthClient();
  assert.equal(runtimeClient.clientId, "fake-runtime-client");
  process.env.ANTIGRAVITY_CLIENT_ID = "fake-updated-client";
  assert.equal(resolveOAuthClient().clientId, "fake-updated-client");
  process.env.ANTIGRAVITY_CLIENT_ID = runtimeClient.clientId;
  await withAntigravityFetch((async (input, init) => {
    assert.equal(String(input), TOKEN_URL);
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("client_id"), runtimeClient.clientId);
    assert.equal(body.get("client_secret"), runtimeClient.clientSecret);
    return new Response(JSON.stringify({ error: "invalid_grant", error_description: `echo ${runtimeClient.clientSecret} ${encodeURIComponent(runtimeClient.clientSecret)} ${body.get("refresh_token") || ""} ${body.get("code") || ""} ${body.get("code_verifier") || ""}` }), { status: 400 });
  }) as typeof fetch, async () => {
    const safeError = (error: unknown) => {
      const message = String(error);
      assert.match(message, /invalid_grant/);
      for (const secret of [runtimeClient.clientSecret, encodeURIComponent(runtimeClient.clientSecret), credentials.refresh, "fake-code"]) assert.ok(!message.includes(secret), "Error leaked a credential");
      return true;
    };
    await assert.rejects(refreshAntigravityToken(credentials), safeError);
    await assert.rejects(loginAntigravity({
      onAuth: info => { state = new URL(info.url).searchParams.get("state")!; },
      onPrompt: async () => `http://localhost:51121/oauth-callback?code=fake-code&state=${state}`,
    }), safeError);
  });
  console.log("OAuth restored-default provenance, no-config login/refresh, custom overrides and redaction passed; no external requests");
} finally {
  names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  setGlobalDispatcher(dispatcher);
  await mock.close();
}
