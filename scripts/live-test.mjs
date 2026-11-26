// Calls the real Oxylabs Web API through the built tools (run `npm run build` first).
// Needs OXYLABS_WEB_API_KEY in the environment or in .env. Prints results, never the key.
import assert from "node:assert/strict";
import { OxylabsApiError, oxylabsTools, scrape, webSearch } from "../dist/index.js";

if (!process.env.OXYLABS_WEB_API_KEY) {
  console.error("Set OXYLABS_WEB_API_KEY first.");
  process.exit(1);
}
const options = { toolCallId: "live", messages: [], context: {} };
const { webSearch: search, scrape: read } = oxylabsTools();

let started = Date.now();
const found = await search.execute({ query: "oxylabs web scraper api", maxResults: 3, location: "DE" }, options);
assert.ok(found.results.length > 0, "search returned no results");
assert.ok(found.results.every((result) => result.url.startsWith("http")));
console.log(`search: ${found.results.length} results in ${Date.now() - started} ms, first ${found.results[0].url}`);

started = Date.now();
const page = await read.execute({ url: "https://example.com" }, options);
assert.equal(page.statusCode, 200);
assert.match(page.content, /documentation examples/);
console.log(`scrape: ${page.content.length} chars of Markdown in ${Date.now() - started} ms`);

started = Date.now();
const html = await read.execute({ url: "https://example.com", format: "html" }, options);
assert.match(html.content, /<html/i);
console.log(`scrape html: ${html.content.length} chars in ${Date.now() - started} ms`);

started = Date.now();
const withPages = await webSearch({ scrapeTop: 1, maxCharacters: 2000 }).execute(
  { query: "python.org downloads", maxResults: 2 },
  options,
);
const top = withPages.results[0];
assert.ok(top.content || top.contentError, "scrapeTop left the first result untouched");
console.log(
  `search + scrapeTop: ${top.content ? `${top.content.length} chars from ${top.url}` : `page failed: ${top.contentError}`} in ${Date.now() - started} ms`,
);

const badKey = "not-a-real-key";
await assert.rejects(scrape({ apiKey: badKey }).execute({ url: "https://example.com" }, options), (error) => {
  assert.ok(error instanceof OxylabsApiError);
  assert.match(error.message, /rejected the API key \(401\)/);
  assert.ok(!error.message.includes(badKey));
  return true;
});
console.log("bad key: rejected with a clear 401 message");
