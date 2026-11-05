import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { changedFiles } from "./managed.ts";
import { writeHome } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const marker = "# Managed by Fleet test.";

test("a text file is Fleet's only when its first line is the exact marker", async () => {
  const home = temp.make("fleet-managed-");
  const path = join(home, "owned.conf");
  writeHome(home, { "owned.conf": `${marker}\nold\n` });
  expect(await changedFiles(home, [{ path, content: `${marker}\nnew\n` }], marker, "test")).toHaveLength(1);
  for (const content of [`Host *\n${marker}\n`, `  ${marker}\n`, `${marker} and more\n`, `# quoting "${marker}"\n`]) {
    writeHome(home, { "owned.conf": content });
    await expect(changedFiles(home, [{ path, content: `${marker}\n` }], marker, "test")).rejects.toThrow("Keep unmanaged test file");
  }
});

test("an XML file is Fleet's when the marker is the first line after the XML declaration, and not when it sits further down", async () => {
  const home = temp.make("fleet-managed-");
  const path = join(home, "owned.plist");
  const xmlMarker = "<!-- Managed by Fleet test. -->";
  writeHome(home, { "owned.plist": `<?xml version="1.0"?>\n${xmlMarker}\n<plist/>\n` });
  expect(await changedFiles(home, [{ path, content: `<?xml version="1.0"?>\n${xmlMarker}\n<plist></plist>\n` }], xmlMarker, "test")).toHaveLength(1);
  writeHome(home, { "owned.plist": `<?xml version="1.0"?>\n<plist>\n${xmlMarker}\n</plist>\n` });
  await expect(changedFiles(home, [{ path, content: "" }], xmlMarker, "test")).rejects.toThrow("Keep unmanaged test file");
});
