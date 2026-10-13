const MAX_FRAME_CHARS = 8 * 1024 * 1024;

/** Incremental SSE normalization before Google SDK discards the Cloud Code Assist wrapper. */
export function unwrapNativeSse(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const queue: Uint8Array[] = [];
  let pending = "";
  let ended = false;
  let terminal = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => signal.removeEventListener("abort", abort);
  const abort = () => {
    if (terminal) return;
    terminal = true;
    ended = true;
    queue.length = 0;
    cleanup();
    controller.error(signal.reason || new DOMException("Request aborted", "AbortError"));
    void reader.cancel(signal.reason).catch(() => {});
  };
  const frame = (block: string) => {
    const lines = block.split(/\r\n|\n|\r/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data.trim() === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error("Antigravity returned invalid SSE JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Antigravity returned an invalid SSE event.");
    const record = parsed as Record<string, unknown>;
    const value = record.response ?? record;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Antigravity returned an invalid response wrapper.");
    const payload = value as Record<string, unknown>;
    if (payload.error) throw new Error("Antigravity reported an error inside the SSE stream.");
    queue.push(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };
  const consume = (last = false) => {
    if (pending.length > MAX_FRAME_CHARS)
      throw new Error("Antigravity SSE frame exceeds the size limit.");
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      frame(pending.slice(0, boundary.index));
      pending = pending.slice(boundary.index + boundary[0].length);
    }
    if (last && pending.trim()) {
      frame(pending);
      pending = "";
    }
  };
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(value) {
      if (terminal) return;
      if (signal.aborted) {
        abort();
        return;
      }
      try {
        while (!queue.length && !ended) {
          const next = await reader.read();
          if (terminal) return;
          pending += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
          consume(next.done);
          if (next.done) {
            ended = true;
            cleanup();
          }
        }
        if (queue.length) value.enqueue(queue.shift()!);
        else if (ended) {
          terminal = true;
          value.close();
        }
      } catch (error) {
        if (terminal) return;
        terminal = true;
        ended = true;
        cleanup();
        value.error(error);
        await reader.cancel(error).catch(() => {});
      }
    },
    async cancel(reason) {
      terminal = true;
      ended = true;
      cleanup();
      queue.length = 0;
      await reader.cancel(reason);
    },
  });
}
