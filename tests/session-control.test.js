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
  unattendedEnabled = false,
  clock,
  createSession,
} = {}) {
  let callbacks;
  const attempts = [];
  const factory = mock(async (handlers) => {
    callbacks = handlers;
    attempts.push(handlers);
    if (createSession) return createSession(handlers);
    return {
      logout: mock(async () => handlers.onClose({ loggedOut: true })),
      end: mock(async () => handlers.onClose({ loggedOut: false })),
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
    unattendedEnabled,
    clock,
  });
  return {
    manager,
    factory,
    attempts,
    callbacks: () => callbacks,
  };
}

function createFakeClock(start = 1_800_000_000_000) {
  let currentTime = start;
  let nextTimerId = 1;
  const scheduled = new Map();
  return {
    now: () => currentTime,
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      scheduled.set(id, { callback, due: currentTime + delay });
      return id;
    },
    clearTimeout(id) {
      scheduled.delete(id);
    },
    async advance(milliseconds) {
      const target = currentTime + milliseconds;
      while (true) {
        const next = [...scheduled.entries()]
          .filter(([, timer]) => timer.due <= target)
          .sort(([, first], [, second]) => first.due - second.due)[0];
        if (!next) break;
        const [id, timer] = next;
        scheduled.delete(id);
        currentTime = timer.due;
        await timer.callback();
      }
      currentTime = target;
    },
    get size() {
      return scheduled.size;
    },
  };
}

function startFailure(code) {
  return Object.assign(new Error("private saved-auth detail"), {
    name: "WhatsAppSessionStartError",
    code,
  });
}

test("constructing the manager is stopped and does not create a WhatsApp socket", () => {
  const { manager, factory } = setup();
  expect(manager.getSnapshot().status).toBe("stopped");
  expect(factory).not.toHaveBeenCalled();
});

test("automatic startup is opt-in and missing registration leaves explicit pairing available", async () => {
  const disabled = setup();
  await disabled.manager.startAutomatically();
  expect(disabled.factory).not.toHaveBeenCalled();
  expect(disabled.manager.getSnapshot().status).toBe("stopped");

  const createSession = mock(async (options) => {
    if (options.savedRegistrationOnly) throw startFailure("registration-missing");
    return {
      end: mock(async () => {}),
      logout: mock(async () => {}),
      sendSelf: mock(async () => {}),
    };
  });
  const enabled = setup({ unattendedEnabled: true, createSession });
  await enabled.manager.startAutomatically();
  expect(enabled.factory.mock.calls[0][0].savedRegistrationOnly).toBe(true);
  expect(enabled.manager.getSnapshot()).toMatchObject({
    status: "stopped",
    recovery: { interventionReason: "registration-missing" },
  });

  await enabled.manager.start();
  expect(enabled.factory.mock.calls[1][0].savedRegistrationOnly).toBe(false);
  expect(enabled.manager.getSnapshot().status).toBe("starting");
});

test("manual and automatic Start calls share one unsettled factory promise", async () => {
  const factoryGate = Promise.withResolvers();
  const createSession = mock(async (options) => {
    if (options.savedRegistrationOnly) await factoryGate.promise;
    return {
      end: mock(async () => {}),
      logout: mock(async () => {}),
      sendSelf: mock(async () => {}),
    };
  });
  const { manager, factory } = setup({
    unattendedEnabled: true,
    createSession,
  });
  const automaticStart = manager.startAutomatically();
  expect(factory).toHaveBeenCalledTimes(1);
  expect(factory.mock.calls[0][0].savedRegistrationOnly).toBe(true);

  expect(await manager.start()).toMatchObject({ status: "starting" });
  expect(factory).toHaveBeenCalledTimes(1);

  factoryGate.resolve();
  await automaticStart;
  expect(factory).toHaveBeenCalledTimes(1);
});

