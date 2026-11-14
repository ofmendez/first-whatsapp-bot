import { createHash } from "node:crypto";
import { expect, mock, test } from "bun:test";
import {
  MessageFeed,
  normalizeJid,
  projectLiveImages,
  projectLiveMessages,
} from "@/src/message-feed.js";
import { SessionController } from "@/src/session-controller.js";

const textMessage = (
  remoteJid,
  text,
  { fromMe = false, type = "conversation", pushName } = {},
) => ({
  key: { remoteJid, fromMe },
  message: type === "conversation" ? { conversation: text } : { extendedTextMessage: { text } },
  messageTimestamp: 1_800_000_000,
  ...(pushName ? { pushName } : {}),
});

function setup({
  session = {},
  clearAuth,
  imageReceiver,
  messageLimit,
  selfChatValidation,
  albumService,
  albumCatalog,
  onAlbumApproved,
} = {}) {
  let callbacks;
  const factory = mock(async (handlers) => {
    callbacks = handlers;
    return {
      logout: mock(async () => callbacks.onClose({ loggedOut: true })),
      end: mock(async () => callbacks.onClose({ loggedOut: false })),
      sendSelf: mock(async () => {}),
      ...session,
    };
  });
  const manager = new SessionController({
    createSession: factory,
    clearAuth,
    imageReceiver,
    messageLimit,
    selfChatValidation,
    albumService,
    albumCatalog,
    onAlbumApproved,
  });
  return {
    manager,
    factory,
    callbacks: () => callbacks,
  };
}

test("constructing the manager is stopped and does not create a WhatsApp socket", () => {
  const { manager, factory } = setup();
  expect(manager.getSnapshot().status).toBe("stopped");
  expect(factory).not.toHaveBeenCalled();
});

test("start creates one session and repeated start actions reuse the active state", async () => {
  const { manager, factory, callbacks } = setup();
  const first = manager.start();
  const second = manager.start();
  expect(factory).toHaveBeenCalledTimes(1);
  await Promise.all([first, second]);
  expect(manager.getSnapshot().status).toBe("starting");

  callbacks().onPairing("synthetic transient QR");
  expect(manager.getSnapshot()).toMatchObject({ status: "pairing", qr: "synthetic transient QR" });
  callbacks().onOpen();
  expect(manager.getSnapshot()).toMatchObject({ status: "connected", qr: null });
  await manager.start();
  expect(factory).toHaveBeenCalledTimes(1);
});

test("album approval wiring ignores updates from an obsolete session attempt", async () => {
  const albumService = { approveConversation: mock(async () => ({})) };
  const onAlbumApproved = mock(() => {});
  const { manager, factory } = setup({ albumService, onAlbumApproved });

  await manager.start();
  const previousAttempt = factory.mock.calls[0][0];
  expect(previousAttempt.albumService).toBe(albumService);
  previousAttempt.onOpen();
  previousAttempt.onAlbumApproved({ conversationId: "current-before-close" });
  expect(onAlbumApproved).toHaveBeenCalledTimes(1);

  previousAttempt.onClose({ loggedOut: false });
  await manager.start();
  const currentAttempt = factory.mock.calls[1][0];
  currentAttempt.onOpen();
  previousAttempt.onAlbumApproved({ conversationId: "stale-after-restart" });
  currentAttempt.onAlbumApproved({ conversationId: "current-after-restart" });

  expect(onAlbumApproved.mock.calls.map(([approval]) => approval.conversationId)).toEqual([
    "current-before-close",
    "current-after-restart",
  ]);
});

