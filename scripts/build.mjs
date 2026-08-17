import { build } from "esbuild";

const entryPoints = [
  "packages/protocol/src/index.ts",
  "packages/core/src/index.ts",
  "packages/control-plane/src/index.ts",
  "packages/runtime/src/index.ts",
  "packages/agents/src/index.ts",
  "packages/validation/src/index.ts",
  "packages/recovery/src/index.ts",
  "packages/context/src/index.ts",
  "packages/context-format/src/index.ts",
  "packages/workspace/src/index.ts",
  "packages/server/src/index.ts",
  "packages/integrations/src/index.ts",
  "packages/sdk/src/index.ts",
  "apps/cli/src/daemon-process.ts",
  "apps/cli/src/main.ts",
];

await build({
  bundle: true,
  entryPoints,
  format: "esm",
  outbase: ".",
  outdir: "dist",
  platform: "node",
  sourcemap: true,
  target: "node24",
  tsconfig: "tsconfig.json",
});
