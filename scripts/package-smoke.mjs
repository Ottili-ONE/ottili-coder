import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const binary = fileURLToPath(
  new URL("../dist/apps/cli/src/main.js", import.meta.url),
);
if (!existsSync(binary)) {
  throw new Error(
    "Build artifact is missing; run `pnpm build` before package smoke.",
  );
}

const result = spawnSync(process.execPath, [binary, "help"], {
  encoding: "utf8",
});
if (result.status !== 0) {
  throw new Error(`Bundled CLI help failed: ${result.stderr || result.stdout}`);
}
if (!result.stdout.includes("Ottili Coder")) {
  throw new Error("Bundled CLI did not render its help text.");
}

process.stdout.write("Bundled CLI package smoke passed.\n");
