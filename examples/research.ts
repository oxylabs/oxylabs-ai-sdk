// Ask a question that needs the live web. Run with an AI Gateway key (or swap in any
// provider model) and OXYLABS_WEB_API_KEY set:
//   node --env-file=.env examples/research.ts "your question"   (Node 22.18+ runs .ts directly)
import { generateText, stepCountIs } from "ai";
import { oxylabsTools } from "oxylabs-ai-sdk";

const question = process.argv[2] ?? "What changed in the latest Node.js LTS release?";

const { text, steps } = await generateText({
  model: "openai/gpt-5-mini",
  system: "Answer from pages you have read, and cite their URLs.",
  prompt: question,
  tools: oxylabsTools(),
  stopWhen: stepCountIs(10),
});

for (const step of steps) {
  for (const call of step.toolCalls) console.error(`> ${call.toolName} ${JSON.stringify(call.input)}`);
}
console.log(text);
