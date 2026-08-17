import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

export type SandboxMode =
  "safe" | "standard" | "autonomous" | "unrestricted" | "custom";
export type NetworkAccess = "deny" | "allowlist" | "allow";
export type ProcessAccess = "deny" | "allowlist" | "allow";
export type EnvironmentAccess = "deny" | "allowlist" | "allow";
export type SandboxBackend = "bubblewrap" | "sandbox-exec" | "none";

export interface SandboxFilesystemPolicy {
  /** `true` is deliberately reserved for the explicitly unrestricted mode. */
  readonly allowAnyPath: boolean;
  readonly writableRoots: readonly string[];
  readonly readonlyRoots: readonly string[];
}

export interface SandboxNetworkPolicy {
  readonly access: NetworkAccess;
  /** Required when `access` is `allowlist`; ignored for deny/allow. */
  readonly destinations: readonly string[];
}

export interface SandboxEnvironmentPolicy {
  readonly access: EnvironmentAccess;
  readonly variables: readonly string[];
}

export interface SandboxProcessPolicy {
  readonly access: ProcessAccess;
  readonly executables: readonly string[];
}

/** Serializable policy stored with agent and recovery state. */
export interface SandboxProfile {
  readonly version: 1;
  readonly mode: SandboxMode;
  readonly workspaceRoot: string;
  readonly filesystem: SandboxFilesystemPolicy;
  readonly network: SandboxNetworkPolicy;
  readonly environment: SandboxEnvironmentPolicy;
  readonly process: SandboxProcessPolicy;
}

export interface SandboxCapability {
  readonly available: boolean;
  readonly executablePath?: string;
}

export interface SandboxCapabilities {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly bubblewrap: SandboxCapability;
  readonly sandboxExec: SandboxCapability;
  readonly nativeBackend: SandboxBackend;
  readonly supportsFilesystemIsolation: boolean;
  readonly supportsNetworkIsolation: boolean;
  readonly supportsProcessIsolation: boolean;
  readonly degradedReasons: readonly string[];
}

export interface SandboxCapabilityDetectionOptions {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly path?: string;
  /** Injectable probe makes capability tests platform-independent. */
  readonly executableProbe?: (executable: string) => Promise<string | null>;
}

export interface SandboxEnforcementStatus {
  readonly backend: SandboxBackend;
  readonly enforcement: "native" | "degraded" | "none";
  readonly reasons: readonly string[];
}

export class SandboxInheritanceError extends Error {
  public readonly violations: readonly string[];

  public constructor(violations: readonly string[]) {
    super(
      `Child sandbox profile would broaden its parent: ${violations.join("; ")}`,
    );
    this.name = "SandboxInheritanceError";
    this.violations = [...violations];
  }
}

function normalizePathList(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map((path) => resolve(path)))].sort();
}

function normalizeStringList(values: readonly string[]): readonly string[] {
  return [
    ...new Set(
      values.map((value) => value.trim()).filter((value) => value.length > 0),
    ),
  ].sort();
}