test("text and image events carry opaque account-scoped approval state and approval updates retained events", async () => {
  const accountJid = "owner@s.whatsapp.net";
  const firstChat = "same-name-contact@s.whatsapp.net";
  const secondChat = "another-same-name-contact@s.whatsapp.net";
  const conversationIdFor = (account, chat) =>
    createHash("sha256")
      .update(`synthetic-conversation\0${normalizeJid(account)}\0${normalizeJid(chat)}`)
      .digest("hex");
  const firstConversationId = conversationIdFor(accountJid, firstChat);
  const secondConversationId = conversationIdFor(accountJid, secondChat);
  const approved = new Set([secondConversationId]);
  const albumService = {
    getConversationIdentity: mock((account, chat) => ({
      conversationId: conversationIdFor(account, chat),
    })),
  };
  const albumCatalog = {
    isConversationApproved: mock((conversationId) => approved.has(conversationId)),
  };
  const imageReceiver = {
    receive: async (_upsert, selfJids, onImage) => {
      const conversationId = conversationIdFor(selfJids[0], firstChat);
      onImage({
        kind: "image",
        direction: "incoming",
        label: "Same Contact",
        timestamp: "2026-11-12T12:00:00.000Z",
        conversationId,
        albumed: approved.has(conversationId),
      });
    },
  };
  const onAlbumApproved = mock(() => {});
  const { manager, factory } = setup({
    albumService,
    albumCatalog,
    imageReceiver,
    onAlbumApproved,
  });
  const updates = [];
  manager.subscribe((update) => updates.push(update));
  await manager.start();
  const handlers = factory.mock.calls[0][0];
  handlers.onOpen();
  handlers.onUpsert(
    {
      type: "notify",
      messages: [
        textMessage(firstChat, "first private live text", { pushName: "Same Contact" }),
        textMessage(secondChat, "second private live text", { pushName: "Same Contact" }),
      ],
    },
    [accountJid],
  );

  const initial = manager.getSnapshot().messages;
  expect(initial).toHaveLength(3);
  expect(initial.map(({ conversationId, albumed }) => ({ conversationId, albumed }))).toEqual([
    { conversationId: firstConversationId, albumed: false },
    { conversationId: secondConversationId, albumed: true },
    { conversationId: firstConversationId, albumed: false },
  ]);
  expect(JSON.stringify(initial)).not.toContain(accountJid);
  expect(JSON.stringify(initial)).not.toContain(firstChat);
  expect(JSON.stringify(initial)).not.toContain(secondChat);
  expect(conversationIdFor("other-owner@s.whatsapp.net", firstChat)).not.toBe(firstConversationId);

  approved.add(firstConversationId);
  handlers.onAlbumApproved({ conversationId: firstConversationId });
  const reconciled = manager.getSnapshot();
  expect(
    reconciled.messages.map(({ conversationId, albumed }) => ({ conversationId, albumed })),
  ).toEqual([
    { conversationId: firstConversationId, albumed: true },
    { conversationId: secondConversationId, albumed: true },
    { conversationId: firstConversationId, albumed: true },
  ]);
  expect(onAlbumApproved).toHaveBeenCalledWith({ conversationId: firstConversationId });
  expect(updates.at(-1)).toMatchObject({
    type: "state",
    state: { messages: reconciled.messages },
  });

  handlers.onUpsert({ type: "notify", messages: [] }, [accountJid]);
  expect(manager.getSnapshot().messages.at(-1)).toMatchObject({
    kind: "image",
    conversationId: firstConversationId,
    albumed: true,
  });

  handlers.onClose({ loggedOut: true });
  expect(manager.getSnapshot().messages).toEqual([]);
});

test("cancel ends a pending socket, clears the QR, and returns to stopped", async () => {
  const { manager, callbacks } = setup();
  await manager.start();
  callbacks().onPairing("synthetic QR");

  const state = await manager.cancel();
  expect(state).toMatchObject({ status: "stopped", qr: null, messages: [] });
});

test("unexpected close clears QR and reports disconnection without reconnecting", async () => {
  const { manager, factory, callbacks } = setup();
  await manager.start();
  callbacks().onPairing("synthetic QR");
  callbacks().onClose({ loggedOut: false });

  expect(manager.getSnapshot()).toMatchObject({ status: "disconnected", qr: null });
  expect(factory).toHaveBeenCalledTimes(1);
});

test("live projection includes direct incoming/outgoing and self-chat text only", () => {
  const projected = projectLiveMessages(
    {
      type: "notify",
      messages: [
        textMessage("self:4@s.whatsapp.net", "phone authored self-chat", { fromMe: true }),
        textMessage("friend@s.whatsapp.net", "incoming", { pushName: "Friend" }),
        textMessage("other@s.whatsapp.net", "outgoing", { fromMe: true }),
        textMessage("group@g.us", "group text"),
        textMessage("status@broadcast", "status update"),
        textMessage("channel@newsletter", "channel update"),
        textMessage("friend@s.whatsapp.net", " "),
        { key: { remoteJid: "friend@s.whatsapp.net" }, message: { imageMessage: {} } },
      ],
    },
    ["self@s.whatsapp.net"],
  );

  expect(
    projected.map(({ direction, isSelfChat, label, text }) => ({
      direction,
      isSelfChat,
      label,
      text,
    })),
  ).toEqual([
    {
      direction: "outgoing",
      isSelfChat: true,
      label: "Message yourself",
      text: "phone authored self-chat",
    },
    { direction: "incoming", isSelfChat: false, label: "Friend", text: "incoming" },
    { direction: "outgoing", isSelfChat: false, label: "Direct chat", text: "outgoing" },
  ]);
  expect(projected.every((message) => !("remoteJid" in message))).toBe(true);
  expect(
    projectLiveMessages({
      type: "append",
      messages: [textMessage("friend@s.whatsapp.net", "history")],
    }),
  ).toEqual([]);
});

