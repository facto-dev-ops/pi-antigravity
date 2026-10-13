import assert from "node:assert/strict";
import { createProviderOAuth } from "../src/desktop/provider-oauth.js";
import { acquireNativeTransport, refreshNativeTransport, wrapNativeRequest } from "../src/desktop/native-transport.js";
import { unwrapNativeSse } from "../src/desktop/native-response.js";
import { CLOUD_ORIGIN, EFFORT_HEADER, PROJECT_HEADER, SESSION_HEADER, TRANSPORT_HEADER, TRANSPORT_VERSION } from "../src/desktop/native-contract.js";
import type { PluginHostApi } from "../src/desktop/native-contract.js";
import type { loginAntigravity } from "../src/auth/oauth.js";

let passed = 0;
async function test(name: string, operation: () => Promise<void>) { await operation(); passed++; console.log(`PASS ${name}`); }
const fresh = { access: "fake-native-access", refresh: "fake-native-refresh", expires: Date.now() + 3600000, email: "user@example.test", projectId: "fake-project" };
const signal = () => new AbortController().signal;
const headers = () => new Headers({ [TRANSPORT_HEADER]: TRANSPORT_VERSION, [PROJECT_HEADER]: "fake-project", [SESSION_HEADER]: "test-session", [EFFORT_HEADER]: "high", "x-goog-api-key": fresh.access });
const body = { contents: [{ role: "user", parts: [{ text: "你好" }] }], generationConfig: { maxOutputTokens: 999999, temperature: 0.4 } };
const url = `${CLOUD_ORIGIN}/models/gemini-3.8-flash:streamGenerateContent?alt=sse`;
const init = () => ({ method: "POST", headers: headers(), body: JSON.stringify(body) });
const originalFetch = globalThis.fetch;
function byteStream(text: string, size = 7) {
  const data = new TextEncoder().encode(text); let offset = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) { if (offset === data.length) { controller.close(); return; } const end = Math.min(data.length, offset + size); controller.enqueue(data.slice(offset, end)); offset = end; } });
}
const sse = (text = "你好") => `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }] } })}\r\n\r\n`;
const apiEvents: Record<string, unknown>[] = [];
const api: PluginHostApi = { providers: { oauth: { async notify(_loginId, event) { apiEvents.push(event); }, async prompt(_loginId, prompt) { assert.equal(prompt.type, "manual_code"); return "fake-callback"; } } } };

