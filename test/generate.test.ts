// Runs the tools inside a real generateText loop with the AI SDK's mock model, so no LLM
// key is needed. Written against the module shapes of AI SDK 5, 6 and 7, which CI tests.
import assert from "node:assert/strict";
import { it } from "node:test";
import * as ai from "ai";
import { oxylabsTools } from "../src/index.js";
import { TEST_KEY, fakeFetch, searchReply } from "./helpers.js";

type Loose = Record<string, any>;

async function mockModel(responses: Array<{ toolCall?: { name: string; input: object }; text?: string }>) {
  const testing: Loose = await import("ai/test");
  const Mock = testing.MockLanguageModelV4 ?? testing.MockLanguageModelV3 ?? testing.MockLanguageModelV2;
  const flat = !testing.MockLanguageModelV3; // AI SDK 5 (spec v2) has flat usage and finish reasons
  const results = responses.map(({ toolCall, text }) => {
    const reason = toolCall ? "tool-calls" : "stop";
    return {
      content: toolCall
        ? [{ type: "tool-call", toolCallId: "call-1", toolName: toolCall.name, input: JSON.stringify(toolCall.input) }]
        : [{ type: "text", text }],
      finishReason: flat ? reason : { unified: reason, raw: reason },
      usage: flat
        ? { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
        : {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
      warnings: [],
    };
  });
  return new Mock({ doGenerate: async () => results.shift() });
}

it("works as tools in generateText", async () => {
  const { fetch, requests } = fakeFetch(searchReply("https://a.example"));
  const model = await mockModel([
    { toolCall: { name: "webSearch", input: { query: "latest node release", location: "US" } } },
    { text: "Node 26 is out." },
  ]);
  const loose = ai as Loose;
  const stepCount = loose.isStepCount ?? loose.stepCountIs;

  const result: Loose = await loose.generateText({
    model,
    prompt: "What is the latest Node.js release?",
    tools: oxylabsTools({ apiKey: TEST_KEY, fetch }),
    stopWhen: stepCount(3),
  });

  assert.equal(result.text, "Node 26 is out.");
  assert.deepEqual(requests[0]!.body, { query: "latest node release", max_results: 5, location: "US" });
  const toolResult = result.steps[0].toolResults[0];
  assert.equal(toolResult.toolName, "webSearch");
  assert.equal(toolResult.output.results[0].url, "https://a.example");
});

it("rejects input that breaks the schema before calling the API", async () => {
  const { fetch, requests } = fakeFetch();
  const model = await mockModel([
    { toolCall: { name: "scrape", input: { url: "not a url" } } },
    { text: "done" },
  ]);
  const loose = ai as Loose;

  const result: Loose = await loose.generateText({
    model,
    prompt: "Read it",
    tools: oxylabsTools({ apiKey: TEST_KEY, fetch }),
    stopWhen: (loose.isStepCount ?? loose.stepCountIs)(3),
  });

  assert.equal(requests.length, 0);
  const errors = result.steps[0].content.filter((part: Loose) => part.type === "tool-error");
  assert.equal(errors.length, 1);
});
