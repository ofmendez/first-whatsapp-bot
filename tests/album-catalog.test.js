import { mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { expect, test } from "bun:test";
import { AlbumImageCatalog, AlbumPaginationError } from "@/src/album-catalog.js";
import { ReceivedImageStore } from "@/src/received-image-store.js";

const accountJid = "owner@s.whatsapp.net";
const firstChat = "friend@s.whatsapp.net";
const secondChat = "another-friend@s.whatsapp.net";
const pngHeader = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

async function saveImage(store, chatJid, messageId, options = {}) {
  return store.save({
    accountJid: options.accountJid ?? accountJid,
    chatJid,
    displayName: options.displayName ?? chatJid,
    messageId,
    timestamp: options.timestamp ?? "2026-11-12T12:00:00.000Z",
    mimeType: options.mimeType ?? "image/png",
    ...(options.caption ? { caption: options.caption } : {}),
    stream: Readable.from([Buffer.isBuffer(options.bytes) ? options.bytes : pngHeader]),
  });
}

async function makeFixture(prefix = "album-catalog-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const store = new ReceivedImageStore({ root });
  const catalog = new AlbumImageCatalog({ store });
  return { root, store, catalog };
}

test("catalog lists only supported images from explicitly approved folders", async () => {
  const { root, store, catalog } = await makeFixture();
  try {
    const approved = await saveImage(store, firstChat, "approved-image");
    await saveImage(store, secondChat, "unapproved-image");
    await store.approveConversation({
      accountJid,
      chatJid: firstChat,
      displayName: "First contact",
    });

    const page = await catalog.listPage();

    expect(page.items).toEqual([
      {
        id: approved.imageId,
        mediaUrl: `/api/album/media/${approved.imageId}`,
        date: "2026-11-12T12:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(page)).not.toContain(root);
    expect(JSON.stringify(page)).not.toContain(accountJid);
    expect(JSON.stringify(page)).not.toContain(firstChat);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog updates after approval and image-save notifications", async () => {
  const { root, store, catalog } = await makeFixture();
  try {
    const pending = await saveImage(store, firstChat, "pending-before-approval");
    expect(await catalog.notifyChanged()).toBe(0);

    await store.approveConversation({
      accountJid,
      chatJid: firstChat,
      displayName: "First contact",
    });
    expect(await catalog.notifyChanged()).toBe(1);
    expect((await catalog.listPage()).items.map(({ id }) => id)).toEqual([pending.imageId]);

    const next = await saveImage(store, firstChat, "image-after-approval", {
      timestamp: "2026-11-13T12:00:00.000Z",
    });
    expect(await catalog.notifyChanged()).toBe(2);
    expect((await catalog.listPage()).items.map(({ id }) => id)).toEqual([
      next.imageId,
      pending.imageId,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog exposes only valid persisted approval identities to the protected activity layer", async () => {
  const { root, store, catalog } = await makeFixture("album-catalog-approval-cache-");
  try {
    const approved = store.getConversationIdentity(accountJid, firstChat).conversationId;
    const unapproved = store.getConversationIdentity(accountJid, secondChat).conversationId;
    expect(catalog.isConversationApproved(approved)).toBe(false);
    await store.approveConversation({ accountJid, chatJid: firstChat, displayName: "Contact" });
    await catalog.refresh();
    expect(catalog.isConversationApproved(approved)).toBe(true);
    expect(catalog.isConversationApproved(unapproved)).toBe(false);
    expect(catalog.markConversationApproved("not-an-opaque-conversation-id")).toBe(false);

    const folder = await store.ensureConversationFolder({
      accountJid,
      chatJid: firstChat,
      displayName: "Contact",
    });
    const markerPath = join(folder, "album.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    await writeFile(markerPath, JSON.stringify({ ...marker, albumed: false }), { mode: 0o600 });
    await catalog.refresh();
    expect(catalog.isConversationApproved(approved)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog recovers legacy dates and IDs, and fresh first pages reload caption edits", async () => {
  const { root, store, catalog } = await makeFixture();
  try {
    await store.approveConversation({
      accountJid,
      chatJid: firstChat,
      displayName: "First contact",
    });
    const saved = await saveImage(store, firstChat, "legacy-image", {
      timestamp: "2026-11-12T12:34:56.000Z",
    });
    const legacyId = basename(saved.path);
    await rm(`${saved.path}.json`);
    await utimes(
      saved.path,
      new Date("2001-01-01T00:00:00.000Z"),
      new Date("2001-01-01T00:00:00.000Z"),
    );

    const recovered = await catalog.listPage();
    const recoveredItem = recovered.items[0];
    expect(recoveredItem.date).toBe("2026-11-12T12:34:56.000Z");
    expect(recoveredItem.caption).toBeUndefined();
    expect(recoveredItem.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(recoveredItem.id).not.toBe(legacyId);
    expect(JSON.parse(await readFile(`${saved.path}.json`, "utf8")).timestamp).toBe(
      "2026-11-12T12:34:56.000Z",
    );

    const sidecar = JSON.parse(await readFile(`${saved.path}.json`, "utf8"));
    await writeFile(
      `${saved.path}.json`,
      JSON.stringify({ ...sidecar, captionOverride: "corrección del dueño" }),
      { mode: 0o600 },
    );
    expect((await catalog.listPage()).items[0].caption).toBe("corrección del dueño");

    await writeFile(`${saved.path}.json`, JSON.stringify({ ...sidecar, captionOverride: "" }), {
      mode: 0o600,
    });
    expect((await catalog.listPage()).items[0].caption).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog rejects unsupported bytes, temporary files, corrupt sidecars, and symlinks", async () => {
  const { root, store, catalog } = await makeFixture();
  try {
    await store.approveConversation({
      accountJid,
      chatJid: firstChat,
      displayName: "First contact",
    });
    const valid = await saveImage(store, firstChat, "valid-image");
    const unsupported = await saveImage(store, firstChat, "html-disguised-as-image", {
      bytes: Buffer.from("<html>private synthetic data</html>"),
    });
    const corrupt = await saveImage(store, firstChat, "corrupt-sidecar");
    await writeFile(`${corrupt.path}.json`, "{invalid", { mode: 0o600 });
    const directory = dirname(valid.path);
    const temporaryName = ".image-1800000000-aabbccddeeff00112233.png.tmp";
    await writeFile(join(directory, temporaryName), pngHeader);
    const symlinkName = "image-1800000000-bbccddeeff0011223344.png";
    await symlink(valid.path, join(directory, symlinkName));
    const invalidDateName = "image-0-ccddeeff001122334455.png";
    await writeFile(join(directory, invalidDateName), pngHeader);
    const corruptContents = await readFile(`${corrupt.path}.json`, "utf8");

    const page = await catalog.listPage();

    expect(page.items.map(({ id }) => id)).toEqual([valid.imageId]);
    expect(await readFile(`${corrupt.path}.json`, "utf8")).toBe(corruptContents);
    expect(await readdir(directory)).toContain(temporaryName);
    expect(
      (await store.inspectImageMetadata(directory, "../image-1800000000-aabbccddeeff00112233.png"))
        .status,
    ).toBe("invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog excludes conflicting persistent identities instead of choosing one file", async () => {
  const { root, store, catalog } = await makeFixture();
  try {
    await store.approveConversation({
      accountJid,
      chatJid: firstChat,
      displayName: "First contact",
    });
    const first = await saveImage(store, firstChat, "first-conflict");
    const second = await saveImage(store, firstChat, "second-conflict");
    const secondSidecar = JSON.parse(await readFile(`${second.path}.json`, "utf8"));
    await writeFile(
      `${second.path}.json`,
      JSON.stringify({ ...secondSidecar, id: first.imageId }),
      { mode: 0o600 },
    );

    expect((await catalog.listPage()).items).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keyset pagination returns 100-plus equal-date images once, with bounded limits", async () => {
  const { root, store, catalog } = await makeFixture("album-catalog-many-");
  try {
    await store.approveConversation({
      accountJid,
      chatJid: firstChat,
      displayName: "First contact",
    });
    const saved = await Promise.all(
      Array.from({ length: 103 }, (_, index) =>
        saveImage(store, firstChat, `equal-date-${index}`, {
          timestamp: "2026-11-12T12:00:00.000Z",
        }),
      ),
    );
    const seen = [];
    let page = await catalog.listPage();
    expect(page.items).toHaveLength(24);
    while (true) {
      seen.push(...page.items.map(({ id }) => id));
      if (page.nextCursor === null) break;
      page = await catalog.listPage({ cursor: page.nextCursor });
    }

    const capped = await catalog.listPage({ limit: "100" });
    expect(capped.items).toHaveLength(60);
    expect(new Set(seen).size).toBe(103);
    expect(seen).toHaveLength(103);
    expect(new Set(saved.map(({ imageId }) => imageId))).toEqual(new Set(seen));
    expect(capped.nextCursor).not.toBeNull();
    const decodedCursor = JSON.parse(Buffer.from(capped.nextCursor, "base64url").toString("utf8"));
    expect(Object.keys(decodedCursor).sort()).toEqual(["id", "timestamp", "v"]);
    expect(JSON.stringify(decodedCursor)).not.toContain(root);
    expect(JSON.stringify(decodedCursor)).not.toContain(firstChat);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pagination rejects malformed limits and bounded/versioned cursors", async () => {
  const { root, catalog } = await makeFixture();
  try {
    for (const limit of ["", "0", "-1", "1.5", "nope", "9007199254740992"]) {
      await expect(catalog.listPage({ limit })).rejects.toBeInstanceOf(AlbumPaginationError);
    }
    for (const cursor of ["../private", "%%%bad", "a".repeat(513)]) {
      await expect(catalog.listPage({ cursor })).rejects.toBeInstanceOf(AlbumPaginationError);
    }
    const malformedPayload = Buffer.from(
      JSON.stringify({ v: 9, timestamp: "2026-11-12T12:00:00.000Z", id: "not-an-id" }),
    ).toString("base64url");
    await expect(catalog.listPage({ cursor: malformedPayload })).rejects.toBeInstanceOf(
      AlbumPaginationError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cursor traversal skips deleted or unapproved records and sees new images on a fresh load", async () => {
  const { root, store, catalog } = await makeFixture("album-catalog-traversal-");
  try {
    await store.approveConversation({
      accountJid,
      chatJid: firstChat,
      displayName: "First contact",
    });
    await store.approveConversation({
      accountJid,
      chatJid: secondChat,
      displayName: "Second contact",
    });
    const existing = await Promise.all([
      ...Array.from({ length: 4 }, (_, index) =>
        saveImage(store, firstChat, `first-chat-${index}`, {
          timestamp: `2026-11-12T12:00:0${index}.000Z`,
        }),
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        saveImage(store, secondChat, `second-chat-${index}`, {
          timestamp: `2026-11-12T12:00:0${index}.000Z`,
        }),
      ),
    ]);
    const firstPage = await catalog.listPage({ limit: 3 });
    expect(firstPage.nextCursor).not.toBeNull();

    const latest = await saveImage(store, firstChat, "inserted-newest", {
      timestamp: "2026-11-13T12:00:00.000Z",
    });
    const oldRecordToDelete = existing.find(({ imageId }) =>
      firstPage.items.every((item) => item.id !== imageId),
    );
    await rm(oldRecordToDelete.path);

    const secondFolder = await store.ensureConversationFolder({
      accountJid,
      chatJid: secondChat,
      displayName: "Second contact",
    });
    const approvalPath = join(secondFolder, "album.json");
    const approval = JSON.parse(await readFile(approvalPath, "utf8"));
    await writeFile(approvalPath, JSON.stringify({ ...approval, albumed: false }), {
      mode: 0o600,
    });

    const traversed = [...firstPage.items];
    const continuation = [];
    let page = await catalog.listPage({ limit: 3, cursor: firstPage.nextCursor });
    while (true) {
      traversed.push(...page.items);
      continuation.push(...page.items);
      if (page.nextCursor === null) break;
      page = await catalog.listPage({ limit: 3, cursor: page.nextCursor });
    }
    expect(traversed.map(({ id }) => id)).not.toContain(latest.imageId);
    expect(traversed.every(({ id }) => id !== oldRecordToDelete.imageId)).toBe(true);
    expect(
      continuation.every(({ id }) => existing.slice(4).every(({ imageId }) => imageId !== id)),
    ).toBe(true);

    const fresh = await catalog.listPage({ limit: 24 });
    expect(fresh.items[0].id).toBe(latest.imageId);
    expect(fresh.items.some(({ id }) => id === oldRecordToDelete.imageId)).toBe(false);
    const firstChatSurvivor = existing
      .slice(0, 4)
      .find(({ imageId }) => imageId !== oldRecordToDelete.imageId);
    expect(fresh.items.some(({ id }) => id === firstChatSurvivor.imageId)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("visibility filters pages and direct media, then restores retained images when re-enabled", async () => {
  const { root, store, catalog } = await makeFixture("album-catalog-visibility-");
  try {
    await store.approveConversation({
      accountJid,
      chatJid: firstChat,
      displayName: "First contact",
    });
    await store.approveConversation({
      accountJid,
      chatJid: secondChat,
      displayName: "Second contact",
    });
    const hiddenImage = await saveImage(store, firstChat, "hidden-conversation-image", {
      timestamp: "2026-11-12T12:00:00.000Z",
    });
    const visibleImage = await saveImage(store, secondChat, "visible-conversation-image", {
      timestamp: "2026-11-13T12:00:00.000Z",
    });

    const visiblePage = await catalog.listPage();
    expect(visiblePage.items.map(({ id }) => id)).toEqual([
      visibleImage.imageId,
      hiddenImage.imageId,
    ]);
    expect(await catalog.openMedia(hiddenImage.imageId)).toMatchObject({
      contentType: "image/png",
    });

    await store.saveAlbumVisibility({
      revision: 0,
      hiddenConversationIds: [store.getConversationIdentity(accountJid, firstChat).conversationId],
    });
    const hiddenPage = await catalog.listPage();
    expect(hiddenPage.items.map(({ id }) => id)).toEqual([visibleImage.imageId]);
    expect(await catalog.openMedia(hiddenImage.imageId)).toBeUndefined();

    await store.saveAlbumVisibility({ revision: 1, hiddenConversationIds: [] });
    const restoredPage = await catalog.listPage();
    expect(restoredPage.items.map(({ id }) => id)).toEqual([
      visibleImage.imageId,
      hiddenImage.imageId,
    ]);
    expect(await catalog.openMedia(hiddenImage.imageId)).toMatchObject({
      contentType: "image/png",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cursor traversal skips conversations hidden between pages and fills visible results", async () => {
  const { root, store, catalog } = await makeFixture("album-catalog-visibility-cursor-");
  try {
    await store.approveConversation({
      accountJid,
      chatJid: firstChat,
      displayName: "First contact",
    });
    await store.approveConversation({
      accountJid,
      chatJid: secondChat,
      displayName: "Second contact",
    });
    const hiddenImages = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        saveImage(store, firstChat, `cursor-hidden-${index}`, {
          timestamp: `2026-11-12T12:00:0${index + 4}.000Z`,
        }),
      ),
    );
    const visibleImages = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        saveImage(store, secondChat, `cursor-visible-${index}`, {
          timestamp: `2026-11-12T12:00:0${index}.000Z`,
        }),
      ),
    );

    const firstPage = await catalog.listPage({ limit: 2 });
    expect(firstPage.items.map(({ id }) => id)).toEqual(
      hiddenImages
        .slice(-2)
        .map(({ imageId }) => imageId)
        .reverse(),
    );
    expect(firstPage.nextCursor).not.toBeNull();

    await store.saveAlbumVisibility({
      revision: 0,
      hiddenConversationIds: [store.getConversationIdentity(accountJid, firstChat).conversationId],
    });
    const traversed = [...firstPage.items];
    let page = await catalog.listPage({ limit: 2, cursor: firstPage.nextCursor });
    while (true) {
      traversed.push(...page.items);
      if (page.nextCursor === null) break;
      page = await catalog.listPage({ limit: 2, cursor: page.nextCursor });
    }

    expect(traversed).toHaveLength(6);
    expect(new Set(traversed.map(({ id }) => id))).toEqual(
      new Set([
        ...hiddenImages.slice(-2).map(({ imageId }) => imageId),
        ...visibleImages.map(({ imageId }) => imageId),
      ]),
    );
    expect(
      traversed.slice(2).every(({ id }) => visibleImages.some((image) => image.imageId === id)),
    ).toBe(true);

    await store.saveAlbumVisibility({ revision: 1, hiddenConversationIds: [] });
    expect((await catalog.listPage()).items).toHaveLength(8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed album visibility fails closed for listings and direct media", async () => {
  const { root, store, catalog } = await makeFixture("album-catalog-visibility-invalid-");
  try {
    await store.approveConversation({
      accountJid,
      chatJid: firstChat,
      displayName: "First contact",
    });
    const saved = await saveImage(store, firstChat, "invalid-visibility-image");
    await writeFile(join(root, "album-visibility.json"), "{malformed", { mode: 0o600 });

    await expect(catalog.listPage()).rejects.toThrow("Album visibility is unavailable.");
    await expect(catalog.openMedia(saved.imageId)).rejects.toThrow(
      "Album visibility is unavailable.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
