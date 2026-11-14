import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, mock, test } from "bun:test";
import { processUpsert } from "@/src/messages.js";
import {
  AlbumVisibilityConflictError,
  AlbumVisibilityUnavailableError,
  ReceivedImageStore,
} from "@/src/received-image-store.js";

const accountJid = "owner@s.whatsapp.net";
const chatJid = "contact@s.whatsapp.net";
const optIn = {
  type: "notify",
  messages: [
    {
      key: { remoteJid: chatJid, fromMe: false },
      message: { conversation: "inicia album" },
      pushName: "Contact",
    },
  ],
};

test("approval is committed before a failed confirmation and suppresses sends after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "album-command-restart-"));
  try {
    const store = new ReceivedImageStore({ root });
    const send = mock(async (jid, content) => {
      const folder = await store.ensureConversationFolder({
        accountJid,
        chatJid,
        displayName: "Contact",
      });
      expect(jid).toBe(chatJid);
      expect(content.text).toBe("Hemos iniciado, ya estoy disponible!");
      expect(await store.readAlbumApproval(folder)).toMatchObject({
        conversationId: store.getConversationIdentity(accountJid, chatJid).conversationId,
      });
      throw new Error("synthetic confirmation failure");
    });

    await expect(
      processUpsert(optIn, send, { accountJids: [accountJid], albumService: store }),
    ).rejects.toThrow("synthetic confirmation failure");

    const restartedStore = new ReceivedImageStore({ root });
    const retrySend = mock(async () => {});
    await processUpsert(optIn, retrySend, {
      accountJids: [accountJid],
      albumService: restartedStore,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(retrySend).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent duplicate opt-ins reserve and send only one confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "album-command-concurrent-"));
  try {
    const store = new ReceivedImageStore({ root });
    const send = mock(async () => {});
    const onAlbumApproved = mock(() => {});
    const options = {
      accountJids: [accountJid],
      albumService: store,
      onAlbumApproved,
    };

    await Promise.all([processUpsert(optIn, send, options), processUpsert(optIn, send, options)]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(onAlbumApproved).toHaveBeenCalledTimes(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a hidden conversation is durably reactivated and confirmed once per reactivation", async () => {
  const root = await mkdtemp(join(tmpdir(), "album-command-reactivation-"));
  try {
    const store = new ReceivedImageStore({ root });
    const approval = await store.approveConversation({
      accountJid,
      chatJid,
      displayName: "Contact",
    });
    const other = await store.approveConversation({
      accountJid: "another-owner@s.whatsapp.net",
      chatJid,
      displayName: "Contact",
    });
    const folder = await store.ensureConversationFolder({ accountJid, chatJid });
    const originalApproval = await readFile(join(folder, "album.json"), "utf8");
    await store.saveAlbumVisibility({
      revision: 0,
      hiddenConversationIds: [approval.conversationId, other.conversationId],
    });

    const restartedStore = new ReceivedImageStore({ root });
    const onAlbumApproved = mock(() => {});
    const send = mock(async (jid, content) => {
      expect(jid).toBe(chatJid);
      expect(content).toEqual({ text: "Hemos iniciado, ya estoy disponible!" });
      expect(await new ReceivedImageStore({ root }).getAlbumVisibility()).toEqual({
        revision: 2,
        hiddenConversationIds: [other.conversationId],
      });
      expect(onAlbumApproved).toHaveBeenCalledTimes(1);
    });
    const options = {
      accountJids: [accountJid],
      albumService: restartedStore,
      onAlbumApproved,
    };
    await Promise.all([processUpsert(optIn, send, options), processUpsert(optIn, send, options)]);
    await processUpsert(optIn, send, options);

    expect(send).toHaveBeenCalledTimes(1);
    expect(onAlbumApproved).toHaveBeenCalledTimes(1);
    expect(onAlbumApproved).toHaveBeenCalledWith({
      approved: true,
      conversationId: approval.conversationId,
      newlyApproved: false,
      reactivated: true,
      shouldConfirm: true,
    });
    expect(await readFile(join(folder, "album.json"), "utf8")).toBe(originalApproval);
    await expect(
      restartedStore.saveAlbumVisibility({
        revision: 1,
        hiddenConversationIds: [approval.conversationId, other.conversationId],
      }),
    ).rejects.toBeInstanceOf(AlbumVisibilityConflictError);

    await restartedStore.saveAlbumVisibility({
      revision: 2,
      hiddenConversationIds: [approval.conversationId, other.conversationId],
    });
    const secondSend = mock(async () => {});
    await processUpsert(optIn, secondSend, options);
    await processUpsert(optIn, secondSend, options);
    expect(secondSend).toHaveBeenCalledTimes(1);
    expect(onAlbumApproved).toHaveBeenCalledTimes(2);
    expect(await restartedStore.getAlbumVisibility()).toEqual({
      revision: 4,
      hiddenConversationIds: [other.conversationId],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed reactivation confirmations leave visibility restored without retry after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "album-reactivation-send-failure-"));
  try {
    const store = new ReceivedImageStore({ root });
    const approval = await store.approveConversation({ accountJid, chatJid });
    await store.saveAlbumVisibility({
      revision: 0,
      hiddenConversationIds: [approval.conversationId],
    });
    const send = mock(async () => {
      expect(await store.getAlbumVisibility()).toEqual({
        revision: 2,
        hiddenConversationIds: [],
      });
      throw new Error("synthetic reactivation confirmation failure");
    });
    await expect(
      processUpsert(optIn, send, { accountJids: [accountJid], albumService: store }),
    ).rejects.toThrow("synthetic reactivation confirmation failure");

    const retrySend = mock(async () => {});
    await processUpsert(optIn, retrySend, {
      accountJids: [accountJid],
      albumService: new ReceivedImageStore({ root }),
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(retrySend).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed visibility writes and corrupt configuration do not confirm reactivation", async () => {
  const root = await mkdtemp(join(tmpdir(), "album-reactivation-write-failure-"));
  try {
    const store = new ReceivedImageStore({ root });
    const approval = await store.approveConversation({ accountJid, chatJid });
    await store.saveAlbumVisibility({
      revision: 0,
      hiddenConversationIds: [approval.conversationId],
    });
    const configurationPath = join(root, "album-visibility.json");
    const originalVisibility = await readFile(configurationPath, "utf8");
    const failedStore = new ReceivedImageStore({
      root,
      renameMetadataFile: async () => {
        throw new Error("synthetic visibility write failure");
      },
    });
    const send = mock(async () => {});
    const onAlbumApproved = mock(() => {});
    const options = { accountJids: [accountJid], albumService: failedStore, onAlbumApproved };
    await expect(processUpsert(optIn, send, options)).rejects.toBeInstanceOf(
      AlbumVisibilityUnavailableError,
    );
    expect(await readFile(configurationPath, "utf8")).toBe(originalVisibility);
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(onAlbumApproved).not.toHaveBeenCalled();

    await writeFile(configurationPath, "{malformed", { mode: 0o600 });
    await expect(processUpsert(optIn, send, options)).rejects.toBeInstanceOf(
      AlbumVisibilityUnavailableError,
    );
    expect(await readFile(configurationPath, "utf8")).toBe("{malformed");
    expect(send).not.toHaveBeenCalled();
    expect(onAlbumApproved).not.toHaveBeenCalled();

    await writeFile(configurationPath, originalVisibility, { mode: 0o600 });
    await processUpsert(optIn, send, { ...options, albumService: store });
    expect(send).toHaveBeenCalledTimes(1);
    expect(onAlbumApproved).toHaveBeenCalledTimes(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
