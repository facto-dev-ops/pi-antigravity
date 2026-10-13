import { loginAntigravity, refreshAntigravityToken } from "../auth/oauth.js";
import { defaultProjectId } from "../client/client.js";
import { maskEmail } from "../utils/security.js";
import type { AntigravityOAuthCredentials } from "../types/types.js";
import { PROJECT_HEADER, TRANSPORT_HEADER, TRANSPORT_VERSION } from "./native-contract.js";
import type { HostCredential, OAuthRequest, PluginHostApi } from "./native-contract.js";
import { withAntigravityFetch } from "../utils/fetch-context.js";
import { createHostFetch } from "./host-fetch.js";

type Dependencies = { login?: typeof loginAntigravity; refresh?: typeof refreshAntigravityToken };

function hostCredential(value: AntigravityOAuthCredentials): HostCredential {
  if (
    !value.access ||
    !value.refresh ||
    !Number.isSafeInteger(value.expires) ||
    value.expires <= 0
  ) {
    throw new Error("Google returned incomplete OAuth credentials.");
  }
  return {
    accessToken: value.access,
    refreshToken: value.refresh,
    expiresAt: value.expires,
    accountLabel: value.email ? maskEmail(value.email) : "Google Antigravity",
    headers: {
      [TRANSPORT_HEADER]: TRANSPORT_VERSION,
      [PROJECT_HEADER]: value.projectId || defaultProjectId(value.email || "antigravity-default"),
    },
  };
}

export function createProviderOAuth(api: PluginHostApi, dependencies: Dependencies = {}) {
  const login = dependencies.login || loginAntigravity;
  const refresh = dependencies.refresh || refreshAntigravityToken;
  return async (request: OAuthRequest, context: { signal: AbortSignal }): Promise<HostCredential> =>
    withAntigravityFetch(createHostFetch(api), async () => {
      if (!request || request.providerId !== "antigravity")
        throw new Error("Unknown OAuth provider.");
      context.signal.throwIfAborted();
      if (request.operation === "refresh") {
        const previous = request.credential;
        if (!previous?.accessToken || !previous.refreshToken)
          throw new Error("Google sign-in is required.");
        const value = await refresh(
          {
            access: previous.accessToken,
            refresh: previous.refreshToken,
            expires: previous.expiresAt || 0,
            projectId: previous.headers?.[PROJECT_HEADER],
          },
          context.signal,
        );
        context.signal.throwIfAborted();
        return {
          ...hostCredential(value),
          accountLabel: previous.accountLabel || "Google Antigravity",
        };
      }
      if (request.operation !== "login" || !request.loginId)
        throw new Error("Invalid OAuth operation.");
      const loginId = request.loginId;
      let announcement: Promise<void> = Promise.resolve();
      const pendingNotifications: Promise<void>[] = [];
      let notificationError: unknown;
      const track = (pending: Promise<void>) => {
        pendingNotifications.push(pending);
        pending.catch((error) => {
          notificationError = error;
        });
        return pending;
      };
      const value = await login({
        signal: context.signal,
        onAuth: (info) => {
          const url = new URL(info.url);
          if (
            url.protocol !== "https:" ||
            url.hostname !== "accounts.google.com" ||
            url.username ||
            url.password
          ) {
            throw new Error("Refused an invalid Google authorization URL.");
          }
          // The host opens the URL and owns the progress/dialog lifetime.
          announcement = track(api.providers.oauth.notify(loginId, { kind: "authUrl", ...info }));
        },
        onPrompt: async (prompt) => {
          await announcement;
          context.signal.throwIfAborted();
          return api.providers.oauth.prompt(loginId, {
            type: "manual_code",
            message: prompt.message,
            placeholder: prompt.placeholder,
          });
        },
        onSelect: async (prompt) =>
          api.providers.oauth.prompt(loginId, {
            type: "select",
            message: prompt.message,
            options: prompt.options,
          }),
        onDeviceCode: () => {
          throw new Error("Antigravity uses browser OAuth, not a device-code flow.");
        },
        onProgress: (message) => {
          void track(api.providers.oauth.notify(loginId, { kind: "progress", message }));
        },
      });
      context.signal.throwIfAborted();
      await Promise.all(pendingNotifications);
      context.signal.throwIfAborted();
      if (notificationError) throw new Error("Desktop could not complete the OAuth interaction.");
      // Never write auth.json or other token files; Desktop encrypts this result.
      return hostCredential(value);
    });
}
