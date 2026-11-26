import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  OxylabsApiError,
  type ScrapeResult,
  type WebSearchResult,
  oxylabsTools,
  scrape,
  webSearch,
} from "../src/index.js";
import { TEST_KEY, fakeFetch, pageReply, run, searchReply } from "./helpers.js";

type SearchOutput = { query: string; results: WebSearchResult[] };

const SDK_HEADER = /^oxylabs-web-api-vercel-ai-sdk\/\d+\.\d+\.\d+ \(vercel-ai-sdk \d+\.\d+\.\d+[^;]*; node \d+\.\d+\.\d+\)$/;

// The allowlist pattern apiritif and the Search API parse the header with.
const API_HEADER_REGEX = /^([a-z0-9-]+)\/(\d+\.\d+\.\d+)(?: ([^()]+?))? \(.*\)$/;

describe("webSearch", () => {
  it("sends the query with the key and SDK header and maps the results", async () => {
    const { fetch, requests } = fakeFetch(searchReply("https://a.example", "https://b.example"));
    const tool = webSearch({ apiKey: TEST_KEY, fetch });

    const output = await run<object, SearchOutput>(tool, { query: "oxylabs", location: "de" });

    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request!.url, "https://webapi.oxylabs.io/v1/search");
    assert.equal(request!.method, "POST");
    assert.equal(request!.headers.authorization, `Bearer ${TEST_KEY}`);
    assert.match(request!.headers["x-oxylabs-sdk"]!, SDK_HEADER);
    assert.equal(API_HEADER_REGEX.exec(request!.headers["x-oxylabs-sdk"]!)?.[1], "oxylabs-web-api-vercel-ai-sdk");
    assert.deepEqual(request!.body, { query: "oxylabs", max_results: 5, location: "DE" });
    assert.deepEqual(output.results[0], {
      title: "Title 1",
      url: "https://a.example",
      snippet: "first line … second line",
      position: 1,
    });
  });

  it("lets the model's maxResults and location override the defaults", async () => {
    const { fetch, requests } = fakeFetch(searchReply(), searchReply());
    const tool = webSearch({ apiKey: TEST_KEY, fetch, maxResults: 8, location: "US" });

    await run(tool, { query: "q" });
    await run(tool, { query: "q", maxResults: 2, location: "LT" });

    assert.deepEqual(requests[0]!.body, { query: "q", max_results: 8, location: "US" });
    assert.deepEqual(requests[1]!.body, { query: "q", max_results: 2, location: "LT" });
  });

  it("reads the top pages when scrapeTop is set and reports a page that fails", async () => {
    const { fetch, requests } = fakeFetch(
      searchReply("https://a.example", "https://b.example", "https://c.example"),
      (request) => {
        const body = request.body as { url: string };
        return body.url === "https://a.example"
          ? Response.json(pageReply("x".repeat(40)).body)
          : Response.json({ title: "faulted", detail: "target failed" }, { status: 500 });
      },
      (request) => {
        const body = request.body as { url: string };
        return body.url === "https://a.example"
          ? Response.json(pageReply("x".repeat(40)).body)
          : Response.json({ title: "faulted", detail: "target failed" }, { status: 500 });
      },
    );
    const tool = webSearch({ apiKey: TEST_KEY, fetch, scrapeTop: 2, maxCharacters: 10 });

    const output = await run<object, SearchOutput>(tool, { query: "q" });

    assert.equal(requests.length, 3);
    assert.deepEqual(requests[1]!.body, { url: "https://a.example", output: ["markdown"] });
    assert.equal(output.results[0]!.content, "x".repeat(10));
    assert.match(output.results[1]!.contentError!, /500 faulted: target failed/);
    assert.equal(output.results[2]!.content, undefined);
    assert.equal(output.results[2]!.contentError, undefined);
  });

  it("mentions scrapeTop in the description only when it is on", () => {
    assert.doesNotMatch(String(webSearch().description), /also carry the page content/);
    assert.match(String(webSearch({ scrapeTop: 3 }).description), /top 3 results also carry/);
  });
});

