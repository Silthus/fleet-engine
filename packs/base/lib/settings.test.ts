import { expect, test } from "bun:test";
import { numberSetting, stringSetting } from "./settings.ts";

const env = { FLEET_SETTINGS: JSON.stringify({ "base.heavySlots": 3, "orchestration.mapTracker": "me/fleet-profile" }) };

test("reads a typed setting that the plan resolved", () => {
  expect(numberSetting("base.heavySlots", env)).toBe(3);
  expect(stringSetting("orchestration.mapTracker", env)).toBe("me/fleet-profile");
});

test("refuses a setting that no enabled pack declares, or one of the wrong type", () => {
  expect(() => numberSetting("base.missing", env)).toThrow("setting base.missing is not declared by an enabled pack");
  expect(() => stringSetting("base.heavySlots", env)).toThrow("setting base.heavySlots is a number, not a string");
});

test("says how to run a command outside fleet", () => {
  expect(() => numberSetting("base.heavySlots", {})).toThrow("run this command as fleet <command>, so it gets your settings");
});
