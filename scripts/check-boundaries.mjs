import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import process from "node:process";

const rules = new Map([
  ["protocol", new Set()],
  ["core", new Set(["@ottili/protocol"])],
  [
    // The runtime owns context compilation, so it may read the context and
    // workspace services. Integrations (MCP/LSP) stay outside: they are
    // injected as ports so process supervision never enters the turn loop.
    "runtime",
    new Set([
      "@ottili/context",
      "@ottili/context-format",
      "@ottili/control-plane",
      "@ottili/core",
      "@ottili/protocol",
      "@ottili/validation",
      "@ottili/workspace",
    ]),
  ],
  ["control-plane", new Set(["@ottili/core", "@ottili/protocol"])],
  ["agents", new Set(["@ottili/core", "@ottili/protocol"])],
  ["validation", new Set(["@ottili/core", "@ottili/protocol"])],
  [
    "recovery",
    new Set(["@ottili/core", "@ottili/protocol", "@ottili/workspace"]),
  ],
  ["workspace", new Set(["@ottili/core", "@ottili/protocol"])],
  ["context-format", new Set()],
  [
    "context",
    new Set(["@ottili/context-format", "@ottili/core", "@ottili/protocol"]),
  ],
  ["integrations", new Set(["@ottili/core", "@ottili/protocol"])],
  ["server", new Set(["@ottili/control-plane", "@ottili/protocol"])],
  ["sdk", new Set(["@ottili/protocol"])],
  [
    "cli",
    new Set([
      "@ottili/integrations",
      "@ottili/protocol",
      "@ottili/runtime",
      "@ottili/sdk",
      "@ottili/server",
    ]),
  ],
]);

const root = process.cwd();
const violations = [];

for (const [unit, allowed] of rules) {
  const directory =
    unit === "cli"
      ? join(root, "apps", "cli", "src")
      : join(root, "packages", unit, "src");
  for (const path of await sourceFiles(directory)) {
    const contents = await readFile(path, "utf8");
    for (const dependency of ottiliImports(contents)) {
      if (!allowed.has(dependency)) {
        violations.push(
          relative(root, path) +
            " imports " +
            dependency +
            " but " +
            unit +
            " only permits: " +
            [...allowed].sort().join(", "),
        );
      }
    }
    for (const relativeImport of relativeImports(contents)) {
      if (
        relativeImport.includes("/apps/") ||
        relativeImport.startsWith("../apps/")
      ) {
        violations.push(
          relative(root, path) +
            " reaches into an app through " +
            relativeImport,
        );
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write("Architecture boundary violations:\n");
  for (const violation of violations)
    process.stderr.write("- " + violation + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Architecture boundary check passed for " + rules.size + " units.\n",
  );
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      paths.push(path);
    }
  }
  return paths;
}

function ottiliImports(contents) {
  const imports = new Set();
  const expression = /\b(?:from|import)\s*\(?\s*["'](@ottili\/[a-z-]+)["']/g;
  for (const match of contents.matchAll(expression)) {
    if (match[1] !== undefined) imports.add(match[1]);
  }
  return imports;
}

function relativeImports(contents) {
  const imports = new Set();
  const expression = /\b(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;
  for (const match of contents.matchAll(expression)) {
    if (match[1] !== undefined) imports.add(match[1]);
  }
  return imports;
}