describe("scrape", () => {
  it("returns Markdown with the target's status code", async () => {
    const markdown = "# Title\n\n" + "words ".repeat(200);
    const { fetch, requests } = fakeFetch(pageReply(markdown));
    const output = await run<object, ScrapeResult>(scrape({ apiKey: TEST_KEY, fetch }), {
      url: "https://example.com",
      location: "us",
    });

    assert.deepEqual(requests[0]!.body, { url: "https://example.com", output: ["markdown"], location: "US" });
    assert.deepEqual(output, { url: "https://example.com", format: "markdown", content: markdown, statusCode: 200 });
  });

  it("asks for HTML and rendering when told to, and cuts long pages", async () => {
    const { fetch, requests } = fakeFetch(pageReply("<p>" + "a".repeat(2000) + "</p>", "html"));
    const output = await run<object, ScrapeResult>(scrape({ apiKey: TEST_KEY, fetch, maxCharacters: 100 }), {
      url: "https://example.com",
      format: "html",
      renderJs: true,
    });

    assert.deepEqual(requests[0]!.body, { url: "https://example.com", output: ["html"], run_js: true });
    assert.equal(output.content.length, 100);
    assert.deepEqual(output.truncated, { totalCharacters: 2007 });
    assert.equal(output.note, undefined);
  });

  it("suggests renderJs for a nearly empty page, but not for an error page", async () => {
    const { fetch } = fakeFetch(pageReply("Loading…"), pageReply("Not found", "markdown", 404));
    const tool = scrape({ apiKey: TEST_KEY, fetch });

    const empty = await run<object, ScrapeResult>(tool, { url: "https://spa.example" });
    const missing = await run<object, ScrapeResult>(tool, { url: "https://spa.example/nope" });

    assert.match(empty.note!, /renderJs: true/);
    assert.match(missing.note!, /HTTP 404.*renderJs will not help/);
  });

  it("queues a page that times out synchronously and polls until it is done", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { fetch, requests } = fakeFetch(
      { status: 504, body: { title: "REQUEST_FAILED_SCRAPE_TIMEOUT" } },
      { status: 202, body: { metadata: { request_id: "abc" } } },
      { body: { state: "pending" } },
      pageReply("# Slow page\n\n" + "text ".repeat(200)),
    );
    const tool = scrape({ apiKey: TEST_KEY, fetch });

    const pending = run<object, ScrapeResult>(tool, { url: "https://slow.example" });
    for (let i = 0; i < 2; i += 1) {
      while (requests.length < 2 + i) await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(3_000);
    }
    const output = await pending;

    assert.deepEqual(
      requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
      ["POST /v1/scrape", "POST /v1/async/scrape", "GET /v1/async/scrape/abc", "GET /v1/async/scrape/abc"],
    );
    assert.match(output.content, /^# Slow page/);
  });
});

describe("errors and keys", () => {
  const savedKey = process.env.OXYLABS_WEB_API_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.OXYLABS_WEB_API_KEY;
    else process.env.OXYLABS_WEB_API_KEY = savedKey;
  });

  it("explains a rejected key without echoing it", async () => {
    const { fetch } = fakeFetch({ status: 401 });
    const error = await run(webSearch({ apiKey: TEST_KEY, fetch }), { query: "q" }).catch((e: unknown) => e);

    assert.ok(error instanceof OxylabsApiError);
    assert.equal(error.status, 401);
    assert.match(error.message, /rejected the API key \(401\)/);
    assert.doesNotMatch(error.message, new RegExp(TEST_KEY));
  });

  it("passes on field errors, quota errors and request ids", async () => {
    const { fetch } = fakeFetch(
      {
        status: 422,
        body: {
          title: "VALIDATION_ERROR",
          errors: [{ pointer: "#/location", detail: "unknown country" }],
          metadata: { request_id: "r-9" },
        },
      },
      { status: 429, body: { title: "QUOTA_EXCEEDED" } },
    );
    const tool = webSearch({ apiKey: TEST_KEY, fetch });

    await assert.rejects(run(tool, { query: "q" }), {
      message: "Oxylabs Web API error 422 VALIDATION_ERROR: location: unknown country (request_id r-9)",
    });
    await assert.rejects(run(tool, { query: "q" }), /quota is used up/);
  });

  it("turns a network failure into an error without the key", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;

    await assert.rejects(run(scrape({ apiKey: TEST_KEY, fetch }), { url: "https://example.com" }), {
      name: "OxylabsApiError",
      message: "Could not reach the Oxylabs Web API: fetch failed",
    });
  });

  it("reads the key from OXYLABS_WEB_API_KEY when no option is given", async () => {
    process.env.OXYLABS_WEB_API_KEY = "from-env";
    const { fetch, requests } = fakeFetch(searchReply());
    await run(webSearch({ fetch }), { query: "q" });
    assert.equal(requests[0]!.headers.authorization, "Bearer from-env");
  });

  it("fails clearly when there is no key at all", async () => {
    delete process.env.OXYLABS_WEB_API_KEY;
    const { fetch, requests } = fakeFetch();
    await assert.rejects(run(webSearch({ fetch }), { query: "q" }), /key is missing\. Pass apiKey or set OXYLABS_WEB_API_KEY/);
    assert.equal(requests.length, 0);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        queueMicrotask(() => controller.abort(new Error("user cancelled")));
      })) as typeof globalThis.fetch;

    const pending = run(scrape({ apiKey: TEST_KEY, fetch }), { url: "https://example.com" }, controller.signal);
    await assert.rejects(pending, /user cancelled/);
  });
});

describe("aborting before the call", () => {
  it("does not send a request when the signal is already aborted", async () => {
    const { fetch, requests } = fakeFetch();
    await assert.rejects(
      run(webSearch({ apiKey: TEST_KEY, fetch }), { query: "q" }, AbortSignal.abort(new Error("too late"))),
      /too late/,
    );
    assert.equal(requests.length, 0);
  });
});

describe("oxylabsTools", () => {
  it("returns both tools under the names the examples use", () => {
    assert.deepEqual(Object.keys(oxylabsTools()), ["webSearch", "scrape"]);
  });
});