test("automatic pairing callbacks are hidden, closed, and blocked from replacement", async () => {
  const clock = createFakeClock();
  const end = mock(async () => {});
  const createSession = mock(async (options) => {
    if (options.savedRegistrationOnly) options.onPairing("synthetic private QR");
    return { end, logout: mock(async () => {}), sendSelf: mock(async () => {}) };
  });
  const { manager, factory, attempts } = setup({
    unattendedEnabled: true,
    clock,
    createSession,
  });
  end.mockImplementation(async () =>
    attempts[0].onClose({
      reason: "automatic-pairing-required",
      closeConfirmed: true,
    }),
  );

  await manager.startAutomatically();

  expect(manager.getSnapshot()).toMatchObject({
    status: "stopped",
    qr: null,
    recovery: {
      nextRetryAt: null,
      interventionReason: "automatic-pairing-required",
    },
  });
  expect(end).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(clock.size).toBe(0);
  expect(JSON.stringify(manager.getSnapshot())).not.toContain("synthetic private QR");

  await manager.start();
  expect(factory).toHaveBeenCalledTimes(2);
  expect(factory.mock.calls.at(-1)[0].savedRegistrationOnly).toBe(false);
  expect(manager.getSnapshot().status).toBe("starting");
});

test("successful logout prevents saved-account resume in a fresh unattended controller", async () => {
  let registrationAvailable = true;
  const createSession = mock(async (options) => {
    if (options.savedRegistrationOnly && !registrationAvailable) {
      throw startFailure("registration-missing");
    }
    return {
      logout: mock(async () =>
        options.onClose({
          loggedOut: true,
          reason: "logged-out-or-rejected",
          closeConfirmed: true,
        }),
      ),
      end: mock(async () => {}),
      sendSelf: mock(async () => {}),
    };
  });
  const clearAuth = mock(async () => {
    registrationAvailable = false;
  });
  const firstProcess = setup({
    createSession,
    clearAuth,
    unattendedEnabled: true,
  });
  await firstProcess.manager.start();
  firstProcess.attempts[0].onOpen();
  await firstProcess.manager.logout();
  expect(clearAuth).toHaveBeenCalledTimes(1);
  expect(registrationAvailable).toBe(false);

  const restartedProcess = setup({ createSession, unattendedEnabled: true });
  await restartedProcess.manager.startAutomatically();
  expect(restartedProcess.factory.mock.calls[0][0].savedRegistrationOnly).toBe(true);
  expect(restartedProcess.manager.getSnapshot()).toMatchObject({
    status: "stopped",
    recovery: { interventionReason: "registration-missing" },
  });
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
  const clock = createFakeClock();
  const { manager, callbacks, factory } = setup({ unattendedEnabled: true, clock });
  await manager.start();
  callbacks().onPairing("synthetic QR");

  const state = await manager.cancel();
  expect(state).toMatchObject({ status: "stopped", qr: null, messages: [] });
  callbacks().onOpen();
  expect(manager.getSnapshot().status).toBe("stopped");
  expect(factory).toHaveBeenCalledTimes(1);
  expect(clock.size).toBe(0);
});

test("pairing cancellation waits for factory settlement and fences late open callbacks", async () => {
  const factoryGate = Promise.withResolvers();
  let activeSockets = 0;
  const createSession = mock(async (handlers) => {
    activeSockets += 1;
    await factoryGate.promise;
    return {
      logout: mock(async () => {}),
      end: mock(async () => {
        activeSockets -= 1;
        handlers.onClose({ reason: "connection-closed", closeConfirmed: true });
      }),
      sendSelf: mock(async () => {}),
    };
  });
  const { manager, factory, attempts } = setup({ createSession });
  const starting = manager.start();
  expect(factory).toHaveBeenCalledTimes(1);
  const cancelling = manager.cancel();
  expect(manager.getSnapshot().status).toBe("stopping");
  attempts[0].onOpen();
  expect(manager.getSnapshot().status).toBe("stopping");

  factoryGate.resolve();
  await Promise.all([starting, cancelling]);
  attempts[0].onOpen();
  expect(manager.getSnapshot()).toMatchObject({ status: "stopped", qr: null });
  expect(activeSockets).toBe(0);
  expect(factory).toHaveBeenCalledTimes(1);
});

