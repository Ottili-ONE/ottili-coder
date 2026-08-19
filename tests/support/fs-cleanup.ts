import { rm } from "node:fs/promises";

/**
 * Removes a temporary directory, retrying on Windows file-lock errors.
 *
 * `node:sqlite`/WAL mode can leave a brief window after `close()` where the OS
 * has not yet released its handle on the `.db`/`-wal`/`-shm` files. On Windows
 * this makes a `fs.rm` racing that window fail with `EBUSY` even though
 * nothing in this process still holds the file open. `fs.rm`'s own
 * `maxRetries` defaults to 0, so the retry has to be requested explicitly.
 */
export async function removeTempDirectory(path: string): Promise<void> {
  await rm(path, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 100,
  });
}
