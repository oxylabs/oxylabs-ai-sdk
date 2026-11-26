# Oxylabs tools for the Vercel AI SDK

[![npm](https://img.shields.io/npm/v/oxylabs-ai-sdk)](https://www.npmjs.com/package/oxylabs-ai-sdk)
[![CI](https://github.com/oxylabs/oxylabs-ai-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/oxylabs/oxylabs-ai-sdk/actions/workflows/ci.yml)

Give your [AI SDK](https://ai-sdk.dev) agent the live web: geo-targeted web search and a page reader
that gets through JavaScript-heavy and bot-protected sites, powered by the
[Oxylabs Web API](https://oxylabs.io).

- `webSearch`: ranked organic results for a query, as someone in a given country sees them.
  Optionally reads the top results too, so one call answers most questions.
- `scrape`: any page as Markdown (or HTML), with JavaScript rendering when a page needs it.
  Slow pages are queued and collected for you.

Works with AI SDK 5, 6 and 7, and with zod 3.25+ or 4.

## Install

```bash
npm install oxylabs-ai-sdk ai zod
```

Get an API key in the [Oxylabs dashboard](https://dashboard.oxylabs.io/) and set it as
`OXYLABS_WEB_API_KEY`. Keep it on the server: run these tools in route handlers, server actions or
scripts, never in browser code.

## Usage

```ts
import { generateText, isStepCount } from 'ai';
import { oxylabsTools } from 'oxylabs-ai-sdk';

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-4.5',
  prompt: 'What are the top headlines in Germany today?',
  tools: oxylabsTools(),
  stopWhen: isStepCount(5),
});

console.log(text);
```

On AI SDK 5 and 6, use `stepCountIs(5)` instead of `isStepCount(5)`.

The tools work the same way in `streamText`, `ToolLoopAgent` and anywhere else that takes `tools`.
To use one tool, or to configure each separately:

```ts
import { scrape, webSearch } from 'oxylabs-ai-sdk';

const tools = {
  webSearch: webSearch({ location: 'US', maxResults: 8, scrapeTop: 2 }),
  scrape: scrape({ maxCharacters: 20_000 }),
};
```

## Tools

### `webSearch(options?)`

The model passes `query`, and optionally `maxResults` (1-20) and `location` (a two-letter country
code such as `US` or `DE`). It gets back `{ query, results }`, where each result has `title`, `url`,
`snippet` and `position`.

| Option | Default | |
|---|---|---|
| `maxResults` | `5` | Results when the model doesn't ask for a number. |
| `location` | none | Country to rank for when the model doesn't pass one. |
| `scrapeTop` | `0` | Also read the top N result pages and add their Markdown as `content`. Each page is one extra scrape request. A page that fails gets `contentError` instead. |
| `maxCharacters` | `5000` | Most characters of `content` per page read with `scrapeTop`. |
| `timeoutSeconds` | `60` | Timeout for the search, and separately for each page read with `scrapeTop` (they run in parallel). |

### `scrape(options?)`

The model passes `url`, and optionally `format` (`markdown` or `html`), `renderJs` and `location`.
It gets back `{ url, format, content, statusCode }`. When the content was cut to `maxCharacters`,
the result also has `truncated: { totalCharacters }`. When the page came back nearly empty or as an
error page, it has a `note` that tells the model what to try next.

| Option | Default | |
|---|---|---|
| `maxCharacters` | `50000` | Most characters of page content to return. |
| `timeoutSeconds` | `120` | Timeout, including the wait for slow pages. |

### Shared options

Every factory, and `oxylabsTools(options?)`, also takes:

| Option | Default | |
|---|---|---|
| `apiKey` | `process.env.OXYLABS_WEB_API_KEY` | Oxylabs Web API key. Read when a tool runs, not at import. |
| `baseURL` | `https://webapi.oxylabs.io` | API base URL. |
| `fetch` | global `fetch` | Custom fetch implementation, e.g. for proxies or tests. |

## Errors

API failures throw an `OxylabsApiError` with the HTTP `status` and, when there is one, the
`requestId` to quote to Oxylabs support. The AI SDK passes the message to the model as a tool
error, so it is written to be acted on: a rejected key, a used-up quota, or the field the API
refused. Messages never contain your API key.

Cancelling a call through the AI SDK's `abortSignal` cancels the request to Oxylabs too.

## No code: the hosted MCP server

The same capabilities, plus company search and the dedicated scrapers for sites like Amazon or
Google, are available from the hosted Oxylabs Web API MCP server. The AI SDK's MCP client connects
to it directly:

```bash
npm install @ai-sdk/mcp
```

```ts
import { createMCPClient } from '@ai-sdk/mcp';
import { generateText, isStepCount } from 'ai';

const mcp = await createMCPClient({
  transport: {
    type: 'http',
    url: 'https://mcp.oxylabs.io/web-api-mcp',
    headers: { Authorization: `Bearer ${process.env.OXYLABS_WEB_API_KEY}` },
  },
});

try {
  const { text } = await generateText({
    model: 'anthropic/claude-sonnet-4.5',
    prompt: 'Compare the prices of the top 3 standing desks on amazon.de',
    tools: await mcp.tools(),
    stopWhen: isStepCount(8),
  });
  console.log(text);
} finally {
  await mcp.close();
}
```

Use this package when you want two small, typed tools with no extra connection to manage. Use the
MCP server when you want everything the Web API offers.

## Development

```bash
npm ci
npm test            # unit tests with a fake fetch, plus a generateText run with the AI SDK's mock model
npm run test:live   # calls the real API; needs OXYLABS_WEB_API_KEY (or a .env file)
```

## License

MIT
