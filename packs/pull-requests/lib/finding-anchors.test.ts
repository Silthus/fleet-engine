import { expect, test } from "bun:test";
import { anchorCheck } from "./finding-anchors.ts";

const diff = `diff --git a/greeting.ts b/greeting.ts
index 1111111..2222222 100644
--- a/greeting.ts
+++ b/greeting.ts
@@ -1,3 +1,4 @@
 const name = member.name;
-const greeting = "Hi";
+const greeting = "Welcome";
+send(greeting, name);
 log(name);
diff --git a/legacy.ts b/legacy.ts
deleted file mode 100644
index 3333333..0000000
--- a/legacy.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const legacyGreeting = "Hello there";
-export default legacyGreeting;
`;

const finding = (location: string, anchor: string) => `- high, ${location}, the greeting is wrong | anchor: ${anchor}\n`;

test("an anchor counts only at the file and line the finding names, on either side of the diff", () => {
  expect(anchorCheck(finding("greeting.ts:2", `const greeting = "Welcome";`), diff, [])).toBe("");
  expect(anchorCheck(finding("greeting.ts:2", `const greeting = "Hi";`), diff, [])).toBe("");
  expect(anchorCheck(finding("greeting.ts:1-3", "send(greeting, name);"), diff, [])).toBe("");
  expect(anchorCheck(finding("greeting.ts:4", `const greeting = "Welcome";`), diff, [])).toContain("Not in the diff");
});

test("an anchor in a deleted file counts at its old line", () => {
  expect(anchorCheck(finding("legacy.ts:1", `export const legacyGreeting = "Hello there";`), diff, [])).toBe("");
  expect(anchorCheck(finding("legacy.ts:2", `export const legacyGreeting = "Hello there";`), diff, [])).toContain("Not in the diff");
});

test("a line range is checked against the diff's lines, so a huge or unsafe range ends at once", () => {
  const started = performance.now();
  expect(anchorCheck(finding("greeting.ts:1-2000000000", "send(greeting, name);"), diff, [])).toBe("");
  expect(anchorCheck(finding("greeting.ts:9007199254740992-9007199254740994", "send(greeting, name);"), diff, [])).toContain("Not in the diff");
  expect(performance.now() - started).toBeLessThan(1000);
});
