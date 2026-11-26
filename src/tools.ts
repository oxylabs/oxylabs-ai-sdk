import { type Tool, tool } from "ai";
import { z } from "zod";
import {
  type OxylabsClientOptions,
  type PageFormat,
  resolveContext,
  scrapePage,
  searchWeb,
} from "./client.js";

const MAX_SEARCH_RESULTS = 20;
const DEFAULT_SEARCH_RESULTS = 5;
const DEFAULT_SEARCH_TIMEOUT_SECONDS = 60;
const DEFAULT_SCRAPE_TIMEOUT_SECONDS = 120;
const DEFAULT_SCRAPE_MAX_CHARACTERS = 50_000;
const DEFAULT_TOP_PAGE_MAX_CHARACTERS = 5_000;
/** Below this many characters a page is probably an empty shell or an error page. */
const THIN_CONTENT_CHARS = 500;

const countryCode = z
  .string()
  .regex(/^[A-Za-z]{2}$/, "Use a two-letter country code such as US or DE.");

export type WebSearchOptions = OxylabsClientOptions & {
  /** Results to return when the model doesn't ask for a number (1-20). Default 5. */
  maxResults?: number;
  /** Two-letter country code to rank results for when the model doesn't pass one. */
  location?: string;
  /**
   * Also read the top N result pages and add their Markdown as `content`, so one call
   * answers most questions. Default 0 (snippets only). Each page costs a scrape request.
   */
  scrapeTop?: number;
  /** Most characters of `content` per scraped result page. Default 5000. */
  maxCharacters?: number;
  /** Timeout in seconds for the search, and separately for each page read with `scrapeTop`. Default 60. */
  timeoutSeconds?: number;
};

export type ScrapeOptions = OxylabsClientOptions & {
  /** Most characters of page content to return. Longer pages are cut. Default 50000. */
  maxCharacters?: number;
  /** Timeout in seconds, including the wait for slow pages. Default 120. */
  timeoutSeconds?: number;
};

export type OxylabsToolsOptions = OxylabsClientOptions;

/** What the model passes to `webSearch`. */
export type WebSearchInput = {
  query: string;
  maxResults?: number | undefined;
  location?: string | undefined;
};

/** What the model passes to `scrape`. */
export type ScrapeInput = {
  url: string;
  format?: PageFormat | undefined;
  renderJs?: boolean | undefined;
  location?: string | undefined;
};

export type WebSearchOutput = { query: string; results: WebSearchResult[] };

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  position?: number;
  /** The page's Markdown, when `scrapeTop` covered this result. */
  content?: string;
  /** Why `content` is missing, when reading this result's page failed. */
  contentError?: string;
};

export type ScrapeResult = {
  url: string;
  format: PageFormat;
  content: string;
  /** HTTP status the target site answered with, when known. */
  statusCode?: number;
  /** Set when `content` was cut to `maxCharacters`. */
  truncated?: { totalCharacters: number };
  /** A hint for the model when the page looks empty. */
  note?: string;
};

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function cut(content: string, maxCharacters: number): { content: string; totalCharacters?: number } {
  return content.length > maxCharacters
    ? { content: content.slice(0, maxCharacters), totalCharacters: content.length }
    : { content };
}

function thinNote(content: string, statusCode: number | undefined, renderJs: boolean): string | undefined {
  if (statusCode !== undefined && statusCode >= 400) {
    return `The site answered HTTP ${statusCode}, so this is its error page: renderJs will not help. Check the URL, or report the page as unavailable.`;
  }
  if (content.trim().length >= THIN_CONTENT_CHARS) return undefined;
  return renderJs
    ? "The page came back almost empty even with JavaScript rendered. It may be blocked or truly empty."
    : "The page came back almost empty. If you expected more, it probably renders client-side: call scrape again with renderJs: true.";
}

/**
 * A tool that searches the live web through the Oxylabs Web API and returns ranked
 * organic results, optionally with the content of the top pages.
 */
