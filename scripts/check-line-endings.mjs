import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = process.cwd();

// Prettier is configured for LF. When a Windows checkout converts sources to
// CRLF, `prettier --check` fails on every file at once with no explanation of
// the real cause. This check names the actual problem before that happens.
const CRLF_ALLOWED = /\.(bat|cmd|ps1)$/u;

async function trackedTextFiles() {
  const { stdout } = await execFile("git", ["ls-files", "-z", "--", "."], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.split("\0").filter((path) => path.length > 0);
}

function isProbablyBinary(contents) {
  return contents.includes(0);
}

const offenders = [];
let inspected = 0;

for (const relativePath of await trackedTextFiles()) {
  const contents = await readFile(join(root, relativePath));
  if (isProbablyBinary(contents)) {
    continue;
  }
  inspected += 1;
  const text = contents.toString("utf8");
  if (text.includes("\r\n") && !CRLF_ALLOWED.test(relativePath)) {
    offenders.push(relativePath);
  }
}

if (offenders.length > 0) {
  process.stderr.write(
    `CRLF line endings found in ${offenders.length} tracked file(s).\n` +
      "The repository normalizes text to LF via .gitattributes. If this is a\n" +
      "fresh Windows checkout, run `git add --renormalize .` or re-clone.\n",
  );
  for (const offender of offenders.slice(0, 20)) {
    process.stderr.write(`- ${offender}\n`);
  }
  if (offenders.length > 20) {
    process.stderr.write(`- ... and ${offenders.length - 20} more\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Line-ending check passed for ${inspected} tracked text file(s).\n`,
  );
}
