import { createHash, randomUUID } from "node:crypto";
import { antigravityHeaders } from "../client/client.js";
import {
  getAntigravityRequestModelId,
  getMaxOutputTokens,
  getThinkingConfig,
} from "../models/models.js";
import { convertTools } from "../stream/stream.js";
import { antigravityRequestEnvelope } from "../utils/util.js";
import {
  CLOUD_ORIGIN,
  EFFORT_HEADER,
  PROJECT_HEADER,
  SESSION_HEADER,
  TRANSPORT_HEADER,
  TRANSPORT_VERSION,
} from "./native-contract.js";
import { unwrapNativeSse } from "./native-response.js";

const SLOT = Symbol.for("local.pi-antigravity.desktop.native-transport.v2");
const MAX_BODY_CHARS = 24 * 1024 * 1024;
type State = {
  base: typeof fetch;
  wrapper: typeof fetch;
  owners: Set<symbol>;
  lifetime: AbortController;
};
type SharedGlobal = typeof globalThis & { [SLOT]?: State };
type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

function inferEffort(body: Json, headers: Headers): string {
  const explicit = headers.get(EFFORT_HEADER);
  if (explicit && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(explicit))
    return explicit;
  const config = record(record(body.generationConfig).thinkingConfig);
  if (typeof config.thinkingLevel === "string") return config.thinkingLevel.toLowerCase();
  if (config.thinkingBudget === 0) return "off";
  return "high";
}

export function wrapNativeRequest(modelId: string, body: Json, headers: Headers): Json {
  const project = headers.get(PROJECT_HEADER);
  if (!project || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,1023}$/.test(project))
    throw new Error("Antigravity project metadata is missing or invalid. Sign in again.");
  if (!Array.isArray(body.contents)) throw new Error("Invalid Gemini native request contents.");
  const effort = inferEffort(body, headers);
  const runtimeModel = getAntigravityRequestModelId(modelId, effort);
  const request = structuredClone(body);
  const generation = record(request.generationConfig);
  const thinking = getThinkingConfig(runtimeModel, effort);
  if (thinking) generation.thinkingConfig = thinking;
  else delete generation.thinkingConfig;
  const max = getMaxOutputTokens(modelId, runtimeModel);
  generation.maxOutputTokens = Math.min(
    typeof generation.maxOutputTokens === "number" && generation.maxOutputTokens > 0
      ? generation.maxOutputTokens
      : max,
    max,
  );
  request.generationConfig = generation;
  if (request.systemInstruction)
    request.systemInstruction = { ...record(request.systemInstruction), role: "user" };
  if (!modelId.startsWith("gemini-") && Array.isArray(request.tools)) {
    request.tools = request.tools.map((tool) => {
      const value = record(tool);
      if (!Array.isArray(value.functionDeclarations)) return value;
      const declarations = value.functionDeclarations.map((raw) => {
        const item = record(raw);
        return {
          name: String(item.name || ""),
          description: String(item.description || ""),
          parameters: record(item.parametersJsonSchema ?? item.parameters),
        };
      });
      return convertTools(declarations, true)?.[0] || { functionDeclarations: [] };
    });
  }
  const session = headers.get(SESSION_HEADER) || randomUUID();
  const hash = createHash("sha256").update(`desktop-antigravity:${session}`).digest("hex");
  const trajectory = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  const contents = body.contents as Json[];
  const envelope = antigravityRequestEnvelope(runtimeModel, {
    isClaude: modelId.startsWith("claude-"),
    isNonGemini: !modelId.startsWith("gemini-"),
    step: Math.max(1, contents.length),
    requestIndex: contents.filter((turn) => turn.role === "model").length,
    conversationId: session,
    trajectoryId: trajectory,
    sessionId: (BigInt(`0x${hash.slice(0, 16)}`) & 0x7fffffffffffffffn).toString(),
  });
  request.sessionId = envelope.sessionId;
  request.labels = envelope.labels;
  return {
    project,
    model: runtimeModel,
    request,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: envelope.requestId,
  };
}

