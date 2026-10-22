interface Env {
  OPENAI_API_KEY: string;
  MAX_BODY_BYTES?: string;
  UPSTREAM_TIMEOUT_MS?: string;
  ASSETS: Fetcher;
}

const UPSTREAM = "https://api.openai.com";
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "expect",
]);

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);

    // 1. Health check — unauthenticated, no upstream call
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    // 2. Only proxy /v1/* paths. With run_worker_first as an array, no
    //    other path should reach this Worker; the check is a cheap invariant.
    if (
      !url.pathname.startsWith("/v1/") ||
      url.pathname.includes("..") ||
      url.pathname.includes("//")
    ) {
      log({ event: "reject_path", requestId, method: request.method, path: url.pathname, status: 404 });
      return json({ error: { message: "Only /v1/* paths are proxied." } }, 404);
    }

    // 3. Enforce declared body size limit
    const maxBody = parseInt(env.MAX_BODY_BYTES ?? String(250 * 1024 * 1024), 10);
    const declaredLength = parseInt(request.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBody) {
      log({
        event: "reject_body_size", requestId, method: request.method, path: url.pathname,
        declaredLength, maxBody, status: 413,
      });
      return json({ error: { message: "Request body exceeds limit." } }, 413);
    }

    // 4. Prepare upstream headers. Strip hop-by-hop, the client's auth,
    //    and every Cloudflare-injected header (keeps user IP out of OpenAI's logs).
    const upstreamHeaders = new Headers(request.headers);
    for (const h of HOP_BY_HOP) upstreamHeaders.delete(h);
    upstreamHeaders.delete("host");
    upstreamHeaders.delete("origin");
    upstreamHeaders.delete("referer");
    upstreamHeaders.delete("authorization");
    for (const key of [...upstreamHeaders.keys()]) {
      if (key.toLowerCase().startsWith("cf-")) upstreamHeaders.delete(key);
    }
    upstreamHeaders.set("authorization", `Bearer ${env.OPENAI_API_KEY}`);

    // 5. Correlation ID for tracing (preserve if caller supplied one)
    const correlationId = request.headers.get("x-request-id") ?? requestId;
    upstreamHeaders.set("x-request-id", correlationId);

    // 6. Forward the request with a hard timeout
    const upstreamTimeoutMs = parseInt(env.UPSTREAM_TIMEOUT_MS ?? "600000", 10);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(
        new Request(UPSTREAM + url.pathname + url.search, {
          method: request.method,
          headers: upstreamHeaders,
          body: request.body,
          redirect: "manual",
          signal: controller.signal,
        }),
      );
    } catch (err) {
      clearTimeout(timeout);
      return handleUpstreamError(err, {
        requestId, correlationId, method: request.method, path: url.pathname, startedAt,
      });
    }
    clearTimeout(timeout);

    // 7. Propagate the upstream response, stripping hop-by-hop and cf-* headers.
    const responseHeaders = new Headers(upstreamResponse.headers);
    for (const h of HOP_BY_HOP) responseHeaders.delete(h);
    for (const key of [...responseHeaders.keys()]) {
      if (key.toLowerCase().startsWith("cf-")) responseHeaders.delete(key);
    }
    responseHeaders.set("x-proxy-request-id", requestId);

    // 8. Log completion
    log({
      event: "proxy_complete", requestId, correlationId,
      method: request.method, path: url.pathname, status: upstreamResponse.status,
      durationMs: Date.now() - startedAt,
      upstreamRequestId: upstreamResponse.headers.get("x-request-id") ?? null,
    });

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  },
} satisfies ExportedHandler<Env>;

function handleUpstreamError(
  err: unknown,
  ctx: { requestId: string; correlationId: string; method: string; path: string; startedAt: number },
): Response {
  const isAbort =
    err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
  const isTimeout = isAbort || err instanceof TypeError;
  const status = isTimeout ? 504 : 502;
  const message = isTimeout ? "Upstream timeout." : "Upstream error.";
  log({
    event: "upstream_error", level: "error", requestId: ctx.requestId,
    correlationId: ctx.correlationId, method: ctx.method, path: ctx.path, status,
    durationMs: Date.now() - ctx.startedAt,
    errorName: err instanceof Error ? err.name : "unknown",
    errorMessage: err instanceof Error ? err.message : String(err),
  });
  return json({ error: { message } }, status);
}

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
