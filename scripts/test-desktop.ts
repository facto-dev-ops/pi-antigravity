import { windowsSystemExecutable } from "../src/desktop/private-directory.js";
import { loadCodeAssist } from "../src/client/client.js";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DesktopAuthStore } from "../src/desktop/auth.js";
import { createDesktopStream } from "../src/desktop/stream.js";
import { createDesktopExtension, openGoogleLogin } from "../src/desktop/index.js";
import type { loginAntigravity } from "../src/auth/oauth.js";
import type { streamAntigravity } from "../src/stream/index.js";

if (!process.env.PI_SCRATCH_DIR) throw new Error("PI_SCRATCH_DIR is required for isolated tests");
const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR, "desktop-antigravity-tests-"));
const previousCliDir = process.env.PI_CODING_AGENT_DIR;
const cliDir = join(root, "cli");
mkdirSync(cliDir);
const cliFixture = JSON.stringify({ openai: { type: "api_key", key: "fake-cli-only-key" } });
writeFileSync(join(cliDir, "auth.json"), cliFixture);
process.env.PI_CODING_AGENT_DIR = cliDir;
const fresh = { access: "fake-desktop-access", refresh: "fake-desktop-refresh", expires: Date.now() + 3600000, projectId: "test-project", email: "someone@example.test" };
const model = { id: "gemini-3.8-flash", name: "Test model", provider: "plugin-agent:test", api: "openai-completions", baseUrl: "https://example.test", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>;
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let passed = 0;
async function check(name: string, run: () => Promise<void>) { await run(); passed++; console.log(`PASS ${name}`); }
function message(m = model): AssistantMessage { return { role: "assistant", api: m.api, provider: m.provider, model: m.id, content: [{ type: "text", text: "hello" }], stopReason: "stop", timestamp: Date.now(), usage }; }

function commandHarness(auth: DesktopAuthStore, login?: typeof loginAntigravity) {
  type ApiType = Parameters<typeof createDesktopExtension>[0];
  type Definition = Parameters<ApiType["registerAgent"]>[0];
  type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
  const commands = new Map<string, Command>();
  const notices: string[] = [];
  const launches: { command: string; args: string[] }[] = [];
  let agent: Definition | undefined;
  let selected: Model<Api> | undefined;
  let consent = false;
  let input: string | undefined = "http://localhost:51121/oauth-callback?state=fake&code=fake";
  const pi = {
    registerAgent(definition: Definition) { agent = definition; },
    registerCommand(name: string, definition: Command) { commands.set(name, definition); },
    async exec(command: string, args: string[]) { launches.push({ command, args }); return { code: 0, stdout: "", stderr: "", killed: false }; },
    async setModel(chosen: Model<Api>) { selected = chosen; return true; },
  } as unknown as ApiType;
  createDesktopExtension(pi, { auth, login });
  const context = {
    hasUI: true, signal: new AbortController().signal,
    ui: { notify(text: string) { notices.push(text); }, async confirm() { return consent; }, async input() { return input; }, async select(_title: string, choices: string[]) { return choices[0]; } },
    modelRegistry: { getAll: () => [model], getProviderDisplayName: () => "Antigravity (Google OAuth)" },
  } as unknown as Parameters<Command["handler"]>[1];
  return {
    pi, commands, notices, launches,
    get agent() { return agent; }, get selected() { return selected; },
    setConsent(value: boolean) { consent = value; }, setInput(value: string | undefined) { input = value; },
    async run(name: string, args = "") { const command = commands.get(name); assert.ok(command); await command.handler(args, context); },
  };
}

try {
  await check("missing credentials fail without using CLI auth", async () => {
    const auth = new DesktopAuthStore(join(root, "empty"));
    await assert.rejects(auth.apiKey(), /antigravity.login/);
    assert.equal(readFileSync(join(cliDir, "auth.json"), "utf8"), cliFixture);
  });
  await check("credentials persist in an independent directory", async () => {
    const auth = new DesktopAuthStore(join(root, "isolated"));
    await auth.save(fresh);
    assert.equal(JSON.parse(await auth.apiKey()).token, fresh.access);
    assert.equal(new DesktopAuthStore(auth.directory).status().signedIn, true);
    assert.equal(readFileSync(join(cliDir, "auth.json"), "utf8"), cliFixture);
  });
  await check("concurrent sessions refresh once and persist rotated tokens", async () => {
    let calls = 0;
    const directory = join(root, "refresh");
    const refresh = async (credentials: typeof fresh) => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return { ...credentials, access: "fake-rotated-access", refresh: "fake-rotated-refresh", expires: Date.now() + 3600000 }; };
    const auth = new DesktopAuthStore(directory, refresh);
    await auth.save({ ...fresh, expires: 0 });
    const other = new DesktopAuthStore(directory, refresh);
    const keys = await Promise.all([auth.apiKey(), other.apiKey(), auth.apiKey()]);
    assert.equal(calls, 1);
    assert.ok(keys.every(key => JSON.parse(key).token === "fake-rotated-access"));
    assert.ok(readFileSync(join(directory, "antigravity-accounts.json"), "utf8").includes("fake-rotated-refresh"));
  });
  await check("cancelled refresh does not save new credentials", async () => {
    const controller = new AbortController();
    const auth = new DesktopAuthStore(join(root, "cancel-refresh"), async credentials => { controller.abort(); return { ...credentials, access: "must-not-persist", expires: Date.now() + 3600000 }; });
    await auth.save({ ...fresh, expires: 0 });
    await assert.rejects(auth.apiKey(controller.signal));
    assert.ok(!readFileSync(join(auth.directory, "antigravity-accounts.json"), "utf8").includes("must-not-persist"));
  });
  await check("async credential scopes stay isolated", async () => {
    const a = new DesktopAuthStore(join(root, "scope-a"));
    const b = new DesktopAuthStore(join(root, "scope-b"));
    await Promise.all([a.save(fresh), b.save({ ...fresh, access: "fake-other-access" })]);
    const keys = await Promise.all([a.apiKey(), b.apiKey()]);
    assert.equal(JSON.parse(keys[0]!).token, fresh.access);
    assert.equal(JSON.parse(keys[1]!).token, "fake-other-access");
  });
  await check("logout removes plugin credentials and preserves CLI data", async () => {
    const auth = new DesktopAuthStore(join(root, "logout")); await auth.save(fresh); await auth.logout();
    assert.equal(auth.status().signedIn, false);
    assert.ok(!readFileSync(join(auth.directory, "antigravity-accounts.json"), "utf8").includes(fresh.refresh));
    assert.equal(readFileSync(join(cliDir, "auth.json"), "utf8"), cliFixture);
  });
  await check("stream injects OAuth credentials and remaps transcript identity", async () => {
    const auth = new DesktopAuthStore(join(root, "stream")); await auth.save(fresh);
    const history = message();
    const context: Context = { messages: [history] };
    let calls = 0;
    const fake: typeof streamAntigravity = (native, incoming, options) => {
      calls++;
      assert.equal(native.provider, "antigravity");
      assert.equal(JSON.parse(options!.apiKey!).token, fresh.access);
      assert.equal(options!.reasoning, "high");
      assert.equal(options!.temperature, 0.2);
      assert.equal(options!.accountFailover, false);
      assert.equal((incoming.messages[0] as AssistantMessage).provider, "antigravity");
      const stream = createAssistantMessageEventStream(); const final = message(native);
      stream.push({ type: "start", partial: final });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial: final });
      stream.push({ type: "done", reason: "stop", message: final }); stream.end(final); return stream;
    };
    const stream = createDesktopStream(auth, fake)(model, context, { apiKey: "pi-desktop-plugin-agent", reasoning: "high", temperature: 0.2 });
    let events = 0; for await (const event of stream) { events++; if ("partial" in event) assert.equal(event.partial.provider, model.provider); }
    const result = await stream.result(); assert.equal(result.provider, model.provider); assert.equal(result.api, model.api);
    assert.equal(history.provider, model.provider); assert.equal(calls, 1); assert.equal(events, 3);
  });
  await check("unsigned-in streams finish with an actionable error", async () => {
    const auth = new DesktopAuthStore(join(root, "stream-empty"));
    const result = await createDesktopStream(auth)(model, { messages: [] }).result();
    assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /antigravity.login/);
  });
  await check("aborted requests stop before calling the upstream", async () => {
    const controller = new AbortController(); controller.abort();
    const auth = new DesktopAuthStore(join(root, "stream-abort"));
    let called = false;
    const fake: typeof streamAntigravity = () => { called = true; throw new Error("must not run"); };
    const result = await createDesktopStream(auth, fake)(model, { messages: [] }, { signal: controller.signal }).result();
    assert.equal(result.stopReason, "aborted"); assert.equal(called, false);
  });
  await check("model and Desktop commands register without CLI OAuth APIs", async () => {
    const harness = commandHarness(new DesktopAuthStore(join(root, "commands")));
    assert.equal(harness.agent!.id, "antigravity"); assert.equal(harness.agent!.models.length, 9);
    assert.deepEqual([...harness.commands.keys()].sort(), ["antigravity.login", "antigravity.logout", "antigravity.model", "antigravity.models", "antigravity.settings", "antigravity.status", "antigravity.usage"].sort());
  });
  await check("native login callback saves credentials without exposing tokens", async () => {
    const auth = new DesktopAuthStore(join(root, "login"));
    const fake: typeof loginAntigravity = async callbacks => { callbacks.onAuth({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=fake" }); assert.ok(await callbacks.onPrompt({ message: "callback" })); return fresh; };
    const harness = commandHarness(auth, fake); await harness.run("antigravity.login");
    assert.equal(auth.status().signedIn, true); assert.equal(harness.launches.length, 1);
    assert.ok(harness.notices.some(text => text.includes("已登录"))); assert.ok(!harness.notices.join("\n").includes(fresh.access));
  });
  await check("cancelled login never persists credentials", async () => {
    const auth = new DesktopAuthStore(join(root, "login-cancel"));
    const fake: typeof loginAntigravity = async callbacks => { callbacks.onAuth({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=fake" }); await callbacks.onPrompt({ message: "callback" }); return fresh; };
    const harness = commandHarness(auth, fake); harness.setInput(undefined); await harness.run("antigravity.login");
    assert.equal(auth.status().signedIn, false);
  });
  await check("logout requires confirmation", async () => {
    const auth = new DesktopAuthStore(join(root, "logout-ui")); await auth.save(fresh);
    const harness = commandHarness(auth); await harness.run("antigravity.logout"); assert.equal(auth.status().signedIn, true);
    harness.setConsent(true); await harness.run("antigravity.logout"); assert.equal(auth.status().signedIn, false);
  });
  await check("model selection uses Desktop's own binding", async () => {
    const harness = commandHarness(new DesktopAuthStore(join(root, "select"))); await harness.run("antigravity.model", model.id);
    assert.equal(harness.selected!.id, model.id);
  });
  await check("browser launcher rejects untrusted OAuth addresses", async () => {
    const harness = commandHarness(new DesktopAuthStore(join(root, "browser")));
    await assert.rejects(openGoogleLogin(harness.pi, "https://accounts.google.com.evil.test/"));
    await assert.rejects(openGoogleLogin(harness.pi, "http://accounts.google.com/"));
    assert.equal(harness.launches.length, 0);
  });
  await check("credential directory uses the native permission model", async () => {
    const auth = new DesktopAuthStore(join(root, "acl"));
    await auth.save(fresh);
    if (process.platform === "win32") {
      const script = '$acl = Get-Acl -LiteralPath $env:PI_ANTIGRAVITY_ACL_TEST; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; [pscustomobject]@{ protected = $acl.AreAccessRulesProtected; current = $sid; sids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }) } | ConvertTo-Json -Compress';
      const acl = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, env: { ...process.env, PI_ANTIGRAVITY_ACL_TEST: auth.directory } }));
      assert.equal(acl.protected, true);
      assert.ok(acl.sids.length > 0 && acl.sids.every((sid: string) => sid === acl.current));
    }
  });
  await check("old auth mirror cannot overwrite rotated Desktop credentials", async () => {
    const auth = new DesktopAuthStore(join(root, "stale-mirror"));
    await auth.save(fresh);
    writeFileSync(join(auth.directory, "auth.json"), JSON.stringify({ antigravity: { ...fresh, type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 } }));
    await auth.save({ ...fresh, access: "new-access", refresh: "new-refresh" });
    assert.equal(JSON.parse(await auth.apiKey()).token, "new-access");
    assert.ok(readFileSync(join(auth.directory, "antigravity-accounts.json"), "utf8").includes("new-refresh"));
  });
  await check("existing public Windows ACL rejects token persistence", async () => {
    if (process.platform !== "win32") return;
    const auth = new DesktopAuthStore(join(root, "public-acl"));
    await auth.save(fresh);
    execFileSync(windowsSystemExecutable("icacls.exe"), [auth.directory, "/grant", "*S-1-1-0:R"], { windowsHide: true });
    await assert.rejects(auth.save({ ...fresh, access: "must-not-persist-public" }));
    assert.ok(!readFileSync(join(auth.directory, "antigravity-accounts.json"), "utf8").includes("must-not-persist-public"));
  });
  await check("cancelled project discovery stops without trying other endpoints", async () => {
    const original = globalThis.fetch;
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        if (init!.signal!.aborted) { reject(init!.signal!.reason); return; }
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    };
    try {
      const pending = loadCodeAssist("fake-discovery-token", controller.signal);
      controller.abort();
      await assert.rejects(pending);
      assert.ok(calls <= 1);
    } finally { globalThis.fetch = original; }
  });
  console.log(`Desktop adapter: ${passed} tests passed; no live Google credentials or API requests used.`);
} finally {
  if (previousCliDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousCliDir;
  rmSync(root, { recursive: true, force: true });
}
