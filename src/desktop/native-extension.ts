import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { acquireNativeTransport, refreshNativeTransport } from "./native-transport.js";
import {
  EFFORT_HEADER,
  GLOBAL_PROVIDER_ID,
  GLOBAL_VENDOR_KEY,
  SESSION_HEADER,
} from "./native-contract.js";

export default function (pi: ExtensionAPI): void {
  const release = acquireNativeTransport();
  pi.on("session_shutdown", release);
  // Desktop clones payload hook inputs/results, which destroys AbortSignal.
  // Mutate only headers so the adapter retains the original request and signal.
  pi.on("before_provider_headers", (event, ctx) => {
    if (![GLOBAL_PROVIDER_ID, GLOBAL_VENDOR_KEY].includes(ctx.model?.provider || "")) return;
    refreshNativeTransport();
    event.headers[EFFORT_HEADER] = pi.getThinkingLevel();
    event.headers[SESSION_HEADER] = ctx.sessionManager.getSessionId();
  });
  // Recover after host proxy changes/retries, including later tool-loop requests.
  // Return nothing: round-tripping the payload would clone its AbortSignal.
  pi.on("before_provider_request", (_event, ctx) => {
    if (![GLOBAL_PROVIDER_ID, GLOBAL_VENDOR_KEY].includes(ctx.model?.provider || "")) return;
    refreshNativeTransport();
  });
}
