import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function writePrivateFile(path: string, content: string) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}`);
  const file = await open(temporary, "wx", 0o600);
  let renamed = false;
  try {
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}
