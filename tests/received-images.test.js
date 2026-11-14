import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { expect, mock, test } from "bun:test";
import { ImageReceiver } from "@/src/image-receiver.js";
import {
  AlbumVisibilityConflictError,
  AlbumVisibilityUnavailableError,
  AlbumVisibilityValidationError,
  ReceivedImageStore,
} from "@/src/received-image-store.js";
import { SessionController } from "@/src/session-controller.js";

const imageStream = (value = "synthetic image bytes") => Readable.from([Buffer.from(value)]);

test("conversation approval creates the shared folder first and reserves one confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "album-approval-"));
  try {
    const store = new ReceivedImageStore({ root });
    const approval = {
      accountJid: "owner:4@s.whatsapp.net",
      chatJid: "friend@s.whatsapp.net",
      displayName: "Friend/../Contact",
    };
    const identity = store.getConversationIdentity(approval.accountJid, approval.chatJid);
    const results = await Promise.all([
      store.approveConversation(approval),
      store.approveConversation(approval),
    ]);
    const folder = await store.ensureConversationFolder({
      ...approval,
      displayName: "Renamed Contact",
    });
    const saved = await store.save({
      accountJid: approval.accountJid,
      chatJid: approval.chatJid,
      displayName: approval.displayName,
      messageId: "first-after-approval",
      timestamp: "2026-11-12T12:00:00.000Z",
      mimeType: "image/jpeg",
      stream: imageStream(),
    });
    const entries = await readdir(root, { withFileTypes: true });
    const markerPath = join(folder, "album.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    const afterRestart = new ReceivedImageStore({ root });

    expect(results.map(({ shouldConfirm }) => shouldConfirm).sort()).toEqual([false, true]);
    expect(results.every(({ conversationId }) => conversationId === identity.conversationId)).toBe(
      true,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].isDirectory()).toBe(true);
    expect(folder).toBe(join(root, entries[0].name));
    expect(entries[0].name).toContain("--chat-friend-at-s.whatsapp.net-");
    expect(entries[0].name).not.toContain("../");
    expect(dirname(saved.path)).toBe(folder);
    expect(marker).toMatchObject({
      version: 1,
      accountJid: "owner@s.whatsapp.net",
      chatJid: "friend@s.whatsapp.net",
      conversationId: identity.conversationId,
      albumed: true,
      confirmationAttemptReserved: true,
    });
    expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
    expect(await afterRestart.readAlbumApproval(folder)).toMatchObject({
      conversationId: identity.conversationId,
      approvedAt: marker.approvedAt,
    });

    const otherAccount = await store.approveConversation({
      ...approval,
      accountJid: "another-owner@s.whatsapp.net",
    });
    expect(otherAccount.conversationId).not.toBe(identity.conversationId);
    expect(await readdir(root, { withFileTypes: true })).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approval marker failures and mismatched identities fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "album-approval-failure-"));
  try {
    const approval = {
      accountJid: "owner@s.whatsapp.net",
      chatJid: "friend@s.whatsapp.net",
      displayName: "Contact",
    };
    const failedWriter = new ReceivedImageStore({
      root,
      renameMetadataFile: async () => {
        throw new Error("synthetic metadata rename failure");
      },
    });
    await expect(failedWriter.approveConversation(approval)).rejects.toThrow(
      "Album approval could not be saved",
    );
    const folder = await failedWriter.ensureConversationFolder(approval);
    expect(await failedWriter.readAlbumApproval(folder)).toBeUndefined();
    expect(await readdir(folder)).toEqual([]);

    const validStore = new ReceivedImageStore({ root });
    await writeFile(join(folder, "album.json"), "{malformed", { mode: 0o600 });
    expect(await validStore.readAlbumApproval(folder)).toBeUndefined();
    await expect(validStore.approveConversation(approval)).rejects.toThrow(
      "Album approval record is invalid",
    );
    expect(await readFile(join(folder, "album.json"), "utf8")).toBe("{malformed");

    const mismatchedRoot = await mkdtemp(join(tmpdir(), "album-approval-mismatch-"));
    try {
      const mismatchedStore = new ReceivedImageStore({ root: mismatchedRoot });
      const mismatchedFolder = await mismatchedStore.ensureConversationFolder(approval);
      const mismatchedConversationId = mismatchedStore.getConversationIdentity(
        approval.accountJid,
        "different-chat@s.whatsapp.net",
      ).conversationId;
      const now = new Date().toISOString();
      await writeFile(
        join(mismatchedFolder, "album.json"),
        JSON.stringify({
          version: 1,
          accountJid: "owner@s.whatsapp.net",
          chatJid: "different-chat@s.whatsapp.net",
          conversationId: mismatchedConversationId,
          albumed: true,
          approvedAt: now,
          confirmationAttemptReserved: true,
          confirmationAttemptReservedAt: now,
        }),
        { mode: 0o600 },
      );
      expect(await mismatchedStore.readAlbumApproval(mismatchedFolder)).toBeUndefined();
      await expect(mismatchedStore.approveConversation(approval)).rejects.toThrow(
        "Album approval record is invalid",
      );
    } finally {
      await rm(mismatchedRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image store keeps a flat, ID-isolated folder with generated safe filenames", async () => {
  const root = await mkdtemp(join(tmpdir(), "received-image-store-"));
  try {
    const store = new ReceivedImageStore({ root });
    const first = await store.save({
      accountJid: "owner:4@s.whatsapp.net",
      chatJid: "friend@s.whatsapp.net",
      displayName: "Friend/../Contact",
      messageId: "../../incoming-image.jpg",
      timestamp: "2026-11-12T12:00:00.000Z",
      mimeType: "image/jpeg; charset=binary",
      stream: imageStream(),
    });
    const duplicate = await store.save({
      accountJid: "owner@s.whatsapp.net",
      chatJid: "friend@s.whatsapp.net",
      displayName: "Changed Name",
      messageId: "../../incoming-image.jpg",
      timestamp: "2026-11-12T12:00:00.000Z",
      mimeType: "image/jpeg",
      stream: imageStream("duplicate bytes are not written"),
    });
    await store.save({
      accountJid: "owner@s.whatsapp.net",
      chatJid: "friend@s.whatsapp.net",
      displayName: "Changed Name",
      messageId: "after-name-change",
      timestamp: "2026-11-12T12:00:30.000Z",
      mimeType: "image/jpeg",
      stream: imageStream(),
    });
    await store.save({
      accountJid: "owner@s.whatsapp.net",
      chatJid: "another-friend@s.whatsapp.net",
      displayName: "Friend/../Contact",
      messageId: "second-chat",
      timestamp: "2026-11-12T12:01:00.000Z",
      mimeType: "image/png",
      stream: imageStream(),
    });
    await store.save({
      accountJid: "another-owner@s.whatsapp.net",
      chatJid: "friend@s.whatsapp.net",
      displayName: "Friend/../Contact",
      messageId: "other-account",
      timestamp: "2026-11-12T12:02:00.000Z",
      mimeType: "image/webp",
      stream: imageStream(),
    });
    const afterRestart = new ReceivedImageStore({ root });
    await afterRestart.save({
      accountJid: "owner@s.whatsapp.net",
      chatJid: "friend@s.whatsapp.net",
      displayName: "Renamed After Restart",
      messageId: "after-restart-name-change",
      timestamp: "2026-11-12T12:03:00.000Z",
      mimeType: "image/jpeg",
      stream: imageStream(),
    });

    expect(duplicate).toEqual(first);
    const folders = await readdir(root, { withFileTypes: true });
    expect(folders).toHaveLength(3);
    expect(folders.every((folder) => folder.isDirectory())).toBe(true);
    expect(folders.map((folder) => folder.name).some((name) => name.endsWith("Contact"))).toBe(
      true,
    );
    expect(basename(dirname(first.path))).toBe(
      folders.find((folder) => folder.name.startsWith("account-owner"))?.name,
    );

    for (const folder of folders) {
      const entries = await readdir(join(root, folder.name), { withFileTypes: true });
      const originals = entries.filter((entry) =>
        /^image-\d+-[a-f0-9]{20}\.(?:jpg|png|webp|gif|avif)$/.test(entry.name),
      );
      const sidecars = entries.filter((entry) => entry.name.endsWith(".json"));
      expect(originals.length).toBe(folder.name === basename(dirname(first.path)) ? 3 : 1);
      expect(sidecars).toHaveLength(originals.length);
      for (const entry of originals) {
        expect(entry.isFile()).toBe(true);
        expect(entry.name).toMatch(/^image-\d+-[a-f0-9]{20}\.(?:jpg|png|webp|gif|avif)$/);
        expect(entry.name).not.toContain("incoming-image");
        expect((await stat(join(root, folder.name, entry.name))).isFile()).toBe(true);
        expect(sidecars.some((sidecar) => sidecar.name === `${entry.name}.json`)).toBe(true);
      }
    }

    expect(await store.openMedia(first.mediaId)).toMatchObject({ contentType: "image/jpeg" });
    expect(await store.openMedia("../../etc/passwd")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image receiver streams one direct image, deduplicates repeats, and emits private metadata only", async () => {
  const message = {
    key: { id: "synthetic-message-id", remoteJid: "contact@s.whatsapp.net", fromMe: false },
    message: { imageMessage: { mimetype: "image/png", caption: "synthetic private caption" } },
    messageTimestamp: 1_800_000_000,
    pushName: "Contact",
  };
  const save = mock(async () => ({
    mediaId: "aabbccdd-aabb-4abb-8abb-aabbccddaabb",
    path: "/private/local/path.png",
    previewUrl: "/api/media/aabbccdd-aabb-4abb-8abb-aabbccddaabb",
  }));
  const download = mock(async () => imageStream());
  const onSaved = mock(() => {});
  const receiver = new ImageReceiver({ store: { save }, download, onSaved });
  const events = [];
  const upsert = { type: "notify", messages: [message] };

  await receiver.receive(upsert, ["owner@s.whatsapp.net"], (event) => events.push(event));
  await receiver.receive(upsert, ["owner@s.whatsapp.net"], (event) => events.push(event));

  expect(download).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][0]).toMatchObject({
    accountJid: "owner@s.whatsapp.net",
    chatJid: "contact@s.whatsapp.net",
    displayName: "Contact",
    mimeType: "image/png",
    caption: "synthetic private caption",
  });
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({
    kind: "image",
    direction: "incoming",
    isSelfChat: false,
    label: "Contact",
    timestamp: new Date(1_800_000_000_000).toISOString(),
    caption: "synthetic private caption",
    previewUrl: "/api/media/aabbccdd-aabb-4abb-8abb-aabbccddaabb",
    unavailable: false,
  });
  expect(JSON.stringify(events)).not.toContain("owner@s.whatsapp.net");
  expect(JSON.stringify(events)).not.toContain("contact@s.whatsapp.net");
  expect(JSON.stringify(events)).not.toContain("/private/local/path.png");
  expect(JSON.stringify(events)).not.toContain("synthetic-message-id");
});

test("saved image activity includes an opaque conversation identity and current approval only", async () => {
  const root = await mkdtemp(join(tmpdir(), "received-image-activity-"));
  try {
    const store = new ReceivedImageStore({ root });
    const accountJid = "owner:2@s.whatsapp.net";
    const chatJid = "contact@s.whatsapp.net";
    const identity = store.getConversationIdentity(accountJid, chatJid);
    await store.approveConversation({ accountJid, chatJid, displayName: "Same Contact" });
    const receiver = new ImageReceiver({
      store,
      download: async () => imageStream(),
      isConversationApproved: (conversationId) => conversationId === identity.conversationId,
    });
    const events = [];
    await receiver.receive(
      {
        type: "notify",
        messages: [
          {
            key: { id: "synthetic-approved-image", remoteJid: chatJid, fromMe: false },
            message: { imageMessage: { mimetype: "image/png" } },
            messageTimestamp: 1_800_000_000,
            pushName: "Same Contact",
          },
        ],
      },
      [accountJid],
      (event) => events.push(event),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "image",
      conversationId: identity.conversationId,
      albumed: true,
      label: "Same Contact",
    });
    expect(JSON.stringify(events)).not.toContain(accountJid);
    expect(JSON.stringify(events)).not.toContain(chatJid);
    expect(JSON.stringify(events)).not.toContain(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image sidecars retain dates, captions, stable IDs, and owner overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "received-image-metadata-"));
  try {
    const store = new ReceivedImageStore({ root });
    const saved = await store.save({
      accountJid: "owner@s.whatsapp.net",
      chatJid: "contact@s.whatsapp.net",
      displayName: "Contact",
      messageId: "captioned-image",
      timestamp: "2026-11-12T12:34:56.789Z",
      mimeType: "image/jpeg",
      caption: "original attached caption",
      stream: imageStream("original synthetic image bytes"),
    });
    const sidecarPath = `${saved.path}.json`;
    const initial = JSON.parse(await readFile(sidecarPath, "utf8"));
    expect(initial).toMatchObject({
      version: 1,
      filename: basename(saved.path),
      timestamp: "2026-11-12T12:34:56.789Z",
      mimeType: "image/jpeg",
      caption: "original attached caption",
    });
    expect(initial.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(saved.imageId).toBe(initial.id);
    expect((await stat(sidecarPath)).mode & 0o777).toBe(0o600);

    await writeFile(
      sidecarPath,
      JSON.stringify({ ...initial, captionOverride: "edited caption" }),
      {
        mode: 0o600,
      },
    );
    const duplicate = await store.save({
      accountJid: "owner@s.whatsapp.net",
      chatJid: "contact@s.whatsapp.net",
      displayName: "Renamed Contact",
      messageId: "captioned-image",
      timestamp: "2026-11-12T12:34:56.789Z",
      mimeType: "image/jpeg",
      caption: "replacement caption must not win",
      stream: imageStream("replacement bytes must not win"),
    });
    const metadata = await store.readImageMetadata(dirname(saved.path), basename(saved.path));
    expect(duplicate.imageId).toBe(initial.id);
    expect(await readFile(saved.path, "utf8")).toBe("original synthetic image bytes");
    expect(metadata).toMatchObject({
      id: initial.id,
      caption: "original attached caption",
      captionOverride: "edited caption",
      effectiveCaption: "edited caption",
    });

    await writeFile(sidecarPath, JSON.stringify({ ...initial, captionOverride: "" }), {
      mode: 0o600,
    });
    expect(await store.readImageMetadata(dirname(saved.path), basename(saved.path))).toMatchObject({
      effectiveCaption: undefined,
    });
    const afterRestart = new ReceivedImageStore({ root });
    const restartedDuplicate = await afterRestart.save({
      accountJid: "owner@s.whatsapp.net",
      chatJid: "contact@s.whatsapp.net",
      displayName: "Contact after restart",
      messageId: "captioned-image",
      timestamp: "2026-11-12T12:34:56.789Z",
      mimeType: "image/jpeg",
      caption: "restart must not replace the original",
      stream: imageStream("restart must not replace original bytes"),
    });
    expect(restartedDuplicate.imageId).toBe(initial.id);
    expect(await readFile(saved.path, "utf8")).toBe("original synthetic image bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sidecar failure preserves the saved original and dashboard preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "received-image-sidecar-failure-"));
  try {
    const store = new ReceivedImageStore({
      root,
      writeMetadataFile: async () => {
        throw new Error("synthetic sidecar write failure");
      },
    });
    const saved = await store.save({
      accountJid: "owner@s.whatsapp.net",
      chatJid: "contact@s.whatsapp.net",
      displayName: "Contact",
      messageId: "sidecar-failure",
      timestamp: "2026-11-12T12:34:56.789Z",
      mimeType: "image/png",
      caption: "private caption",
      stream: imageStream(),
    });
    const entries = await readdir(dirname(saved.path));

    expect(saved.previewUrl).toStartWith("/api/media/");
    expect(saved.imageId).toBeUndefined();
    expect(await store.openMedia(saved.mediaId)).toMatchObject({ contentType: "image/png" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe(basename(saved.path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image receiver reports a generic unavailable event when media download fails", async () => {
  const download = mock(async () => {
    throw new Error("private JID, path, and media error");
  });
  const store = {
    save: mock(async () => {
      throw new Error("must not be called");
    }),
  };
  const receiver = new ImageReceiver({ store, download });
  const events = [];

  await receiver.receive(
    {
      type: "notify",
      messages: [
        {
          key: { id: "failed-image", remoteJid: "contact@s.whatsapp.net", fromMe: false },
          message: { imageMessage: { mimetype: "image/jpeg", caption: "caption is allowed" } },
          pushName: "Contact",
        },
      ],
    },
    ["owner@s.whatsapp.net"],
    (event) => events.push(event),
  );

  expect(events).toEqual([
    {
      kind: "image",
      direction: "incoming",
      isSelfChat: false,
      label: "Contact",
      timestamp: expect.any(String),
      caption: "caption is allowed",
      unavailable: true,
    },
  ]);
  expect(JSON.stringify(events)).not.toContain("private JID");
  expect(store.save).not.toHaveBeenCalled();
});

test("image receiver reports write failures without publishing a partial file or raw error", async () => {
  const root = await mkdtemp(join(tmpdir(), "received-image-write-failure-"));
  try {
    const store = new ReceivedImageStore({
      root,
      writeStreamFactory: () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error("private filesystem path and write error"));
          },
        }),
    });
    const receiver = new ImageReceiver({ store, download: async () => imageStream() });
    const events = [];
    await receiver.receive(
      {
        type: "notify",
        messages: [
          {
            key: { id: "write-failure-image", remoteJid: "contact@s.whatsapp.net", fromMe: false },
            message: { imageMessage: { mimetype: "image/jpeg" } },
            pushName: "Contact",
          },
        ],
      },
      ["owner@s.whatsapp.net"],
      (event) => events.push(event),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "image", unavailable: true });
    expect(JSON.stringify(events)).not.toContain("private filesystem path");
    const folders = await readdir(root);
    expect(folders).toHaveLength(1);
    expect(await readdir(join(root, folders[0]))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("logout and process shutdown clear transient image events but retain saved files", async () => {
  const root = await mkdtemp(join(tmpdir(), "received-image-retention-"));
  let callbacks;
  let latestReceive;
  try {
    const store = new ReceivedImageStore({ root });
    const receiver = new ImageReceiver({ store, download: async () => imageStream() });
    const imageReceiver = {
      receive(...args) {
        latestReceive = receiver.receive(...args);
        return latestReceive;
      },
    };
    const manager = new SessionController({
      createSession: async (handlers) => {
        callbacks = handlers;
        return {
          logout: async () => handlers.onClose({ loggedOut: true }),
          end: async () => handlers.onClose({ loggedOut: false }),
        };
      },
      imageReceiver,
    });
    const emitImage = async (id) => {
      callbacks.onUpsert(
        {
          type: "notify",
          messages: [
            {
              key: { id, remoteJid: "contact@s.whatsapp.net", fromMe: false },
              message: { imageMessage: { mimetype: "image/jpeg" } },
              messageTimestamp: 1_800_000_000,
              pushName: "Contact",
            },
          ],
        },
        ["owner@s.whatsapp.net"],
      );
      await latestReceive;
    };

    await manager.start();
    callbacks.onOpen();
    await emitImage("logout-retained-image");
    expect(manager.getSnapshot().messages).toHaveLength(1);
    const beforeLogout = manager.getSnapshot().messages[0].previewUrl;
    const logoutMediaId = beforeLogout.split("/").at(-1);

    await manager.logout();
    expect(manager.getSnapshot().messages).toEqual([]);
    const foldersAfterLogout = await readdir(root);
    expect(foldersAfterLogout).toHaveLength(1);
    const filesAfterLogout = await readdir(join(root, foldersAfterLogout[0]));
    expect(filesAfterLogout).toHaveLength(2);

    await manager.start();
    callbacks.onOpen();
    await emitImage("shutdown-retained-image");
    const beforeShutdown = manager.getSnapshot().messages[0].previewUrl;
    const shutdownMediaId = beforeShutdown.split("/").at(-1);
    await manager.stopForProcessExit();
    expect(manager.getSnapshot().messages).toEqual([]);
    expect((await readdir(join(root, foldersAfterLogout[0]))).length).toBe(4);

    const afterRestart = new ReceivedImageStore({ root });
    expect(await afterRestart.openMedia(logoutMediaId)).toBeUndefined();
    expect(await afterRestart.openMedia(shutdownMediaId)).toBeUndefined();
    expect((await readdir(join(root, foldersAfterLogout[0]))).length).toBe(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("album visibility defaults to visible, includes empty approvals, and isolates linked accounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "album-visibility-defaults-"));
  try {
    const store = new ReceivedImageStore({ root });
    const firstApproval = {
      accountJid: "owner@s.whatsapp.net",
      chatJid: "same-contact@s.whatsapp.net",
      displayName: "Same Contact",
    };
    const secondApproval = {
      ...firstApproval,
      accountJid: "another-owner@s.whatsapp.net",
    };
    const first = await store.approveConversation(firstApproval);
    const second = await store.approveConversation(secondApproval);
    await store.save({
      ...firstApproval,
      messageId: "one-retained-image",
      timestamp: "2026-11-12T12:00:00.000Z",
      mimeType: "image/png",
      stream: imageStream(),
    });

    expect(await store.getAlbumVisibility()).toEqual({
      revision: 0,
      hiddenConversationIds: [],
    });
    const conversations = await store.listApprovedConversations();
    expect(conversations).toHaveLength(2);
    expect(
      conversations.find(({ conversationId }) => conversationId === first.conversationId),
    ).toMatchObject({
      imageCount: 1,
    });
    expect(
      conversations.find(({ conversationId }) => conversationId === second.conversationId),
    ).toMatchObject({
      imageCount: 0,
    });
    expect(conversations.every(({ label }) => label.startsWith("Same Contact · "))).toBe(true);
    expect(JSON.stringify(conversations)).not.toContain(root);
    expect(JSON.stringify(conversations)).not.toContain(firstApproval.accountJid);
    expect(JSON.stringify(conversations)).not.toContain(firstApproval.chatJid);
    expect(second.conversationId).not.toBe(first.conversationId);

    await store.saveAlbumVisibility({
      revision: 0,
      hiddenConversationIds: [first.conversationId],
    });
    const restartedStore = new ReceivedImageStore({ root });
    expect(await restartedStore.getAlbumVisibility()).toEqual({
      revision: 1,
      hiddenConversationIds: [first.conversationId],
    });
    expect(await restartedStore.listApprovedConversations()).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("album visibility rejects stale revisions and unknown approved-conversation IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "album-visibility-revisions-"));
  try {
    const store = new ReceivedImageStore({ root });
    const first = await store.approveConversation({
      accountJid: "owner@s.whatsapp.net",
      chatJid: "first-contact@s.whatsapp.net",
      displayName: "First Contact",
    });
    const second = await store.approveConversation({
      accountJid: "owner@s.whatsapp.net",
      chatJid: "second-contact@s.whatsapp.net",
      displayName: "Second Contact",
    });

    await store.saveAlbumVisibility({
      revision: 0,
      hiddenConversationIds: [first.conversationId],
    });
    await expect(
      store.saveAlbumVisibility({
        revision: 0,
        hiddenConversationIds: [second.conversationId],
      }),
    ).rejects.toBeInstanceOf(AlbumVisibilityConflictError);
    await expect(
      store.saveAlbumVisibility({
        revision: 1,
        hiddenConversationIds: ["f".repeat(64)],
      }),
    ).rejects.toBeInstanceOf(AlbumVisibilityValidationError);
    expect(await store.getAlbumVisibility()).toEqual({
      revision: 1,
      hiddenConversationIds: [first.conversationId],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("album visibility preserves the prior file on failed atomic writes and fails closed on corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "album-visibility-atomic-"));
  try {
    const store = new ReceivedImageStore({ root });
    const approval = await store.approveConversation({
      accountJid: "owner@s.whatsapp.net",
      chatJid: "contact@s.whatsapp.net",
      displayName: "Contact",
    });
    await store.saveAlbumVisibility({ revision: 0, hiddenConversationIds: [] });
    const configurationPath = join(root, "album-visibility.json");
    const originalContents = await readFile(configurationPath, "utf8");
    expect((await stat(configurationPath)).mode & 0o777).toBe(0o600);

    const failedWriter = new ReceivedImageStore({
      root,
      renameMetadataFile: async () => {
        throw new Error("synthetic visibility rename failure");
      },
    });
    await expect(
      failedWriter.saveAlbumVisibility({
        revision: 1,
        hiddenConversationIds: [approval.conversationId],
      }),
    ).rejects.toBeInstanceOf(AlbumVisibilityUnavailableError);
    expect(await readFile(configurationPath, "utf8")).toBe(originalContents);
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);

    await writeFile(configurationPath, "{malformed", { mode: 0o600 });
    await expect(store.getAlbumVisibility()).rejects.toBeInstanceOf(
      AlbumVisibilityUnavailableError,
    );
    await expect(
      store.saveAlbumVisibility({
        revision: 1,
        hiddenConversationIds: [approval.conversationId],
      }),
    ).rejects.toBeInstanceOf(AlbumVisibilityUnavailableError);
    expect(await readFile(configurationPath, "utf8")).toBe("{malformed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