test("unexpected close clears QR and reports disconnection without reconnecting", async () => {
  const { manager, factory, callbacks } = setup();
  await manager.start();
  callbacks().onPairing("synthetic QR");
  callbacks().onClose({ loggedOut: false });

  expect(manager.getSnapshot()).toMatchObject({ status: "disconnected", qr: null });
  expect(factory).toHaveBeenCalledTimes(1);
});

test("unattended recovery retries only supported transient reasons after two seconds", async () => {
  for (const reason of [
    "connection-lost-or-timed-out",
    "connection-closed",
    "service-unavailable",
    "restart-required",
  ]) {
    const clock = createFakeClock();
    const { manager, factory, attempts } = setup({ unattendedEnabled: true, clock });
    await manager.start();
    attempts[0].onOpen();
    attempts[0].onClose({ reason, closeConfirmed: true });

    expect(manager.getSnapshot()).toMatchObject({
      status: "reconnecting",
      recovery: {
        attempt: 1,
        maxAttempts: 5,
        nextRetryAt: new Date(clock.now() + 2000).toISOString(),
        interventionReason: null,
      },
    });
    expect(factory).toHaveBeenCalledTimes(1);

    await clock.advance(1999);
    expect(factory).toHaveBeenCalledTimes(1);
    await clock.advance(1);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[1][0].savedRegistrationOnly).toBe(true);
    expect(manager.getSnapshot().status).toBe("starting");
  }
});

test("recovery uses the five finite delays and stops after the fifth replacement", async () => {
  const clock = createFakeClock();
  const { manager, factory, attempts } = setup({ unattendedEnabled: true, clock });
  await manager.start();
  attempts[0].onClose({ reason: "connection-lost-or-timed-out", closeConfirmed: true });

  for (const [index, delay] of [2000, 4000, 8000, 16000, 30000].entries()) {
    expect(manager.getSnapshot().recovery.nextRetryAt).toBe(
      new Date(clock.now() + delay).toISOString(),
    );
    await clock.advance(delay);
    expect(factory).toHaveBeenCalledTimes(index + 2);
    expect(factory.mock.calls[index + 1][0].savedRegistrationOnly).toBe(true);
    attempts[index + 1].onClose({
      reason: "connection-closed",
      closeConfirmed: true,
    });
  }

  expect(manager.getSnapshot()).toMatchObject({
    status: "disconnected",
    recovery: {
      attempt: 5,
      maxAttempts: 5,
      nextRetryAt: null,
      interventionReason: "recovery-exhausted",
    },
  });
  expect(clock.size).toBe(0);
  expect(factory).toHaveBeenCalledTimes(6);
});

test("a fresh manual Start after exhaustion resets the budget and reuses the single slot", async () => {
  const clock = createFakeClock();
  const { manager, factory, attempts } = setup({ unattendedEnabled: true, clock });
  await manager.start();
  attempts[0].onClose({ reason: "connection-closed", closeConfirmed: true });

  for (const delay of [2000, 4000, 8000, 16000, 30000]) {
    await clock.advance(delay);
    attempts.at(-1).onClose({ reason: "connection-closed", closeConfirmed: true });
  }
  expect(manager.getSnapshot().recovery).toMatchObject({
    attempt: 5,
    interventionReason: "recovery-exhausted",
  });

  await manager.start();
  expect(factory).toHaveBeenCalledTimes(7);
  expect(factory.mock.calls.at(-1)[0].savedRegistrationOnly).toBe(false);
  expect(manager.getSnapshot()).toMatchObject({
    status: "starting",
    recovery: { attempt: 0, interventionReason: null },
  });
  attempts.at(-1).onClose({ reason: "service-unavailable", closeConfirmed: true });
  expect(manager.getSnapshot().recovery.attempt).toBe(1);
  expect(clock.size).toBe(1);
});

