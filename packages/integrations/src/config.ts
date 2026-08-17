import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface LegacyConfigPreview {
  readonly canonicalTarget: string;
  readonly foundAt?: string;
  readonly importable: boolean;
  readonly notes: readonly string[];
  readonly settings: Record<string, unknown>;
}

export interface ImportLegacyConfigOptions {
  readonly homeDirectory?: string;
  readonly projectDirectory?: string;
  readonly overwrite?: boolean;
}

export function canonicalCoderDirectory(homeDirectory = homedir()): string {
  return join(homeDirectory, ".ottili", "coder");
}

export function canonicalProjectConfig(projectDirectory: string): string {
  return join(projectDirectory, ".ottili", "coder.json");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const candidate: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate)
    ) {
      return candidate as Record<string, unknown>;
    }
  } catch {
    // A malformed legacy file must remain untouched and importable only by manual repair.
  }
  return undefined;
}

function legacyCandidates(
  homeDirectory: string,
  projectDirectory?: string,
): readonly string[] {
  const candidates = [
    join(homeDirectory, ".ottili-coder", "config.json"),
    join(homeDirectory, ".config", "ottili-coder", "config.json"),
  ];
  if (projectDirectory !== undefined) {
    candidates.push(join(projectDirectory, ".ottili-coder", "config.json"));
  }
  return candidates;
}

export async function previewLegacyConfig(
  options: ImportLegacyConfigOptions = {},
): Promise<LegacyConfigPreview> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const canonicalTarget =
    options.projectDirectory === undefined
      ? join(canonicalCoderDirectory(homeDirectory), "config.json")
      : canonicalProjectConfig(options.projectDirectory);

  for (const candidate of legacyCandidates(
    homeDirectory,
    options.projectDirectory,
  )) {
    if (!(await exists(candidate))) continue;
    const settings = await readJsonObject(candidate);
    if (settings === undefined) {
      return {
        canonicalTarget,
        foundAt: candidate,
        importable: false,
        notes: ["Legacy configuration is not valid JSON and was not modified."],
        settings: {},
      };
    }
    return {
      canonicalTarget,
      foundAt: candidate,
      importable: true,
      notes: [
        "Preview only: importing never deletes or edits the legacy file.",
      ],
      settings,
    };
  }

  return {
    canonicalTarget,
    importable: false,
    notes: ["No legacy JSON configuration was found."],
    settings: {},
  };
}

export async function importLegacyConfig(
  options: ImportLegacyConfigOptions = {},
): Promise<LegacyConfigPreview> {
  const preview = await previewLegacyConfig(options);
  if (!preview.importable || preview.foundAt === undefined) return preview;
  if (!options.overwrite && (await exists(preview.canonicalTarget))) {
    return {
      ...preview,
      importable: false,
      notes: [
        ...preview.notes,
        "Canonical config already exists; pass overwrite explicitly to replace it.",
      ],
    };
  }
  await mkdir(dirname(preview.canonicalTarget), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    preview.canonicalTarget,
    `${JSON.stringify(preview.settings, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  return {
    ...preview,
    notes: [
      ...preview.notes,
      "Legacy settings were copied to the canonical config; source was left intact.",
    ],
  };
}
