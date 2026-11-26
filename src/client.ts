import { sdkHeader } from "./header.js";

export const DEFAULT_BASE_URL = "https://webapi.oxylabs.io";
export const API_KEY_ENV_VAR = "OXYLABS_WEB_API_KEY";

const ERROR_DETAIL_MAX_CHARS = 300;
const SCRAPE_TIMEOUT_TITLE = "REQUEST_FAILED_SCRAPE_TIMEOUT";
const SYNC_SCRAPE_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;

/** Connection settings shared by every tool. */
export type OxylabsClientOptions = {
  /** Oxylabs Web API key. Defaults to the `OXYLABS_WEB_API_KEY` environment variable. */
  apiKey?: string;
  /** API base URL. Defaults to `https://webapi.oxylabs.io`. */
  baseURL?: string;
  /** A custom `fetch`, e.g. for proxies or tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
};

type JsonRecord = Record<string, unknown>;

type ApiResponse = { status: number; body: JsonRecord | undefined };

type CallContext = {
  apiKey: string;
  baseURL: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
};

/** An error from the Oxylabs Web API. Its message never contains the API key. */
export class OxylabsApiError extends Error {
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(message: string, status: number, requestId?: string) {
    super(message);
    this.name = "OxylabsApiError";
    this.status = status;
    this.requestId = requestId;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestIdOf(body: JsonRecord | undefined): string | undefined {
  const metadata = isRecord(body?.metadata) ? body.metadata : undefined;
  const id = metadata?.request_id ?? body?.request_id;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

function clip(text: string): string {
  return text.length > ERROR_DETAIL_MAX_CHARS ? `${text.slice(0, ERROR_DETAIL_MAX_CHARS)}…` : text;
}

/** Turn a failed response into a message the model (and the developer) can act on. */
export function describeApiError(status: number, body: JsonRecord | undefined): string {
  const requestId = requestIdOf(body);
  const suffix = requestId ? ` (request_id ${requestId})` : "";
  if (status === 401) {
    return `Oxylabs Web API rejected the API key (401). Check the apiKey option or ${API_KEY_ENV_VAR}.`;
  }
  if (status === 403) {
    return `Oxylabs Web API refused the request (403): the account has no access to this feature${suffix}.`;
  }
  if (status === 429 && body?.title === "QUOTA_EXCEEDED") {
    return "Oxylabs Web API quota is used up (429 QUOTA_EXCEEDED). Top up the plan in the Oxylabs dashboard.";
  }
  const title = typeof body?.title === "string" ? body.title : "request failed";
  const fieldErrors = Array.isArray(body?.errors)
    ? body.errors
        .filter(isRecord)
        .map((entry) => `${String(entry.pointer ?? "").replace(/^#\//, "")}: ${String(entry.detail ?? "")}`)
        .join("; ")
    : "";
  const detail = fieldErrors || (typeof body?.detail === "string" ? body.detail : "");
  return clip(`Oxylabs Web API error ${status} ${title}${detail ? `: ${detail}` : ""}`) + suffix;
}

function readEnv(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

/** Resolve the settings for one tool call. Throws when no API key is available. */
export function resolveContext(
  options: OxylabsClientOptions,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): CallContext {
  const apiKey = (options.apiKey ?? readEnv(API_KEY_ENV_VAR))?.trim();
  if (!apiKey) {
    throw new OxylabsApiError(
      `Oxylabs Web API key is missing. Pass apiKey or set ${API_KEY_ENV_VAR}.`,
      401,
    );
  }
  return {
    apiKey,
    baseURL: (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs,
    signal,
  };
}

async function call(
  method: "GET" | "POST",
  path: string,
  body: JsonRecord | undefined,
  ctx: CallContext,
): Promise<ApiResponse> {
  ctx.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(ctx.timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await ctx.fetch(`${ctx.baseURL}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${ctx.apiKey}`,
        "x-oxylabs-sdk": await sdkHeader(),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  } catch (error) {
    if (ctx.signal?.aborted || timeout.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new OxylabsApiError(`Could not reach the Oxylabs Web API: ${clip(reason)}`, 0);
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: isRecord(parsed) ? parsed : undefined };
}

function ensureOk(response: ApiResponse): JsonRecord {
  if (response.status >= 200 && response.status < 300 && response.body) {
    return response.body;
  }
  throw new OxylabsApiError(
    describeApiError(response.status, response.body),
    response.status,
    requestIdOf(response.body),
  );
}

export type SearchParams = { query: string; maxResults: number; location?: string | undefined };

export type SearchHit = { title: string; url: string; snippet: string; position?: number };

/** `POST /v1/search`: organic results with a short outline of each page. */
export async function searchWeb(ctx: CallContext, params: SearchParams): Promise<SearchHit[]> {
  const body: JsonRecord = { query: params.query, max_results: params.maxResults };
  if (params.location) body.location = params.location;
  const data = ensureOk(await call("POST", "/v1/search", body, ctx));
  const results = Array.isArray(data.results) ? data.results.filter(isRecord) : [];
  return results.map((entry) => {
    const outline = Array.isArray(entry.outline)
      ? entry.outline.filter((line): line is string => typeof line === "string")
      : [];
    const metadata = isRecord(entry.metadata) ? entry.metadata : undefined;
    return {
      title: typeof entry.title === "string" ? entry.title : "",
      url: typeof entry.url === "string" ? entry.url : "",
      snippet: outline.join(" … "),
      ...(typeof metadata?.position === "number" ? { position: metadata.position } : {}),
    };
  });
}

export type PageFormat = "markdown" | "html";

export type ScrapeParams = {
  url: string;
  format: PageFormat;
  renderJs: boolean;
  location?: string | undefined;
};

export type ScrapedPage = { content: string; statusCode?: number; requestId?: string };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isTimeout(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  const name = (error as { name?: string } | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function readPage(data: JsonRecord, format: PageFormat): ScrapedPage {
  const results = Array.isArray(data.results) ? data.results.filter(isRecord) : [];
  const first = results[0];
  const content = typeof first?.[format] === "string" ? first[format] : "";
  const metadata = isRecord(first?.metadata) ? first.metadata : undefined;
  const statuses = isRecord(metadata?.statuses) ? metadata.statuses : undefined;
  const httpRequest = isRecord(statuses?.http_request) ? statuses.http_request : undefined;
  const requestId = requestIdOf(data);
  return {
    content,
    ...(typeof httpRequest?.code === "number" ? { statusCode: httpRequest.code } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

/**
 * `POST /v1/scrape` for one page.
 *
 * Most pages finish inside the synchronous call. When it times out, the same request is
 * queued on `/v1/async/scrape` and polled until the call's timeout runs out, instead of
 * being resent synchronously.
 */
export async function scrapePage(ctx: CallContext, params: ScrapeParams): Promise<ScrapedPage> {
  const deadline = Date.now() + ctx.timeoutMs;
  const body: JsonRecord = { url: params.url, output: [params.format] };
  if (params.renderJs) body.run_js = true;
  if (params.location) body.location = params.location;

  let timedOut = false;
  try {
    const response = await call("POST", "/v1/scrape", body, {
      ...ctx,
      timeoutMs: Math.min(SYNC_SCRAPE_TIMEOUT_MS, ctx.timeoutMs),
    });
    timedOut = response.status === 504 || response.body?.title === SCRAPE_TIMEOUT_TITLE;
    if (!timedOut) return readPage(ensureOk(response), params.format);
  } catch (error) {
    if (!isTimeout(error, ctx.signal)) throw error;
    timedOut = true;
  }

  const remaining = () => Math.max(1_000, deadline - Date.now());
  const queued = ensureOk(await call("POST", "/v1/async/scrape", body, { ...ctx, timeoutMs: remaining() }));
  const requestId = requestIdOf(queued);
  if (!requestId) {
    throw new OxylabsApiError("Oxylabs Web API queued the scrape but returned no request_id.", 502);
  }
  for (;;) {
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      throw new OxylabsApiError(
        `Oxylabs Web API did not finish scraping ${params.url} in time (request_id ${requestId}). Try again later, or raise timeoutSeconds.`,
        504,
        requestId,
      );
    }
    await sleep(POLL_INTERVAL_MS, ctx.signal);
    const polled = await call("GET", `/v1/async/scrape/${encodeURIComponent(requestId)}`, undefined, {
      ...ctx,
      timeoutMs: remaining(),
    });
    if (polled.body?.state === "pending") continue;
    return readPage(ensureOk(polled), params.format);
  }
}
