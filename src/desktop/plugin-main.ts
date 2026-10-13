import { createProviderOAuth } from "./provider-oauth.js";
import type { OAuthRequest, PluginHostApi } from "./native-contract.js";
import { handlePanelInvoke } from "./panel-handler.js";

declare const pi: PluginHostApi;

export function onLoad(): void {}
export function onUnload(): void {}

export async function onProviderOAuth(request: OAuthRequest, context: { signal: AbortSignal }) {
  return createProviderOAuth(pi)(request, context);
}

export async function onPanelInvoke(channel: string, payload: Record<string, unknown>) {
  return handlePanelInvoke(channel, payload, typeof pi !== "undefined" ? pi : undefined);
}
