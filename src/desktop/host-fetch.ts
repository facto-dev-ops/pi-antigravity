import type { ScopedFetch } from "../utils/fetch-context.js";
import type { PluginHostApi } from "./native-contract.js";

export const OAUTH_NETWORK_DOMAINS = [
  "oauth2.googleapis.com",
  "www.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.sandbox.googleapis.com",
  "cloudcode-pa.googleapis.com",
];

/** OAuth runs in a separate plugin process, not the proxy-configured sidecar. */
export function createHostFetch(api: PluginHostApi): ScopedFetch {
  return async (input, init = {}) => {
    if (typeof api.net?.fetch !== "function")
      throw new Error(
        "Desktop net.fetch is required for Antigravity OAuth. Update the plugin and approve its network permission.",
      );
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !OAUTH_NETWORK_DOMAINS.includes(url.hostname)
    )
      throw new Error("Refused Antigravity OAuth credentials on an unexpected origin.");
    if (init.body !== undefined && typeof init.body !== "string")
      throw new Error("Unsupported Antigravity OAuth request body.");
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    signal.throwIfAborted();
    const result = await new Promise<
      Awaited<ReturnType<NonNullable<PluginHostApi["net"]>["fetch"]>>
    >((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("OAuth cancelled", "AbortError"),
        );
      };
      signal.addEventListener("abort", abort, { once: true });
      // The host bridge has no AbortSignal parameter. Retire the caller promptly;
      // late host results are discarded and can never save cancelled credentials.
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return api.net!.fetch({
            url: url.href,
            method: init.method || "GET",
            headers: Object.fromEntries(new Headers(init.headers)),
            ...(init.body === undefined ? {} : { body: init.body as string }),
            timeoutMs: 30000,
          });
        })
        .then(resolve, () =>
          reject(
            new Error(
              "Antigravity OAuth network request failed through Desktop. Check the proxy and net.fetch permission.",
            ),
          ),
        )
        .finally(() => signal.removeEventListener("abort", abort));
    });
    signal.throwIfAborted();
    if (
      !Number.isInteger(result.status) ||
      result.status < 200 ||
      result.status > 599 ||
      typeof result.bodyText !== "string"
    )
      throw new Error("Desktop returned an invalid Antigravity OAuth response.");
    if (result.status >= 300 && result.status < 400)
      throw new Error("Refused an Antigravity OAuth redirect.");
    const headers = new Headers(result.headers);
    // net.fetch already decoded the body; do not advertise a second decompression.
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response([204, 205, 304].includes(result.status) ? null : result.bodyText, {
      status: result.status,
      headers,
    });
  };
}
