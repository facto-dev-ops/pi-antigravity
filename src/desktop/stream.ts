import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { ANTIGRAVITY_API, streamAntigravity } from "../stream/index.js";
import { DEFAULT_ENDPOINT } from "../client/index.js";
import { redactSecrets } from "../utils/index.js";
import type { AntigravityStreamOptions } from "../types/types.js";
import { type DesktopAuthStore } from "./auth.js";

function identity(message: AssistantMessage, model: Model<Api>): AssistantMessage {
  return { ...message, api: model.api, provider: model.provider, model: model.id };
}

function remapEvent(event: AssistantMessageEvent, model: Model<Api>): AssistantMessageEvent {
  if ("partial" in event) return { ...event, partial: identity(event.partial, model) };
  if ("message" in event) return { ...event, message: identity(event.message, model) };
  if ("error" in event) return { ...event, error: identity(event.error, model) };
  return event;
}

export function createDesktopStream(auth: DesktopAuthStore, upstream = streamAntigravity) {
  return (model: Model<Api>, context: Context, options: AntigravityStreamOptions = {}) => {
    const output = createAssistantMessageEventStream();
    void auth.scoped(async () => {
      try {
        options.signal?.throwIfAborted();
        const apiKey = await auth.apiKey(options.signal);
        options.signal?.throwIfAborted();
        // Desktop supplies its own placeholder API key. Never forward that key.
        const native = {
          ...model,
          provider: "antigravity",
          api: ANTIGRAVITY_API,
          baseUrl: DEFAULT_ENDPOINT,
        };
        const nativeContext = {
          ...context,
          messages: context.messages.map((message) =>
            message.role === "assistant" &&
            message.provider === model.provider &&
            message.api === model.api
              ? { ...message, provider: native.provider, api: native.api }
              : message,
          ),
        };
        const source = upstream(native, nativeContext, {
          ...options,
          apiKey,
          accountFailover: false,
        });
        for await (const event of source) output.push(remapEvent(event, model));
        output.end(identity(await source.result(), model));
      } catch (error) {
        const aborted =
          options.signal?.aborted || (error instanceof Error && error.name === "AbortError");
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: aborted ? "aborted" : "error",
          errorMessage: aborted
            ? "Antigravity 请求已取消。"
            : redactSecrets(error instanceof Error ? error.message : String(error)),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        output.push({
          type: "error",
          reason: message.stopReason as "aborted" | "error",
          error: message,
        });
        output.end(message);
      }
    }, options.signal);
    return output;
  };
}
