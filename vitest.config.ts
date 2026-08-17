import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@ottili/agents": source("./packages/agents/src/index.ts"),
      "@ottili/context-format": source(
        "./packages/context-format/src/index.ts",
      ),
      "@ottili/context": source("./packages/context/src/index.ts"),
      "@ottili/control-plane": source("./packages/control-plane/src/index.ts"),
      "@ottili/core": source("./packages/core/src/index.ts"),
      "@ottili/integrations": source("./packages/integrations/src/index.ts"),
      "@ottili/protocol": source("./packages/protocol/src/index.ts"),
      "@ottili/recovery": source("./packages/recovery/src/index.ts"),
      "@ottili/runtime": source("./packages/runtime/src/index.ts"),
      "@ottili/sdk": source("./packages/sdk/src/index.ts"),
      "@ottili/server": source("./packages/server/src/index.ts"),
      "@ottili/validation": source("./packages/validation/src/index.ts"),
      "@ottili/workspace": source("./packages/workspace/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/**/test/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
