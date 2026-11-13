import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { expect, mock, test } from "bun:test";
import { ImageReceiver } from "@/src/image-receiver.js";
import { ReceivedImageStore } from "@/src/received-image-store.js";
import { SessionController } from "@/src/session-controller.js";

const imageStream = (value = "synthetic image bytes") => Readable.from([Buffer.from(value)]);

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
      expect(entries.length).toBe(folder.name === basename(dirname(first.path)) ? 3 : 1);
      for (const entry of entries) {
        expect(entry.isFile()).toBe(true);
        expect(entry.name).toMatch(/^image-\d+-[a-f0-9]{20}\.(?:jpg|png|webp)$/);
        expect(entry.name).not.toContain("incoming-image");
        expect((await stat(join(root, folder.name, entry.name))).isFile()).toBe(true);
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
  const receiver = new ImageReceiver({ store: { save }, download });
  const events = [];
  const upsert = { type: "notify", messages: [message] };

  await receiver.receive(upsert, ["owner@s.whatsapp.net"], (event) => events.push(event));
  await receiver.receive(upsert, ["owner@s.whatsapp.net"], (event) => events.push(event));

  expect(download).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][0]).toMatchObject({
    accountJid: "owner@s.whatsapp.net",
    chatJid: "contact@s.whatsapp.net",
    displayName: "Contact",
    mimeType: "image/png",
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
    expect(filesAfterLogout).toHaveLength(1);

    await manager.start();
    callbacks.onOpen();
    await emitImage("shutdown-retained-image");
    const beforeShutdown = manager.getSnapshot().messages[0].previewUrl;
    const shutdownMediaId = beforeShutdown.split("/").at(-1);
    await manager.stopForProcessExit();
    expect(manager.getSnapshot().messages).toEqual([]);
    expect((await readdir(join(root, foldersAfterLogout[0]))).length).toBe(2);

    const afterRestart = new ReceivedImageStore({ root });
    expect(await afterRestart.openMedia(logoutMediaId)).toBeUndefined();
    expect(await afterRestart.openMedia(shutdownMediaId)).toBeUndefined();
    expect((await readdir(join(root, foldersAfterLogout[0]))).length).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
