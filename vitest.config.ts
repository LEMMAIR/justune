import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["lib/**/*.test.ts", "components/**/*.test.tsx"],
  },
  resolve: {
    alias: [
      {
        find: "@lemmair/justune-runtime/agent-runner",
        replacement: fileURLToPath(
          new URL("./packages/justune-runtime/src/agent-runner.ts", import.meta.url),
        ),
      },
      {
        find: "@lemmair/justune-runtime/client-identity",
        replacement: fileURLToPath(
          new URL("./packages/justune-runtime/src/client-identity.ts", import.meta.url),
        ),
      },
      {
        find: "@lemmair/justune-runtime/justune-browser-sandbox-client",
        replacement: fileURLToPath(
          new URL("./packages/justune-runtime/src/justune-browser-sandbox-client.ts", import.meta.url),
        ),
      },
      {
        find: "@lemmair/justune-runtime/runtime-constraints",
        replacement: fileURLToPath(
          new URL("./packages/justune-runtime/src/runtime-constraints.ts", import.meta.url),
        ),
      },
      {
        find: "@lemmair/justune-runtime",
        replacement: fileURLToPath(
          new URL("./packages/justune-runtime/src/index.ts", import.meta.url),
        ),
      },
      {
        find: "@",
        replacement: fileURLToPath(new URL("./", import.meta.url)),
      },
    ],
  },
});