test("image projection includes incoming direct and linked-account self-chat images only", () => {
  const image = (remoteJid, { fromMe = false, content = "imageMessage", pushName } = {}) => ({
    key: { remoteJid, fromMe },
    message: {
      [content]:
        content === "imageMessage" ? { mimetype: "image/jpeg", caption: "synthetic caption" } : {},
    },
    messageTimestamp: 1_800_000_000,
    ...(pushName ? { pushName } : {}),
  });
  const upsert = {
    type: "notify",
    messages: [
      image("friend@s.whatsapp.net", { pushName: "Friend" }),
      image("self:4@s.whatsapp.net", { fromMe: true }),
      image("other@s.whatsapp.net", { fromMe: true }),
      image("group@g.us"),
      image("status@broadcast"),
      image("channel@newsletter"),
      image("friend@s.whatsapp.net", { content: "documentMessage" }),
      image("friend@s.whatsapp.net", { content: "videoMessage" }),
      image("friend@s.whatsapp.net", { content: "stickerMessage" }),
    ],
  };

  const projected = projectLiveImages(upsert, ["self@s.whatsapp.net"]);
  expect(
    projected.map(({ direction, isSelfChat, label, caption, remoteJid }) => ({
      direction,
      isSelfChat,
      label,
      caption,
      remoteJid,
    })),
  ).toEqual([
    {
      direction: "incoming",
      isSelfChat: false,
      label: "Friend",
      caption: "synthetic caption",
      remoteJid: "friend@s.whatsapp.net",
    },
    {
      direction: "outgoing",
      isSelfChat: true,
      label: "Message yourself",
      caption: "synthetic caption",
      remoteJid: "self@s.whatsapp.net",
    },
  ]);
  expect(projectLiveImages({ ...upsert, type: "append" }, ["self@s.whatsapp.net"])).toEqual([]);
});

test("feed is bounded and clear discards all transient content", () => {
  const feed = new MessageFeed(2);
  feed.append({ text: "private one" });
  feed.append({ text: "private two" });
  feed.append({ text: "private three" });
  expect(feed.snapshot().map((item) => item.text)).toEqual(["private two", "private three"]);
  feed.clear();
  expect(feed.snapshot()).toEqual([]);
});

test("approval marking only updates retained events without changing the 200-event eviction boundary", () => {
  const feed = new MessageFeed();
  const conversationId = "a".repeat(64);
  for (let sequence = 1; sequence <= 201; sequence += 1) {
    feed.append({
      conversationId,
      albumed: false,
      text: `synthetic event ${sequence}`,
    });
  }

  const updated = feed.markConversationAlbumed(conversationId);

  expect(feed.snapshot()).toHaveLength(200);
  expect(updated).toHaveLength(200);
  expect(feed.snapshot()[0]).toMatchObject({ sequence: 2, albumed: true });
  expect(feed.snapshot().at(-1)).toMatchObject({ sequence: 201, albumed: true });
  expect(feed.markConversationAlbumed("../not-an-identity")).toEqual([]);
});

test("successful logout ends the socket before auth cleanup and clears messages", async () => {
  const order = [];
  let callbacks;
  const { manager, factory } = setup({
    clearAuth: async () => {
      order.push("remove local auth");
    },
    session: {
      logout: mock(async () => {
        order.push("remote unlink");
        callbacks.onClose({ loggedOut: true });
        order.push("old socket ended");
      }),
    },
  });
  await manager.start();
  callbacks = managerCallbacks(factory);
  callbacks.onOpen();
  callbacks.onUpsert(
    {
      type: "notify",
      messages: [textMessage("self@s.whatsapp.net", "private live message", { fromMe: true })],
    },
    ["self@s.whatsapp.net"],
  );
  expect(manager.getSnapshot().messages).toHaveLength(1);

  const state = await manager.logout();
  expect(order).toEqual(["remote unlink", "old socket ended", "remove local auth"]);
  expect(state).toMatchObject({ status: "stopped", qr: null, messages: [] });
  expect(managerCallbacks(factory)).toBe(callbacks);
});

