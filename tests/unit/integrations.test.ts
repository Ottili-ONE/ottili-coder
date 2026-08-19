import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirectory } from "../support/fs-cleanup.js";

import {
  LocalExecutionBackend,
  importLegacyConfig,
  previewLegacyConfig,
} from "@ottili/integrations";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await removeTempDirectory(directory)),
  );
});

describe("legacy configuration import", () => {
  it("previews and imports without changing the legacy file", async () => {
    const homeDirectory = await mkdtemp(
      join(tmpdir(), "ottili-integration-home-"),
    );
    temporaryDirectories.push(homeDirectory);
    const source = join(homeDirectory, ".ottili-coder", "config.json");
    await mkdir(join(homeDirectory, ".ottili-coder"), { recursive: true });
    await writeFile(
      source,
      JSON.stringify({ providers: { local: { model: "test" } } }),
    );

    const preview = await previewLegacyConfig({ homeDirectory });
    expect(preview.importable).toBe(true);
    expect(preview.foundAt).toBe(source);

    const imported = await importLegacyConfig({ homeDirectory });
    expect(imported.importable).toBe(true);
    expect(
      JSON.parse(await readFile(imported.canonicalTarget, "utf8")),
    ).toEqual(preview.settings);
    expect(await readFile(source, "utf8")).toContain("providers");
  });
});

describe("local execution backend", () => {
  it("executes explicitly supplied command arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ottili-local-backend-"));
    temporaryDirectories.push(directory);
    const backend = new LocalExecutionBackend();
    const handle = await backend.start(directory);
    const result = await backend.execute(handle, {
      args: ["-e", "process.stdout.write('ready')"],
      command: process.execPath,
      cwd: directory,
    });
    expect(result).toMatchObject({ code: 0, stderr: "", stdout: "ready" });
  });
});
