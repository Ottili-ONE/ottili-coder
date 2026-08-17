import { rm } from "node:fs/promises";

for (const directory of ["dist", "coverage"]) {
  await rm(directory, { force: true, recursive: true });
}