function managerCallbacks(factory) {
  const handlers = factory.mock.calls[0][0];
  // Capture the callback object passed into the session factory through the mock result.
  return handlers;
}

test("logout failure preserves local auth, enters operator review, and blocks another socket", async () => {
  const clearAuth = mock(async () => {});
  const sessionEnd = mock(async () => {});
  const rawError = new Error("private account and credential details");
  const { manager, factory, callbacks } = setup({
    clearAuth,
    session: {
      logout: mock(async () => {
        throw rawError;
      }),
      end: sessionEnd,
    },
  });
  await manager.start();
  callbacks().onOpen();

  await expect(manager.logout()).rejects.toThrow("could not be safely closed");
  expect(manager.getSnapshot()).toMatchObject({ status: "review-required" });
  expect(JSON.stringify(manager.getSnapshot())).not.toContain("private account");
  expect(sessionEnd).toHaveBeenCalledTimes(1);
  expect(clearAuth).not.toHaveBeenCalled();
  await manager.start();
  expect(factory).toHaveBeenCalledTimes(1);
});

test("auth cleanup failure also blocks another session for operator review", async () => {
  const clearAuth = mock(async () => {
    throw new Error("private disk path");
  });
  const { manager, factory, callbacks } = setup({ clearAuth });
  await manager.start();
  callbacks().onOpen();

  await expect(manager.logout()).rejects.toThrow("could not be safely closed");
  expect(manager.getSnapshot().status).toBe("review-required");
  await manager.start();
  expect(factory).toHaveBeenCalledTimes(1);
});

test("self-chat send rejects empty and concurrent requests and never retries failures", async () => {
  const gate = Promise.withResolvers();
  const sendSelf = mock(async () => gate.promise);
  const { manager, callbacks } = setup({ session: { sendSelf } });
  await manager.start();
  callbacks().onOpen();

  await expect(manager.sendSelf("   ")).rejects.toThrow("nonempty");
  const first = manager.sendSelf("synthetic self-chat");
  await expect(manager.sendSelf("synthetic self-chat")).rejects.toThrow("already in progress");
  expect(sendSelf).toHaveBeenCalledTimes(1);
  gate.resolve();
  await first;

  sendSelf.mockRejectedValueOnce(new Error("private send details"));
  await expect(manager.sendSelf("one attempt only")).rejects.toThrow("No retry was attempted");
  expect(sendSelf).toHaveBeenCalledTimes(2);
});

test("clearTransient removes messages and QR without writing diagnostics", async () => {
  const { manager, callbacks } = setup({ selfChatValidation: "passed" });
  const log = mock(() => {});
  const originalLog = console.log;
  console.log = log;
  try {
    await manager.start();
    callbacks().onPairing("private QR payload");
    callbacks().onOpen();
    callbacks().onUpsert(
      {
        type: "notify",
        messages: [textMessage("self@s.whatsapp.net", "private body", { fromMe: true })],
      },
      ["self@s.whatsapp.net"],
    );
    manager.clearTransient();

    expect(manager.getSnapshot()).toMatchObject({
      qr: null,
      messages: [],
      selfChatValidation: "passed",
    });
    expect(log).not.toHaveBeenCalled();
  } finally {
    console.log = originalLog;
  }
});

test("process shutdown clears the feed and ends the socket without logout or auth cleanup", async () => {
  const logout = mock(async () => {});
  const end = mock(async () => {});
  const clearAuth = mock(async () => {});
  const { manager, callbacks } = setup({ clearAuth, session: { logout, end } });
  await manager.start();
  callbacks().onOpen();
  callbacks().onUpsert(
    {
      type: "notify",
      messages: [textMessage("self@s.whatsapp.net", "process-only body", { fromMe: true })],
    },
    ["self@s.whatsapp.net"],
  );
  expect(manager.getSnapshot().messages).toHaveLength(1);

  await manager.stopForProcessExit();
  expect(manager.getSnapshot().messages).toEqual([]);
  expect(end).toHaveBeenCalledTimes(1);
  expect(logout).not.toHaveBeenCalled();
  expect(clearAuth).not.toHaveBeenCalled();
});