try {
  await test("global OAuth forwards native host interactions and returns encrypted-store contract", async () => {
    const fake: typeof loginAntigravity = async callbacks => { callbacks.onAuth({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=fake" }); assert.equal(await callbacks.onPrompt({ message: "callback" }), "fake-callback"); return fresh; };
    const result = await createProviderOAuth(api, { login: fake })({ operation: "login", providerId: "antigravity", loginId: "fake-login" }, { signal: signal() });
    assert.equal(result.accessToken, fresh.access); assert.equal(result.refreshToken, fresh.refresh);
    assert.equal(result.headers![TRANSPORT_HEADER], TRANSPORT_VERSION); assert.equal(result.headers![PROJECT_HEADER], fresh.projectId);
    assert.equal(Object.keys(result.headers!).some(name => /authorization|key/i.test(name)), false);
    assert.ok(apiEvents.some(event => event.kind === "authUrl"));
    assert.ok(!JSON.stringify(apiEvents).includes(fresh.access));
  });
  await test("global refresh preserves project and account label", async () => {
    const result = await createProviderOAuth(api, { refresh: async (value, incomingSignal) => { assert.equal(incomingSignal!.aborted, false); assert.equal((value as typeof fresh).projectId, "fake-project"); return { ...fresh, access: "fake-rotated", refresh: "fake-rotated-refresh" }; } })({ operation: "refresh", providerId: "antigravity", credential: { accessToken: fresh.access, refreshToken: fresh.refresh, expiresAt: 0, accountLabel: "Google account", headers: { [PROJECT_HEADER]: "fake-project" } } }, { signal: signal() });
    assert.equal(result.accessToken, "fake-rotated"); assert.equal(result.accountLabel, "Google account");
  });
  await test("cancelled OAuth returns no credential", async () => {
    const abort = new AbortController(); abort.abort();
    let called = false; const fake: typeof loginAntigravity = async () => { called = true; return fresh; };
    await assert.rejects(createProviderOAuth(api, { login: fake })({ operation: "login", providerId: "antigravity", loginId: "fake" }, { signal: abort.signal })); assert.equal(called, false);
  });
  await test("unexpected OAuth provider and authorization host are rejected", async () => {
    await assert.rejects(createProviderOAuth(api)({ operation: "login", providerId: "other", loginId: "fake" }, { signal: signal() }));
    const fake: typeof loginAntigravity = async callbacks => { callbacks.onAuth({ url: "https://accounts.google.com.evil.test/" }); return fresh; };
    await assert.rejects(createProviderOAuth(api, { login: fake })({ operation: "login", providerId: "antigravity", loginId: "fake" }, { signal: signal() }));
  });
  await test("native envelope routes thinking, limits output and retains input data", async () => {
    const result = wrapNativeRequest("gemini-3.8-flash", body, headers()) as { model: string; request: typeof body & { labels: Record<string, string>; sessionId: string } };
    assert.equal(result.model, "gemini-3.8-flash-high"); assert.equal(result.request.generationConfig.maxOutputTokens, 65536);
    assert.equal(result.request.generationConfig.temperature, 0.4); assert.equal(result.request.contents[0]!.parts[0]!.text, "你好");
    assert.equal(body.generationConfig.maxOutputTokens, 999999); assert.equal(result.request.labels.used_non_gemini_model, "false");
    assert.match(result.request.sessionId, /^\d+$/);
  });
  await test("Claude tool schema uses legacy custom-tool bridge", async () => {
    const native = { ...body, tools: [{ functionDeclarations: [{ name: "inspect", description: "inspect", parametersJsonSchema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false } }] }] };
    const result = wrapNativeRequest("claude-opus-4-6", native, headers()) as { request: { tools: { functionDeclarations: { parameters?: unknown; parametersJsonSchema?: unknown }[] }[] } };
    assert.ok(result.request.tools[0]!.functionDeclarations[0]!.parameters); assert.equal(result.request.tools[0]!.functionDeclarations[0]!.parametersJsonSchema, undefined);
  });
  await test("SSE handles Unicode, arbitrary byte boundaries, CRLF, comments and DONE", async () => {
    const source = byteStream(`: heartbeat\r\n\r\n${sse()}data: [DONE]\r\n\r\n`, 1);
    const text = await new Response(unwrapNativeSse(source, signal())).text();
    assert.ok(text.includes("你好")); assert.ok(!text.includes('"response"')); assert.ok(!text.includes("[DONE]"));
  });
  await test("SSE handles multiline data and final frame without blank line", async () => {
    const input = 'data: {"response":\ndata: {"candidates":[]}}';
    assert.equal(await new Response(unwrapNativeSse(byteStream(input), signal())).text(), 'data: {"candidates":[]}\n\n');
  });
  await test("SSE invalid JSON errors do not echo request or token", async () => {
    await assert.rejects(new Response(unwrapNativeSse(byteStream(`data: ${fresh.access}\n\n`), signal())).text(), error => String(error).includes("invalid SSE JSON") && !String(error).includes(fresh.access));
  });
  await test("SSE cancellation retires the upstream reader", async () => {
    const abort = new AbortController(); let cancelled = false;
    const response = new Response(unwrapNativeSse(new ReadableStream({ cancel() { cancelled = true; } }), abort.signal));
    const pending = response.text(); abort.abort(); await assert.rejects(pending); assert.equal(cancelled, true);
  });
  await test("native wire converts auth/path, strips metadata and forwards streamed replies", async () => {
    globalThis.fetch = async (input, request) => {
      assert.equal(String(input), `${CLOUD_ORIGIN}/v1internal:streamGenerateContent?alt=sse`);
      const outgoing = new Headers(request!.headers); assert.equal(outgoing.get("authorization"), `Bearer ${fresh.access}`);
      assert.equal(outgoing.get("x-goog-api-key"), null); assert.equal(outgoing.get(TRANSPORT_HEADER), null);
      assert.equal(request!.redirect, "error"); assert.equal(JSON.parse(request!.body as string).model, "gemini-3.8-flash-high");
      return new Response(byteStream(sse()), { headers: { "content-type": "text/event-stream" } });
    };
    const release = acquireNativeTransport();
    try { assert.ok((await (await fetch(url, init())).text()).includes("你好")); } finally { release(); }
  });
  await test("ordinary providers are forwarded without body reads or mutation", async () => {
    const request = new Request("https://example.test/", { method: "POST", body: "unchanged" });
    globalThis.fetch = async input => { assert.equal(input, request); assert.equal(request.bodyUsed, false); return new Response("ok"); };
    const base = globalThis.fetch; const release = acquireNativeTransport();
    try { assert.equal(await (await fetch(request)).text(), "ok"); } finally { release(); }
    assert.equal(globalThis.fetch, base);
  });
  await test("marked credentials never go to foreign origins or unsupported paths", async () => {
    let calls = 0; globalThis.fetch = async () => { calls++; return new Response("bad"); };
    const release = acquireNativeTransport();
    try { await assert.rejects(fetch("https://example.test/models/test:streamGenerateContent", init())); await assert.rejects(fetch(`${CLOUD_ORIGIN}/v1/models`, init())); assert.equal(calls, 0); } finally { release(); }
  });
  await test("Request objects are cloned without consuming the caller's body", async () => {
    globalThis.fetch = async () => new Response(byteStream(sse())); const release = acquireNativeTransport();
    try { const request = new Request(url, init()); await (await fetch(request)).text(); assert.equal(request.bodyUsed, false); } finally { release(); }
  });
  await test("HTTP errors are passed through unchanged without retry or account switching", async () => {
    const denied = new Response("quota exhausted", { status: 429 }); let calls = 0;
    globalThis.fetch = async () => { calls++; return denied; }; const release = acquireNativeTransport();
    try { assert.equal(await fetch(url, init()), denied); assert.equal(calls, 1); } finally { release(); }
  });
  await test("multiple sessions share one wrapper and restore only after last unload", async () => {
    globalThis.fetch = async () => new Response("ok"); const base = globalThis.fetch;
    const a = acquireNativeTransport(); const wrapper = globalThis.fetch; const b = acquireNativeTransport(); assert.equal(globalThis.fetch, wrapper);
    a(); a(); assert.equal(globalThis.fetch, wrapper); b(); assert.equal(globalThis.fetch, base);
  });
  await test("host proxy reset uses the latest transport and restores it on unload", async () => {
    let oldCalls = 0; let newCalls = 0;
    globalThis.fetch = async () => { oldCalls++; throw new Error("obsolete transport"); };
    const release = acquireNativeTransport();
    const replacement: typeof fetch = async (input, request) => {
      newCalls++; assert.equal(String(input), `${CLOUD_ORIGIN}/v1internal:streamGenerateContent?alt=sse`);
      assert.equal((request as RequestInit & { dispatcher?: unknown }).dispatcher, "host-proxy");
      return new Response(byteStream(sse()));
    };
    globalThis.fetch = replacement; refreshNativeTransport();
    const wrapper = globalThis.fetch; refreshNativeTransport(); assert.equal(globalThis.fetch, wrapper);
    try { await (await fetch(url, { ...init(), dispatcher: "host-proxy" } as RequestInit)).text(); assert.equal(oldCalls, 0); assert.equal(newCalls, 1); } finally { release(); }
    assert.equal(globalThis.fetch, replacement);
    refreshNativeTransport(); assert.equal(globalThis.fetch, replacement);
  });
  await test("refresh around another extension does not recurse or convert twice", async () => {
    let calls = 0;
    globalThis.fetch = async (input, request) => {
      calls++; assert.equal(String(input), `${CLOUD_ORIGIN}/v1internal:streamGenerateContent?alt=sse`);
      assert.equal(new Headers(request!.headers).get(TRANSPORT_HEADER), null);
      return new Response(byteStream(sse()));
    };
    const release = acquireNativeTransport(); const native = globalThis.fetch;
    const other: typeof fetch = (...args) => native(...args);
    globalThis.fetch = other; refreshNativeTransport();
    try { await (await fetch(url, init())).text(); assert.equal(calls, 1); } finally { release(); }
    assert.equal(globalThis.fetch, other);
  });
  await test("a second session repairs a host reset without losing the first owner", async () => {
    globalThis.fetch = async () => new Response("old"); const a = acquireNativeTransport();
    const replacement: typeof fetch = async () => new Response(byteStream(sse()));
    globalThis.fetch = replacement; const b = acquireNativeTransport(); const wrapper = globalThis.fetch;
    try { a(); assert.equal(globalThis.fetch, wrapper); await (await fetch(url, init())).text(); } finally { a(); b(); }
    assert.equal(globalThis.fetch, replacement);
  });
  await test("unload does not overwrite another plugin's fetch wrapper", async () => {
    globalThis.fetch = async () => new Response("ok"); const release = acquireNativeTransport(); const native = globalThis.fetch;
    const other: typeof fetch = (...args) => native(...args); globalThis.fetch = other;
    release(); assert.equal(globalThis.fetch, other); await assert.rejects(fetch(url, init()), /disabled/);
  });
  await test("last unload aborts an in-flight marked request", async () => {
    let reached!: () => void; const started = new Promise<void>(resolve => { reached = resolve; });
    globalThis.fetch = async (_input, request) => { reached(); return new Promise((_resolve, reject) => request!.signal!.addEventListener("abort", () => reject(request!.signal!.reason), { once: true })); };
    const release = acquireNativeTransport(); const pending = fetch(url, init()); await started; release(); await assert.rejects(pending);
  });
  await test("non-streaming native replies are unwrapped", async () => {
    globalThis.fetch = async input => { assert.equal(String(input), `${CLOUD_ORIGIN}/v1internal:generateContent`); return Response.json({ response: { candidates: [] } }); }; const release = acquireNativeTransport();
    try { assert.deepEqual(await (await fetch(`${CLOUD_ORIGIN}/models/gemini-3.8-flash:generateContent`, init())).json(), { candidates: [] }); } finally { release(); }
  });
  await test("late OAuth cancellation while host notification settles returns no token", async () => {
    const controller = new AbortController();
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const host: PluginHostApi = { providers: { oauth: { notify: () => waiting, prompt: async () => "unused" } } };
    const fake: typeof loginAntigravity = async callbacks => { callbacks.onAuth({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=fake" }); return fresh; };
    const pending = createProviderOAuth(host, { login: fake })({ operation: "login", providerId: "antigravity", loginId: "fake" }, { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort(); finish(); await assert.rejects(pending);
  });
  await test("abort after unterminated final SSE frame and EOF never hangs the next read", async () => {
    const controller = new AbortController();
    const bytes = new TextEncoder().encode('data: {"response":{"candidates":[]}}');
    const source = new ReadableStream<Uint8Array>({ start(value) { value.enqueue(bytes); value.close(); } });
    const reader = unwrapNativeSse(source, controller.signal).getReader();
    assert.equal((await reader.read()).done, false);
    controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([reader.read().then(() => "done", () => "aborted"), new Promise<string>(resolve => { timer = setTimeout(() => resolve("hung"), 300); })]);
      assert.notEqual(result, "hung");
    } finally { if (timer) clearTimeout(timer); await reader.cancel().catch(() => {}); }
  });
  console.log(`Global native adapter: ${passed} tests passed (no real tokens, network or HTTP servers).`);
} finally { globalThis.fetch = originalFetch; }
