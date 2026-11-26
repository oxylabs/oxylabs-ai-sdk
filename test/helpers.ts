export const TEST_KEY = "test-key-do-not-echo";

export type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

type Reply = { status?: number; body?: unknown } | ((request: RecordedRequest) => Response | Promise<Response>);

/** A `fetch` that answers with the given replies in order and records every request. */
export function fakeFetch(...replies: Reply[]) {
  const requests: RecordedRequest[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected request ${request.method} ${request.url}`);
    if (typeof reply === "function") return await reply(request);
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

export function searchReply(...urls: string[]) {
  return {
    body: {
      results: urls.map((url, index) => ({
        title: `Title ${index + 1}`,
        url,
        outline: ["first line", "second line"],
        metadata: { position: index + 1 },
      })),
    },
  };
}

export function pageReply(content: string, format: "markdown" | "html" = "markdown", code = 200) {
  return {
    body: {
      results: [{ [format]: content, metadata: { statuses: { http_request: { code } } } }],
      metadata: { request_id: "req-1" },
    },
  };
}

/** Run a tool's `execute` the way the AI SDK does, outside a model loop. */
export async function run<I, O>(tool: { execute?: unknown }, input: I, abortSignal?: AbortSignal): Promise<O> {
  const execute = tool.execute as (input: I, options: object) => Promise<O>;
  return await execute(input, { toolCallId: "call-1", messages: [], abortSignal, context: {} });
}