function createWrapper(state: State, base: typeof fetch = state.base): typeof fetch {
  return async (input, init = {}) => {
    const inherited = input instanceof Request ? input : undefined;
    const address = inherited ? inherited.url : String(input);
    const headers = new Headers(init.headers ?? inherited?.headers);
    if (headers.get(TRANSPORT_HEADER) !== TRANSPORT_VERSION) return base(input, init);
    if (!state.owners.size) throw new Error("Antigravity native transport is disabled.");
    const url = new URL(address);
    if (url.origin !== CLOUD_ORIGIN || url.username || url.password)
      throw new Error("Refused Antigravity credentials on an unexpected origin.");
    const match = url.pathname.match(
      /^\/(?:v1beta\/)?models\/(.+):(streamGenerateContent|generateContent)$/,
    );
    if (!match || (init.method || inherited?.method || "GET").toUpperCase() !== "POST")
      throw new Error("Unsupported Antigravity native request path.");
    const token = headers.get("x-goog-api-key");
    if (!token) throw new Error("Antigravity OAuth token is missing. Sign in from Settings.");
    const originalSignal = init.signal || inherited?.signal;
    const signal = originalSignal
      ? AbortSignal.any([originalSignal, state.lifetime.signal])
      : state.lifetime.signal;
    signal.throwIfAborted();
    const raw =
      typeof init.body === "string"
        ? init.body
        : inherited && init.body === undefined
          ? await inherited.clone().text()
          : undefined;
    if (!raw || raw.length > MAX_BODY_CHARS)
      throw new Error("Invalid or oversized Gemini native request body.");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error("Invalid Gemini native request JSON.");
    }
    const wrapped = wrapNativeRequest(decodeURIComponent(match[1]), record(body), headers);
    for (const name of [...headers.keys()])
      if (
        name.startsWith("x-pi-antigravity-") ||
        name === "x-goog-api-key" ||
        name === "content-length"
      )
        headers.delete(name);
    for (const [name, value] of Object.entries(antigravityHeaders(token))) headers.set(name, value);
    const streaming = match[2] === "streamGenerateContent";
    const target = `${CLOUD_ORIGIN}/v1internal:${match[2]}${streaming ? "?alt=sse" : ""}`;
    const response = await base(target, {
      ...init,
      method: "POST",
      headers,
      body: JSON.stringify(wrapped),
      signal,
      redirect: "error",
    });
    signal.throwIfAborted();
    if (!response.ok || !response.body) return response;
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");
    responseHeaders.delete("content-encoding");
    if (streaming) {
      responseHeaders.set("content-type", "text/event-stream");
      return new Response(unwrapNativeSse(response.body, signal), {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }
    const result = record(await response.json());
    return new Response(JSON.stringify(result.response ?? result), {
      status: response.status,
      headers: responseHeaders,
    });
  };
}

/** Desktop can replace fetch when applying a proxy or recovering its network pool. */
export function refreshNativeTransport(): void {
  const state = (globalThis as SharedGlobal)[SLOT];
  if (!state?.owners.size || globalThis.fetch === state.wrapper) return;
  // Capture each layer's base: mutating an older layer would recurse if another
  // extension delegates to it. Internal headers are stripped before delegation.
  state.base = globalThis.fetch;
  state.wrapper = createWrapper(state);
  globalThis.fetch = state.wrapper;
}

/** Shared across session runners; do not wrap twice or clobber another extension's fetch. */
export function acquireNativeTransport(): () => void {
  const global = globalThis as SharedGlobal;
  let state = global[SLOT];
  if (!state || !state.owners.size) {
    const base = globalThis.fetch;
    state = { base, wrapper: base, owners: new Set(), lifetime: new AbortController() };
    state.wrapper = createWrapper(state);
    global[SLOT] = state;
    globalThis.fetch = state.wrapper;
  }
  const owner = Symbol();
  state.owners.add(owner);
  refreshNativeTransport();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.owners.delete(owner);
    if (state.owners.size) return;
    state.lifetime.abort(new DOMException("Antigravity extension unloaded", "AbortError"));
    if (globalThis.fetch === state.wrapper) globalThis.fetch = state.base;
    if (global[SLOT] === state) delete global[SLOT];
  };
}
