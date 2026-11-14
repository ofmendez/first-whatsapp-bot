import { readFile } from "node:fs/promises";
import { expect, mock, test } from "bun:test";
import { createAlbumVisibilityController } from "@/src/album-visibility-controller.js";

const firstConversationId = "a".repeat(64);
const secondConversationId = "b".repeat(64);
const visibilityList = {
  revision: 7,
  conversations: [
    {
      conversationId: firstConversationId,
      label: "First Contact",
      imageCount: 2,
      visible: true,
    },
    {
      conversationId: secondConversationId,
      label: "Second Contact",
      imageCount: 0,
      visible: false,
    },
  ],
};

test("dashboard visibility starts loading and initializes saved checkbox state", async () => {
  const load = mock(async () => visibilityList);
  const save = mock(async () => ({ revision: 8 }));
  const changes = [];
  const controller = createAlbumVisibilityController({
    load,
    save,
    onChange: (snapshot) => changes.push(snapshot),
  });

  expect(controller.getSnapshot()).toMatchObject({
    status: "loading",
    canSave: false,
    conversations: [],
  });
  const loaded = await controller.load();

  expect(load).toHaveBeenCalledTimes(1);
  expect(loaded).toMatchObject({
    status: "saved",
    revision: 7,
    hasUnsavedChanges: false,
    conversations: [
      { conversationId: firstConversationId, label: "First Contact", imageCount: 2, visible: true },
      {
        conversationId: secondConversationId,
        label: "Second Contact",
        imageCount: 0,
        visible: false,
      },
    ],
  });
  expect(changes.some(({ status }) => status === "loading")).toBe(true);
});

test("checkbox edits stay unsaved until the owner explicitly saves", async () => {
  const save = mock(async () => ({ revision: 8 }));
  const controller = createAlbumVisibilityController({
    load: async () => visibilityList,
    save,
  });
  await controller.load();

  const edited = controller.setVisible(firstConversationId, false);
  expect(edited).toMatchObject({
    status: "unsaved",
    hasUnsavedChanges: true,
    canSave: true,
    conversations: [
      { conversationId: firstConversationId, visible: false },
      { conversationId: secondConversationId, visible: false },
    ],
  });
  expect(save).not.toHaveBeenCalled();

  const reverted = controller.setVisible(firstConversationId, true);
  expect(reverted).toMatchObject({
    status: "saved",
    hasUnsavedChanges: false,
    canSave: false,
  });
  expect(save).not.toHaveBeenCalled();
});

test("successful explicit save sends hidden IDs and advances the saved revision", async () => {
  const save = mock(async () => ({ revision: 8 }));
  const controller = createAlbumVisibilityController({
    load: async () => visibilityList,
    save,
  });
  await controller.load();
  controller.setVisible(firstConversationId, false);

  const saved = await controller.save();

  expect(save).toHaveBeenCalledWith({
    revision: 7,
    hiddenConversationIds: [firstConversationId, secondConversationId],
  });
  expect(saved).toMatchObject({
    status: "saved",
    revision: 8,
    hasUnsavedChanges: false,
    canSave: false,
  });
  expect(saved.message).toContain("Subsequent album requests");
});

test("failed and stale saves keep the edited selection and expose recovery feedback", async () => {
  const failedController = createAlbumVisibilityController({
    load: async () => visibilityList,
    save: mock(async () => {
      throw new Error("synthetic write failure");
    }),
  });
  await failedController.load();
  failedController.setVisible(firstConversationId, false);
  const failed = await failedController.save();

  expect(failed).toMatchObject({
    status: "error",
    errorPhase: "save",
    hasUnsavedChanges: true,
    canSave: true,
    canReload: true,
  });
  expect(failed.conversations[0]).toMatchObject({
    conversationId: firstConversationId,
    visible: false,
  });
  expect(failed.message).toContain("Your edits are kept");

  const conflictController = createAlbumVisibilityController({
    load: async () => visibilityList,
    save: mock(async () => {
      throw Object.assign(new Error("stale"), { status: 409 });
    }),
  });
  await conflictController.load();
  conflictController.setVisible(firstConversationId, false);
  const conflict = await conflictController.save();

  expect(conflict).toMatchObject({
    status: "conflict",
    errorPhase: "save",
    revision: 7,
    hasUnsavedChanges: true,
    canSave: false,
    canReload: true,
    reloadLabel: "Discard edits & reload",
  });
  expect(conflict.conversations[0]).toMatchObject({
    conversationId: firstConversationId,
    visible: false,
  });
  expect(conflict.message).toContain("Another dashboard tab saved first");
});

test("dashboard panel is labeled, has an empty state, and stays separate from the activity filter", async () => {
  const [panel, page, activityPanel, controlScript] = await Promise.all([
    readFile(new URL("../src/components/AlbumVisibilityPanel.astro", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/index.astro", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ActivityPanel.astro", import.meta.url), "utf8"),
    readFile(new URL("../src/scripts/control-panel.js", import.meta.url), "utf8"),
  ]);

  expect(panel).toContain('aria-labelledby="album-visibility-heading"');
  expect(panel).toContain("<fieldset");
  expect(panel).toContain("<legend");
  expect(panel).toContain('id="album-visibility-list"');
  expect(panel).toContain('id="album-visibility-empty"');
  expect(panel).toContain('role="status"');
  expect(panel).toContain('id="album-visibility-save"');
  expect(page).toContain("<AlbumVisibilityPanel />");
  expect(activityPanel).toContain('id="albumed-only"');
  expect(controlScript).toContain('albumedOnly.addEventListener("change"');
  expect(controlScript).toContain("selectActivityMessages(messages.values(), albumedOnly.checked)");
});