test("repeated Start and a close-before-factory-settlement cannot create parallel sockets", async () => {
  const clock = createFakeClock();
  const firstFactoryGate = Promise.withResolvers();
  let activeSockets = 0;
  let factoryCalls = 0;
  const createSession = mock(async (handlers) => {
    factoryCalls += 1;
    expect(activeSockets).toBe(0);
    activeSockets += 1;
    if (factoryCalls === 1) await firstFactoryGate.promise;
    return {
      logout: async () => {
        activeSockets -= 1;
        handlers.onClose({ loggedOut: true, closeConfirmed: true });
      },
      end: async () => {
        activeSockets -= 1;
        handlers.onClose({ reason: "connection-closed", closeConfirmed: true });
      },
      sendSelf: async () => {},
    };
  });
  const { manager, factory, attempts } = setup({
    unattendedEnabled: true,
    clock,
    createSession,
  });

  const firstStart = manager.start();
  expect(factory).toHaveBeenCalledTimes(1);
  expect(await manager.start()).toMatchObject({ status: "starting" });
  expect(factory).toHaveBeenCalledTimes(1);
  activeSockets -= 1;
  attempts[0].onClose({ reason: "connection-lost-or-timed-out", closeConfirmed: true });

  const dueRetry = clock.advance(2000);
  await Promise.resolve();
  expect(factory).toHaveBeenCalledTimes(1);
  firstFactoryGate.resolve();
  await Promise.all([firstStart, dueRetry]);

  expect(factory).toHaveBeenCalledTimes(2);
  expect(activeSockets).toBe(1);
  expect(manager.getSnapshot().status).toBe("starting");
});

