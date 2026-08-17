#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { runCli } from "./commands.js";

export * from "./commands.js";
export * from "./daemon-client.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // `pnpm dev -- help` forwards a leading delimiter. Accept it so the
  // documented development invocation behaves like the installed binary.
  if (argv[0] === "--") argv.shift();
  process.exitCode = await runCli(argv);
}

if (isEntrypoint()) {
  void main();
}

function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  return (
    invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
  );
}
