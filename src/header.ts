// Kept in step with package.json by test/version.test.ts.
export const VERSION = "0.1.1";

/** The name Oxylabs counts this package's requests under. */
export const SDK_NAME = "oxylabs-web-api-vercel-ai-sdk";

let aiVersion: Promise<string | undefined> | undefined;

/**
 * The installed AI SDK version, best effort. The specifier is kept out of reach of bundlers:
 * where `ai/package.json` can't be loaded at run time (edge runtimes, trimmed bundles),
 * the header just leaves the version out.
 */
function detectAiVersion(): Promise<string | undefined> {
  const specifier = "ai/package.json";
  aiVersion ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ specifier, {
    with: { type: "json" },
  }).then(
    (mod: { default?: { version?: unknown } }) =>
      typeof mod.default?.version === "string" ? mod.default.version : undefined,
    () => undefined,
  );
  return aiVersion;
}

function runtime(): string {
  const versions = typeof process !== "undefined" ? process.versions : undefined;
  if (versions?.bun) return `bun ${versions.bun}`;
  if (versions?.deno) return `deno ${versions.deno}`;
  if (versions?.node) return `node ${versions.node}`;
  return "unknown runtime";
}

/** Value of the `x-oxylabs-sdk` header, which Oxylabs uses to count requests per integration. */
export async function sdkHeader(): Promise<string> {
  const ai = await detectAiVersion();
  return `${SDK_NAME}/${VERSION} (vercel-ai-sdk${ai ? ` ${ai}` : ""}; ${runtime()})`;
}