test("terminal, unknown, and generic startup failures never schedule automatic recovery", async () => {
  for (const [reason, status, interventionReason] of [
    ["logged-out-or-rejected", "logged-out", "logged-out-or-rejected"],
    ["forbidden", "review-required", "forbidden"],
    ["multidevice-mismatch", "review-required", "multidevice-mismatch"],
    ["connection-replaced", "review-required", "connection-replaced"],
    ["bad-session", "review-required", "bad-session"],
    ["unknown", "review-required", "unknown-disconnect"],
    ["unrecognized raw private failure", "review-required", "unknown-disconnect"],
  ]) {
    const clock = createFakeClock();
    const { manager, factory, attempts } = setup({ unattendedEnabled: true, clock });
    await manager.start();
    attempts[0].onClose({ reason, closeConfirmed: true });
    expect(manager.getSnapshot()).toMatchObject({
      status,
      recovery: { interventionReason },
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(clock.size).toBe(0);
    expect(JSON.stringify(manager.getSnapshot())).not.toContain("raw private failure");
  }

  const clock = createFakeClock();
  const failingFactory = mock(async () => {
    throw new Error("private startup details");
  });
  const { manager, factory } = setup({
    unattendedEnabled: true,
    clock,
    createSession: failingFactory,
  });
  await manager.start();
  expect(manager.getSnapshot()).toMatchObject({
    status: "review-required",
    recovery: { interventionReason: "startup-failed", nextRetryAt: null },
  });
  expect(factory).toHaveBeenCalledTimes(1);
  expect(clock.size).toBe(0);
  expect(JSON.stringify(manager.getSnapshot())).not.toContain("private startup details");
});

test("credential-save failure stops the session and requires review without reconnecting", async () => {
  const clock = createFakeClock();
  const end = mock(async () => {});
  const { manager, factory, attempts } = setup({
    unattendedEnabled: true,
    clock,
    session: { end },
  });
  await manager.start();
  attempts[0].onOpen();
  attempts[0].onCredentialSaveFailure();

  expect(manager.getSnapshot()).toMatchObject({
    status: "review-required",
    recovery: { interventionReason: "credential-save-failed", nextRetryAt: null },
  });
  await Promise.resolve();
  expect(end).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(clock.size).toBe(0);
});

test("brief connection flapping preserves the budget and 60 stable seconds reset it", async () => {
  const clock = createFakeClock();
  const { manager, factory, attempts } = setup({ unattendedEnabled: true, clock });

  await manager.start();
  attempts[0].onOpen();
  await clock.advance(20_000);
  attempts[0].onClose({ reason: "connection-lost-or-timed-out", closeConfirmed: true });
  expect(manager.getSnapshot().recovery.attempt).toBe(1);

  await clock.advance(2000);
  expect(factory).toHaveBeenCalledTimes(2);
  attempts[1].onOpen();
  await clock.advance(59_999);
  expect(manager.getSnapshot().recovery.attempt).toBe(1);
  attempts[1].onClose({ reason: "connection-closed", closeConfirmed: true });
  expect(manager.getSnapshot().recovery.attempt).toBe(2);

  await clock.advance(4000);
  expect(factory).toHaveBeenCalledTimes(3);
  attempts[2].onOpen();
  await clock.advance(60_000);
  expect(manager.getSnapshot().recovery).toMatchObject({
    attempt: 0,
    interventionReason: null,
    nextRetryAt: null,
  });
  attempts[2].onClose({ reason: "service-unavailable", closeConfirmed: true });
  expect(manager.getSnapshot().recovery.attempt).toBe(1);
});

test("uncertain termination blocks replacement even if a later close event arrives", async () => {
  const clock = createFakeClock();
  const { manager, factory, attempts } = setup({ unattendedEnabled: true, clock });
  await manager.start();
  attempts[0].onClose({
    reason: "connection-lost-or-timed-out",
    closeConfirmed: false,
  });

  expect(manager.getSnapshot()).toMatchObject({
    status: "review-required",
    recovery: {
      nextRetryAt: null,
      interventionReason: "socket-termination-uncertain",
    },
  });
  attempts[0].onClose({
    reason: "connection-closed",
    closeConfirmed: true,
  });
  await clock.advance(60_000);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(manager.getSnapshot()).toMatchObject({
    status: "review-required",
    recovery: { interventionReason: "socket-termination-uncertain" },
  });
});

test("old generation events cannot change state or schedule work after a replacement starts", async () => {
  const clock = createFakeClock();
  const { manager, factory, attempts } = setup({ clock });
  await manager.start();
  attempts[0].onClose({ loggedOut: false });
  expect(manager.getSnapshot().status).toBe("disconnected");

  await manager.start();
  expect(factory).toHaveBeenCalledTimes(2);
  expect(manager.getSnapshot().status).toBe("starting");
  attempts[0].onOpen();
  attempts[0].onClose({
    reason: "connection-lost-or-timed-out",
    closeConfirmed: true,
  });
  expect(manager.getSnapshot().status).toBe("starting");
  expect(clock.size).toBe(0);
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
  const clock = createFakeClock();
  let callbacks;
  const { manager, factory } = setup({
    unattendedEnabled: true,
    clock,
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
  expect(clock.size).toBe(1);
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
  expect(clock.size).toBe(0);
  expect(managerCallbacks(factory)).toBe(callbacks);
  callbacks.onOpen();
  expect(manager.getSnapshot().status).toBe("stopped");
  expect(factory).toHaveBeenCalledTimes(1);
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
  const clock = createFakeClock();
  const logout = mock(async () => {});
  const end = mock(async () => {});
  const clearAuth = mock(async () => {});
  const { manager, callbacks } = setup({
    clearAuth,
    session: { logout, end },
    unattendedEnabled: true,
    clock,
  });
  await manager.start();
  callbacks().onOpen();
  expect(clock.size).toBe(1);
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
  expect(clock.size).toBe(0);
  await clock.advance(60_000);
  expect(manager.getSnapshot().recovery.attempt).toBe(0);
  expect(logout).not.toHaveBeenCalled();
  expect(clearAuth).not.toHaveBeenCalled();
});

test("shutdown cancels queued recovery without replacing the closed session or deleting auth", async () => {
  const clock = createFakeClock();
  const end = mock(async () => {});
  const clearAuth = mock(async () => {});
  const { manager, factory, attempts } = setup({
    clearAuth,
    session: { end },
    unattendedEnabled: true,
    clock,
  });
  await manager.start();
  attempts[0].onClose({ reason: "connection-closed", closeConfirmed: true });
  expect(clock.size).toBe(1);

  await manager.stopForProcessExit();
  expect(clock.size).toBe(0);
  await clock.advance(60_000);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(clearAuth).not.toHaveBeenCalled();
});
