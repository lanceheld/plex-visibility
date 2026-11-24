import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Read a JSON file, returning undefined if it doesn't exist. */
export async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Write JSON atomically so a crash mid-write can't corrupt the file. */
export async function writeJson(file: string, data: unknown, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode });
  await rename(tmp, file);
}