export function webSearch(options: WebSearchOptions = {}): Tool<WebSearchInput, WebSearchOutput> {
  const defaultMax = clampInt(options.maxResults ?? DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS);
  const scrapeTop = clampInt(options.scrapeTop ?? 0, 0, MAX_SEARCH_RESULTS);
  const maxCharacters = options.maxCharacters ?? DEFAULT_TOP_PAGE_MAX_CHARACTERS;
  const timeoutMs = (options.timeoutSeconds ?? DEFAULT_SEARCH_TIMEOUT_SECONDS) * 1000;

  return tool({
    description:
      "Search the live web and return ranked organic results (title, URL, snippet). Use it for " +
      "anything where being out of date makes the answer wrong: news, prices, versions, " +
      "rankings, people, or any fact past your knowledge cutoff. Results are ranked as someone " +
      "in `location` would see them. Snippets are short; read the pages worth reading with the " +
      "scrape tool." +
      (scrapeTop > 0 ? ` The top ${scrapeTop} results also carry the page content.` : ""),
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(2048)
        .describe("What to search for. Keyword-shaped queries beat sentences. One question per search."),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(MAX_SEARCH_RESULTS)
        .optional()
        .describe(`How many results to return. Default ${defaultMax}.`),
      location: countryCode
        .optional()
        .describe(
          "ISO 3166-1 alpha-2 country code to rank results for, e.g. US, DE. Pass it whenever the answer is local.",
        ),
    }),
    execute: async ({ query, maxResults, location }, { abortSignal }) => {
      const ctx = resolveContext(options, timeoutMs, abortSignal);
      const country = (location ?? options.location)?.toUpperCase();
      const hits = await searchWeb(ctx, {
        query,
        maxResults: maxResults ?? defaultMax,
        location: country,
      });
      const results: WebSearchResult[] = hits.map((hit) => ({ ...hit }));
      const top = results.slice(0, scrapeTop).filter((result) => result.url);
      const pages = await Promise.allSettled(
        top.map((result) =>
          scrapePage(ctx, { url: result.url, format: "markdown", renderJs: false, location: country }),
        ),
      );
      pages.forEach((page, index) => {
        const result = top[index]!;
        if (page.status === "fulfilled") {
          result.content = cut(page.value.content, maxCharacters).content;
        } else {
          result.contentError = page.reason instanceof Error ? page.reason.message : String(page.reason);
        }
      });
      return { query, results };
    },
  });
}

/**
 * A tool that reads one web page through the Oxylabs Web API, including JavaScript-heavy
 * and bot-protected pages, as Markdown or HTML.
 */
export function scrape(options: ScrapeOptions = {}): Tool<ScrapeInput, ScrapeResult> {
  const maxCharacters = options.maxCharacters ?? DEFAULT_SCRAPE_MAX_CHARACTERS;
  const timeoutMs = (options.timeoutSeconds ?? DEFAULT_SCRAPE_TIMEOUT_SECONDS) * 1000;

  return tool({
    description:
      "Fetch and read a web page, including JavaScript-heavy and bot-protected ones that a plain " +
      "fetch can't open. Use it whenever you have a URL and need what is on it. Returns Markdown " +
      "by default. Try without renderJs first; if the page comes back almost empty, call it again " +
      "with renderJs: true.",
    inputSchema: z.object({
      url: z
        .string()
        .regex(/^https?:\/\/\S+$/i, "Use an absolute http(s) URL.")
        .describe("Absolute http(s) URL of the page to read."),
      format: z
        .enum(["markdown", "html"])
        .optional()
        .describe("markdown (default) to read the page; html only when you need the markup itself."),
      renderJs: z
        .boolean()
        .optional()
        .describe("Run the page's JavaScript first. Slower; only for pages that render client-side."),
      location: countryCode
        .optional()
        .describe("Two-letter country code to fetch the page from, when the page varies by country."),
    }),
    execute: async ({ url, format = "markdown", renderJs = false, location }, { abortSignal }) => {
      const ctx = resolveContext(options, timeoutMs, abortSignal);
      const page = await scrapePage(ctx, { url, format, renderJs, location: location?.toUpperCase() });
      const { content, totalCharacters } = cut(page.content, maxCharacters);
      const note = thinNote(page.content, page.statusCode, renderJs);
      const result: ScrapeResult = {
        url,
        format,
        content,
        ...(page.statusCode !== undefined ? { statusCode: page.statusCode } : {}),
        ...(totalCharacters !== undefined ? { truncated: { totalCharacters } } : {}),
        ...(note ? { note } : {}),
      };
      return result;
    },
  });
}

/** Both Oxylabs tools, ready to pass as `tools` to `generateText` or `streamText`. */
export function oxylabsTools(options: OxylabsToolsOptions = {}): {
  webSearch: Tool<WebSearchInput, WebSearchOutput>;
  scrape: Tool<ScrapeInput, ScrapeResult>;
} {
  return { webSearch: webSearch(options), scrape: scrape(options) };
}
