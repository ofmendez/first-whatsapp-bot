import { readFile } from "node:fs/promises";
import { expect, test } from "bun:test";
import {
  activityCountLabel,
  activityEmptyCopy,
  selectActivityMessages,
} from "@/src/activity-filter.js";

const message = (id, sequence, albumed, conversationId) => ({
  id,
  sequence,
  albumed,
  conversationId,
  label: "Same Contact",
});

test("dashboard filter defaults to all ordered events and presents only approved events when enabled", () => {
  const firstConversation = "a".repeat(64);
  const secondConversation = "b".repeat(64);
  const messages = [
    message(3, 3, true, firstConversation),
    message(1, 1, false, firstConversation),
    message(2, 2, true, secondConversation),
  ];

  expect(selectActivityMessages(messages).map(({ id }) => id)).toEqual([1, 2, 3]);
  expect(selectActivityMessages(messages, true).map(({ id }) => id)).toEqual([2, 3]);
  expect(messages).toHaveLength(3);
  expect(activityCountLabel(0)).toBe("0 EVENTS");
  expect(activityCountLabel(1)).toBe("1 EVENT");
  expect(activityCountLabel(2)).toBe("2 EVENTS");
});

test("events arriving while filtered remain available when the presentation filter is disabled", () => {
  const approvedId = "c".repeat(64);
  const notApprovedId = "d".repeat(64);
  const retained = [message(1, 1, true, approvedId)];
  const hidden = message(2, 2, false, notApprovedId);
  retained.push(hidden);

  expect(selectActivityMessages(retained, true).map(({ id }) => id)).toEqual([1]);
  expect(selectActivityMessages(retained, false).map(({ id }) => id)).toEqual([1, 2]);
  expect(retained).toContain(hidden);
});

test("filtered empty feedback distinguishes hidden retained activity from a truly empty feed", () => {
  expect(activityEmptyCopy({ albumedOnly: true, retainedCount: 4 })).toEqual({
    heading: "No albumed activity matches",
    description:
      "Activity is still being collected. Events from albumed conversations will appear here.",
  });
  expect(activityEmptyCopy({ albumedOnly: true, retainedCount: 0 }).heading).toBe(
    "Waiting for a session",
  );
});

test("activity header contains a compact labeled native toggle without changing session controls", async () => {
  const [activityPanel, controlScript] = await Promise.all([
    readFile(new URL("../src/components/ActivityPanel.astro", import.meta.url), "utf8"),
    readFile(new URL("../src/scripts/control-panel.js", import.meta.url), "utf8"),
  ]);

  expect(activityPanel).toContain('id="albumed-only"');
  expect(activityPanel).toContain('type="checkbox"');
  expect(activityPanel).toContain("Albumed only");
  expect(activityPanel).toContain('aria-controls="activity-list"');
  expect(activityPanel).toContain('id="activity-count"');
  expect(controlScript).toContain('albumedOnly.addEventListener("change"');
  expect(controlScript).toContain("selectActivityMessages(messages.values(), albumedOnly.checked)");
  expect(controlScript).toContain("messages.set(id, message)");
  expect(controlScript).toContain('api("/api/session/start")');
  expect(controlScript).toContain('api("/api/messages/send", { text })');
});
