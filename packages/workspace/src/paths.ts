import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

/**
 * Platforms whose default filesystems compare path names case-insensitively.
 * Git echoes the on-disk spelling, so a comparison that is byte-exact can
 * disagree with the operating system about whether two paths are the same
 * location (`C:\Temp` vs `c:\temp`).
 */
function isCaseInsensitivePlatform(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

function isUnresolvableComponentError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  // ENOENT: the component does not exist yet. ENOTDIR: an ancestor is a file.
  // EACCES/EPERM: the component cannot be inspected; fall back to the parent.
  return (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EACCES" ||
    code === "EPERM"
  );
}

/**
 * Resolves a path to the same canonical form Git reports.
 *
 * `path.resolve` normalizes `.`/`..` but never follows symbolic links, so on
 * macOS a workspace under `os.tmpdir()` stays `/var/folders/...` while Git
 * reports `/private/var/folders/...`. Comparing the two forms directly makes a
 * correctly created worktree look missing. Paths that do not exist yet are
 * still canonicalized by resolving the deepest existing ancestor and
 * re-appending the remaining components.
 */
export async function canonicalizePath(path: string): Promise<string> {
  const absolute = resolve(path);
  const pendingComponents: string[] = [];
  let candidate = absolute;

  for (;;) {
    try {
      const resolved = await realpath(candidate);
      return pendingComponents.length === 0
        ? resolved
        : resolve(resolved, ...pendingComponents);
    } catch (error: unknown) {
      if (!isUnresolvableComponentError(error)) {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        // The filesystem root itself is unresolvable; nothing can be followed.
        return absolute;
      }
      pendingComponents.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Compares two already-canonical paths using the host's case rules. Exact
 * equality is always accepted so a case-sensitive volume on a nominally
 * case-insensitive platform still matches.
 */
export function canonicalPathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (left === right) {
    return true;
  }
  return (
    isCaseInsensitivePlatform(platform) &&
    left.toLowerCase() === right.toLowerCase()
  );
}

/** Canonicalizes both operands before comparing them. */
export async function isSamePath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    canonicalizePath(left),
    canonicalizePath(right),
  ]);
  return canonicalPathsEqual(canonicalLeft, canonicalRight, platform);
}