function isWithin(candidate: string, parent: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath.length === 0 ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function accessRank(
  access: NetworkAccess | ProcessAccess | EnvironmentAccess,
): number {
  switch (access) {
    case "deny":
      return 0;
    case "allowlist":
      return 1;
    case "allow":
      return 2;
  }
}

function isListNoBroader(
  candidateAccess: NetworkAccess | ProcessAccess | EnvironmentAccess,
  candidateValues: readonly string[],
  parentAccess: NetworkAccess | ProcessAccess | EnvironmentAccess,
  parentValues: readonly string[],
): boolean {
  if (accessRank(candidateAccess) > accessRank(parentAccess)) {
    return false;
  }
  if (candidateAccess !== "allowlist" || parentAccess === "allow") {
    return true;
  }
  if (parentAccess !== "allowlist") {
    return false;
  }
  const parentSet = new Set(parentValues);
  return candidateValues.every((value) => parentSet.has(value));
}

function normalizeProfile(profile: SandboxProfile): SandboxProfile {
  const workspaceRoot = resolve(profile.workspaceRoot);
  const normalized: SandboxProfile = {
    version: 1,
    mode: profile.mode,
    workspaceRoot,
    filesystem: {
      allowAnyPath: profile.filesystem.allowAnyPath,
      writableRoots: normalizePathList(profile.filesystem.writableRoots),
      readonlyRoots: normalizePathList(profile.filesystem.readonlyRoots),
    },
    network: {
      access: profile.network.access,
      destinations: normalizeStringList(profile.network.destinations),
    },
    environment: {
      access: profile.environment.access,
      variables: normalizeStringList(profile.environment.variables),
    },
    process: {
      access: profile.process.access,
      executables: normalizeStringList(profile.process.executables),
    },
  };

  if (
    normalized.network.access === "allowlist" &&
    normalized.network.destinations.length === 0
  ) {
    throw new SandboxInheritanceError(["network allowlist cannot be empty"]);
  }
  if (
    normalized.process.access === "allowlist" &&
    normalized.process.executables.length === 0
  ) {
    throw new SandboxInheritanceError([
      "process executable allowlist cannot be empty",
    ]);
  }
  if (
    normalized.environment.access === "allowlist" &&
    normalized.environment.variables.length === 0
  ) {
    throw new SandboxInheritanceError([
      "environment variable allowlist cannot be empty",
    ]);
  }
  return normalized;
}

/** Conservative defaults; enforcement is assessed separately from policy intent. */
export function createSandboxProfile(
  mode: SandboxMode,
  workspaceRoot: string,
): SandboxProfile {
  const root = resolve(workspaceRoot);
  switch (mode) {
    case "safe":
      return normalizeProfile({
        version: 1,
        mode,
        workspaceRoot: root,
        filesystem: {
          allowAnyPath: false,
          writableRoots: [],
          readonlyRoots: [root],
        },
        network: { access: "deny", destinations: [] },
        environment: { access: "deny", variables: [] },
        process: { access: "deny", executables: [] },
      });
    case "standard":
      return normalizeProfile({
        version: 1,
        mode,
        workspaceRoot: root,
        filesystem: {
          allowAnyPath: false,
          writableRoots: [root],
          readonlyRoots: [],
        },
        network: { access: "deny", destinations: [] },
        environment: {
          access: "allowlist",
          variables: ["HOME", "PATH", "TEMP", "TMP", "TMPDIR"],
        },
        process: {
          access: "allowlist",
          executables: ["git", "node", "npm", "pnpm"],
        },
      });
    case "autonomous":
      return normalizeProfile({
        version: 1,
        mode,
        workspaceRoot: root,
        filesystem: {
          allowAnyPath: false,
          writableRoots: [root],
          readonlyRoots: [],
        },
        network: { access: "allow", destinations: [] },
        environment: { access: "allow", variables: [] },
        process: { access: "allow", executables: [] },
      });
    case "unrestricted":
      return normalizeProfile({
        version: 1,
        mode,
        workspaceRoot: root,
        filesystem: {
          allowAnyPath: true,
          writableRoots: [root],
          readonlyRoots: [],
        },
        network: { access: "allow", destinations: [] },
        environment: { access: "allow", variables: [] },
        process: { access: "allow", executables: [] },
      });
    case "custom":
      throw new SandboxInheritanceError([
        "custom profiles must be supplied explicitly and validated with inheritSandboxProfile",
      ]);
  }
}

/**
 * Validates and returns a child profile. All permissions are compared directly;
 * a child never becomes broader merely because it has a more permissive label.
 */
export function inheritSandboxProfile(
  parent: SandboxProfile,
  requestedChild: SandboxProfile,
): SandboxProfile {
  const normalizedParent = normalizeProfile(parent);
  const child = normalizeProfile(requestedChild);
  const violations: string[] = [];

  if (
    child.filesystem.allowAnyPath &&
    !normalizedParent.filesystem.allowAnyPath
  ) {
    violations.push("filesystem.allowAnyPath");
  }
  if (!normalizedParent.filesystem.allowAnyPath) {
    const parentReadableRoots = [
      ...normalizedParent.filesystem.writableRoots,
      ...normalizedParent.filesystem.readonlyRoots,
    ];
    if (
      !child.filesystem.writableRoots.every((root) =>
        normalizedParent.filesystem.writableRoots.some((parentRoot) =>
          isWithin(root, parentRoot),
        ),
      )
    ) {
      violations.push("filesystem.writableRoots");
    }
    if (
      !child.filesystem.readonlyRoots.every((root) =>
        parentReadableRoots.some((parentRoot) => isWithin(root, parentRoot)),
      )
    ) {
      violations.push("filesystem.readonlyRoots");
    }
  }

  if (
    !isListNoBroader(
      child.network.access,
      child.network.destinations,
      normalizedParent.network.access,
      normalizedParent.network.destinations,
    )
  ) {
    violations.push("network");
  }
  if (
    !isListNoBroader(
      child.environment.access,
      child.environment.variables,
      normalizedParent.environment.access,
      normalizedParent.environment.variables,
    )
  ) {
    violations.push("environment");
  }
  if (
    !isListNoBroader(
      child.process.access,
      child.process.executables,
      normalizedParent.process.access,
      normalizedParent.process.executables,
    )
  ) {
    violations.push("process");
  }

  if (violations.length > 0) {
    throw new SandboxInheritanceError(violations);
  }
  return child;
}

/**
 * Rebinds a durable policy when the same agent moves to a different worktree.
 * Roots nested under the old workspace retain their relative scope; external
 * roots are left untouched rather than accidentally widening access.
 */
export function rebindSandboxProfile(
  profile: SandboxProfile,
  nextWorkspaceRoot: string,
): SandboxProfile {
  const normalized = normalizeProfile(profile);
  const replacementRoot = resolve(nextWorkspaceRoot);
  const rebase = (path: string): string => {
    if (!isWithin(path, normalized.workspaceRoot)) {
      return path;
    }
    const relativePath = relative(normalized.workspaceRoot, path);
    return relativePath.length === 0
      ? replacementRoot
      : resolve(replacementRoot, relativePath);
  };
  return normalizeProfile({
    ...normalized,
    workspaceRoot: replacementRoot,
    filesystem: {
      ...normalized.filesystem,
      writableRoots: normalized.filesystem.writableRoots.map(rebase),
      readonlyRoots: normalized.filesystem.readonlyRoots.map(rebase),
    },
  });
}

async function findExecutable(
  executable: string,
  pathValue: string,
): Promise<string | null> {
  const extensions =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(directory, `${executable}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Probe all PATH entries; absence is an expected capability outcome.
      }
    }
  }
  return null;
}

/** Detect native sandbox support instead of assuming it from the host OS. */
export async function detectSandboxCapabilities(
  options: SandboxCapabilityDetectionOptions = {},
): Promise<SandboxCapabilities> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const probe =
    options.executableProbe ??
    (async (executable: string): Promise<string | null> =>
      findExecutable(executable, options.path ?? process.env.PATH ?? ""));
  const [bubblewrapPath, sandboxExecPath] = await Promise.all([
    platform === "linux" ? probe("bwrap") : Promise.resolve(null),
    platform === "darwin" ? probe("sandbox-exec") : Promise.resolve(null),
  ]);
  const bubblewrap: SandboxCapability =
    bubblewrapPath === null
      ? { available: false }
      : { available: true, executablePath: bubblewrapPath };
  const sandboxExec: SandboxCapability =
    sandboxExecPath === null
      ? { available: false }
      : { available: true, executablePath: sandboxExecPath };

  if (bubblewrap.available) {
    return {
      platform,
      architecture,
      bubblewrap,
      sandboxExec,
      nativeBackend: "bubblewrap",
      supportsFilesystemIsolation: true,
      supportsNetworkIsolation: true,
      supportsProcessIsolation: true,
      degradedReasons: [],
    };
  }
  if (sandboxExec.available) {
    return {
      platform,
      architecture,
      bubblewrap,
      sandboxExec,
      nativeBackend: "sandbox-exec",
      supportsFilesystemIsolation: true,
      supportsNetworkIsolation: true,
      supportsProcessIsolation: false,
      degradedReasons: [
        "macOS sandbox-exec does not provide Linux-style PID/process namespace isolation.",
      ],
    };
  }

  const platformReason =
    platform === "linux"
      ? "bubblewrap (bwrap) is not available on PATH."
      : platform === "darwin"
        ? "sandbox-exec is not available on PATH."
        : `No supported native sandbox backend is available for ${platform}.`;
  return {
    platform,
    architecture,
    bubblewrap,
    sandboxExec,
    nativeBackend: "none",
    supportsFilesystemIsolation: false,
    supportsNetworkIsolation: false,
    supportsProcessIsolation: false,
    degradedReasons: [platformReason],
  };
}

/** Reports whether policy intent can be natively enforced on this host. */
export function assessSandboxEnforcement(
  profile: SandboxProfile,
  capabilities: SandboxCapabilities,
): SandboxEnforcementStatus {
  const normalized = normalizeProfile(profile);
  const restricted =
    !normalized.filesystem.allowAnyPath ||
    normalized.network.access !== "allow" ||
    normalized.process.access !== "allow" ||
    normalized.environment.access !== "allow";
  if (!restricted) {
    return {
      backend: capabilities.nativeBackend,
      enforcement: "none",
      reasons: [],
    };
  }
  if (capabilities.nativeBackend === "bubblewrap") {
    return { backend: "bubblewrap", enforcement: "native", reasons: [] };
  }
  if (capabilities.nativeBackend === "sandbox-exec") {
    return {
      backend: "sandbox-exec",
      enforcement: "degraded",
      reasons: [
        ...capabilities.degradedReasons,
        "Environment and executable allowlists require runner-level enforcement.",
      ],
    };
  }
  return {
    backend: "none",
    enforcement: "degraded",
    reasons: [
      ...capabilities.degradedReasons,
      "Policy is retained and must be enforced by the selected runner on this platform.",
    ],
  };
}
