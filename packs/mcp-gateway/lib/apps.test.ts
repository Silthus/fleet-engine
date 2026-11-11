import { expect, test } from "bun:test";
import { gmail, googleCalendar, googleDrive, toolAllowed } from "./apps.ts";

test("the Gmail route reads mail and writes drafts, and never sends, forwards, archives, deletes or labels", () => {
  for (const name of ["search_emails", "read_email_thread", "read_attachment", "list_drafts", "create_draft", "update_draft"]) expect(toolAllowed(gmail, name)).toBe(true);
  for (const name of ["send_email", "send_draft", "forward_email", "archive_email", "delete_email", "trash_email", "apply_labels", "create_label"]) expect(toolAllowed(gmail, name)).toBe(false);
});

test("the Calendar and Drive routes are read-only", () => {
  for (const name of ["search_events", "read_event", "get_availability"]) expect(toolAllowed(googleCalendar, name)).toBe(true);
  for (const name of ["create_event", "update_event", "delete_event", "respond_to_event"]) expect(toolAllowed(googleCalendar, name)).toBe(false);
  for (const name of ["search", "get_document_text", "get_spreadsheet_range", "get_slide"]) expect(toolAllowed(googleDrive, name)).toBe(true);
  for (const name of ["create_file", "update_document", "delete_file", "share_file", "move_file"]) expect(toolAllowed(googleDrive, name)).toBe(false);
});

test("the three Google apps share one Codex home, so one ChatGPT sign-in serves them all", () => {
  expect(new Set([gmail, googleCalendar, googleDrive].map((app) => app.account))).toEqual(new Set(["google"]));
});
