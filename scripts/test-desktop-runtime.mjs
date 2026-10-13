import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtime = process.env.PI_DESKTOP_RUNTIME_DIR;
if (!runtime || !process.env.PI_SCRATCH_DIR) throw new Error("Set PI_DESKTOP_RUNTIME_DIR and PI_SCRATCH_DIR for the actual Desktop runtime test.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(process.env.PI_SCRATCH_DIR, "antigravity-native-runtime-"));
process.env.PI_CODING_AGENT_DIR = join(home, "cli-must-not-be-read");
const manifest = JSON.parse(createRequire(import.meta.url)("node:fs").readFileSync(join(root, "desktop/manifest.json"), "utf8"));
assert.equal(manifest.version, "0.2.6");
assert.equal(manifest.main, "main.js");
const packageMetadata = JSON.parse(createRequire(import.meta.url)("node:fs").readFileSync(join(root, "desktop/package.json"), "utf8"));
assert.equal(packageMetadata.version, manifest.version);
assert.equal(packageMetadata.type, "commonjs");
assert.ok(manifest.permissions.includes("net.fetch"));
assert.ok(manifest.permissions.includes("ui.panel"));
assert.ok(manifest.net.domains.includes("oauth2.googleapis.com"));
const provider = manifest.contributes.providers[0];
assert.equal(provider.authKind, "oauth"); assert.equal(provider.apiStyle, "google_generative_ai"); assert.equal(provider.models.length, 8);
const pluginMain = createRequire(import.meta.url)(join(root, "desktop", manifest.main));
assert.equal(typeof pluginMain.onProviderOAuth, "function");
assert.equal(typeof pluginMain.onPanelInvoke, "function");
assert.equal(typeof pluginMain.onLoad, "function");
await pluginMain.onLoad(); await pluginMain.onUnload();
const originalPi = globalThis.pi;
process.env.ANTIGRAVITY_CLIENT_ID = "fake-runtime-client";
process.env.ANTIGRAVITY_CLIENT_SECRET = "fake-runtime-secret";
let hostOAuthCalls = 0;
globalThis.pi = {
  providers: { oauth: { async notify() {}, async prompt() { throw new Error("Refresh must not prompt"); } } },
  net: { async fetch(input) {
    hostOAuthCalls++;
    assert.equal(input.url, "https://oauth2.googleapis.com/token");
    assert.equal(new URLSearchParams(input.body).get("refresh_token"), "fake-refresh");
    assert.equal(new URLSearchParams(input.body).get("client_id"), "fake-runtime-client");
    assert.equal(new URLSearchParams(input.body).get("client_secret"), "fake-runtime-secret");
    return { status: 200, bodyText: JSON.stringify({ access_token: "fake-host-oauth", refresh_token: "fake-rotated-refresh", expires_in: 3600 }) };
  } },
};
try {
  await assert.rejects(pluginMain.onProviderOAuth({ operation: "login", providerId: "other" }, { signal: new AbortController().signal }), /Unknown OAuth provider/);
  for (const name of ["ANTIGRAVITY_CLIENT_ID", "ANTIGRAVITY_CLIENT_SECRET", "NOAGY_CLIENT_ID", "NOAGY_CLIENT_SECRET"]) delete process.env[name];
  await assert.rejects(pluginMain.onProviderOAuth({ operation: "login", providerId: "antigravity", loginId: "fake-missing-config" }, { signal: new AbortController().signal }), /OAuth client is not configured/);
  await assert.rejects(pluginMain.onProviderOAuth({ operation: "refresh", providerId: "antigravity", credential: { accessToken: "fake-old", refreshToken: "fake-refresh" } }, { signal: new AbortController().signal }), /OAuth client is not configured/);
  assert.equal(hostOAuthCalls, 0);
  process.env.ANTIGRAVITY_CLIENT_ID = "fake-runtime-client";
  process.env.ANTIGRAVITY_CLIENT_SECRET = "fake-runtime-secret";
  const credential = await pluginMain.onProviderOAuth({ operation: "refresh", providerId: "antigravity", credential: { accessToken: "fake-old", refreshToken: "fake-refresh", expiresAt: 0, headers: { "x-pi-antigravity-project": "fake-project" } } }, { signal: new AbortController().signal });
  assert.equal(credential.accessToken, "fake-host-oauth");
  assert.equal(hostOAuthCalls, 1);
} finally { if (originalPi === undefined) delete globalThis.pi; else globalThis.pi = originalPi; }

let mode = "text";
let calls = 0;
let externalCalls = 0;
let activeModel;
let inspectedBody;
let cancelledSource = false;
const response = payload => {
  const data = new TextEncoder().encode(payload.map(chunk => `data: ${JSON.stringify({ response: chunk })}\r\n\r\n`).join(""));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) { if (offset === data.length) { controller.close(); return; } const end = Math.min(data.length, offset + 11); controller.enqueue(data.slice(offset, end)); offset = end; } }), { headers: { "content-type": "text/event-stream" } });
};
const base = async (input, init = {}) => {
  if (String(input) === "https://example.test/unrelated") { externalCalls++; return new Response("unchanged"); }
  assert.equal(String(input), "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  calls++;
  assert.equal(typeof init.signal?.addEventListener, "function");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), "Bearer fake-global-oauth");
  assert.equal(headers.get("x-goog-api-key"), null);
  assert.ok(![...headers.keys()].some(key => key.startsWith("x-pi-antigravity-")));
  inspectedBody = JSON.parse(init.body);
  assert.equal(inspectedBody.project, "fake-project");
  assert.equal(inspectedBody.request.labels.used_claude, activeModel.id.startsWith("claude-") ? "true" : "false");
  assert.match(inspectedBody.request.labels.request_id, /-\d+$/);
  if (mode === "quota") return new Response("Individual quota reached. Resets in 1h", { status: 429 });
  if (mode === "pending") {
    const frame = new TextEncoder().encode(`data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "started" }] } }] } })}\n\n`);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(frame); }, cancel() { cancelledSource = true; } }), { headers: { "content-type": "text/event-stream" } });
  }
  if (mode === "tools") {
    const declaration = inspectedBody.request.tools[0].functionDeclarations[0];
    assert.ok(declaration.parameters); assert.equal(declaration.parametersJsonSchema, undefined);
    return response([{ candidates: [{ content: { role: "model", parts: [{ text: "thinking", thought: true, thoughtSignature: "fake-signature" }] } }] }, { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "cloud-call-1", name: "inspect", args: { path: "." } }, thoughtSignature: "fake-signature" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } }]);
  }
  if (mode === "tool-result") {
    assert.ok(inspectedBody.request.contents.some(turn => turn.parts.some(part => part.functionResponse)));
    assert.ok(inspectedBody.request.contents.some(turn => turn.parts.some(part => part.functionResponse?.id === "cloud-call-1")), "Cloud tool-call ID must survive replay");
    return response([{ candidates: [{ content: { role: "model", parts: [{ text: "tool result accepted" }] }, finishReason: "STOP" }] }]);
  }
  return response([{ candidates: [{ content: { role: "model", parts: [{ text: "native " }] } }] }, { candidates: [{ content: { role: "model", parts: [{ text: "reply" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } }]);
};
const original = globalThis.fetch;
globalThis.fetch = base;
const runnerFile = readdirSync(join(runtime, "chunks")).find(name => /^runner-.*\.js$/.test(name));
assert.ok(runnerFile);
const { TrustedExtensionRunner } = await import(pathToFileURL(join(runtime, "chunks", runnerFile)).href);
const adapterFile = readdirSync(join(runtime, "chunks")).find(name => /^google-generative-ai-.*\.js$/.test(name));
const { stream } = await import(pathToFileURL(join(runtime, "chunks", adapterFile)).href);
const bridge = {
  cwd: home, sessionId: "fake-native-session", publishCommands() {}, publishDiagnostics() {},
  requestUi() { throw new Error("Global provider transport must not require a session UI"); },
  getModel: () => activeModel, getThinkingLevel: () => "high",
  getActiveTools: () => [], getAllTools: () => [], isIdle: () => true, hasPendingMessages: () => false,
  getContextUsage() {}, getSystemPrompt: () => "", modelRegistry: {},
};
const spec = { id: "local.pi-antigravity.desktop:agent-extension.mjs", label: "Antigravity", entry: join(root, "desktop/agent-extension.mjs") };
const a = new TrustedExtensionRunner({ bridge, specs: [spec] });
const b = new TrustedExtensionRunner({ bridge: { ...bridge, sessionId: "second-session" }, specs: [spec] });
let disposedA = false;
try {
  const reports = await a.load();
  assert.ok(reports.every(report => report.state === "loaded"), JSON.stringify(a.getDiagnostics()));
  assert.deepEqual(a.getCommands(), [], "Old runtime-dependent login commands must not be registered");
  assert.deepEqual(a.getAgents(), [], "Models are global services, not session Agents");
  const installedWrapper = globalThis.fetch;
  await b.load(); assert.equal(globalThis.fetch, installedWrapper);
  let replacementCalls = 0;
  const replacementFetch = (...args) => { replacementCalls++; return base(...args); };
  // Desktop 0.18 reapplies proxy transport after extension load and on recovery.
  globalThis.fetch = replacementFetch;
  activeModel = { provider: "openai" };
  const unrelatedHeaders = { "x-unrelated": "keep" };
  await a.emit("before_provider_headers", { type: "before_provider_headers", headers: unrelatedHeaders });
  assert.deepEqual(unrelatedHeaders, { "x-unrelated": "keep" });
  assert.equal(globalThis.fetch, replacementFetch, "Unrelated providers must not reinstall the wrapper");
  function model(id) { const entry = provider.models.find(value => value.id === id); return { id, name: entry.name, api: "google-generative-ai", provider: provider.vendorKey, baseUrl: provider.baseUrl, reasoning: true, input: ["text", "image"], contextWindow: entry.contextWindow, maxTokens: entry.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }; }
  const context = { messages: [{ role: "user", content: [{ type: "text", text: "offline test" }], timestamp: Date.now() }] };
  const options = { apiKey: "fake-global-oauth", signal: new AbortController().signal, maxRetries: 0, headers: { "x-pi-antigravity-transport": "native-v2", "x-pi-antigravity-project": "fake-project" }, onPayload: payload => a.emit("before_provider_request", { type: "before_provider_request", payload }, (_prior, result) => result) };
  activeModel = model("gemini-3.8-flash");
  await a.emit("before_provider_headers", { type: "before_provider_headers", headers: options.headers });
  assert.notEqual(globalThis.fetch, replacementFetch, "Host transport reset must not remove Antigravity adaptation");
  const preservedSignal = new AbortController().signal;
  const untouchedPayload = { config: { abortSignal: preservedSignal } };
  assert.equal(await options.onPayload(untouchedPayload), undefined, "Recovery hook must never return a cloned payload");
  assert.equal(untouchedPayload.config.abortSignal, preservedSignal);
  const output = stream(activeModel, context, options); let deltas = 0;
  for await (const event of output) if (event.type === "text_delta") deltas++;
  const text = await output.result(); assert.equal(text.stopReason, "stop", text.errorMessage); assert.ok(deltas >= 2);
  assert.equal(inspectedBody.model, "gemini-3.8-flash-high");
  assert.ok(inspectedBody.requestId.includes("fake-native-session"));
  globalThis.fetch = replacementFetch;
  mode = "tools"; activeModel = model("claude-opus-4-6");
  const toolContext = { messages: [{ role: "system", content: "", timestamp: Date.now(), toolsAdded: [{ name: "inspect", description: "inspect", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] }, ...context.messages] };
  const tools = await stream(activeModel, toolContext, options).result(); assert.equal(tools.stopReason, "toolUse", tools.errorMessage);
  const call = tools.content.find(part => part.type === "toolCall"); assert.ok(call); assert.ok(tools.content.some(part => part.type === "thinking"));
  mode = "tool-result";
  const replay = { ...toolContext, messages: [...toolContext.messages, tools, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() }] };
  assert.equal((await stream(activeModel, replay, options).result()).stopReason, "stop");
  mode = "quota";
  const quota = await stream(activeModel, context, options).result(); assert.equal(quota.stopReason, "error");
  mode = "pending";
  const controller = new AbortController();
  const cancelled = stream(activeModel, context, { ...options, signal: controller.signal });
  for await (const event of cancelled) if (event.type === "text_delta") controller.abort();
  assert.equal((await cancelled.result()).stopReason, "aborted");
  assert.equal(cancelledSource, true, "Stopping a chat must cancel its upstream response");
  const callsBeforeAbort = calls;
  assert.equal((await stream(activeModel, context, { ...options, signal: controller.signal }).result()).stopReason, "aborted");
  assert.equal(calls, callsBeforeAbort, "Already cancelled requests must not reach the network");
  assert.equal(await (await fetch("https://example.test/unrelated")).text(), "unchanged");
  const latestWrapper = globalThis.fetch;
  await a.dispose(); disposedA = true; assert.equal(globalThis.fetch, latestWrapper);
  await b.dispose(); assert.equal(globalThis.fetch, replacementFetch);
  assert.ok(replacementCalls >= 5, "Use the latest host proxy transport, not the captured startup fetch");
  assert.equal(a.getDiagnostics().length, 0); assert.equal(existsSync(join(home, "cli-must-not-be-read")), false);
  console.log(JSON.stringify({ version: manifest.version, globalProvider: provider.name, registeredGlobalModels: provider.models.length, reports, oldSessionCommands: 0, textDeltas: deltas, thinkingAndTools: true, multiTurnToolReplay: true, abortSignalPreserved: true, midStreamCancellation: cancelledSource, hostTransportResetRecovery: true, latestHostTransportCalls: replacementCalls, refCountedUnload: true, interceptedRequests: calls, unrelatedRequestsPreserved: externalCalls, liveNetworkRequests: 0 }, null, 2));
  console.log("PASS actual Desktop runner + native Google adapter integration (global provider, no local HTTP server).");
} finally {
  if (!disposedA) await a.dispose(); await b.dispose(); globalThis.fetch = original;
  rmSync(home, { recursive: true, force: true });
}
