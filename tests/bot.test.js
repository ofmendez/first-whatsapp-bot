import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, mock, spyOn, test } from "bun:test";

// Mock external facilities before importing application modules: no real auth or sockets.
const handlers = new Map();
const state = { synthetic: true };
const saveCreds = mock(async () => {});
const auth = mock(async () => ({ state, saveCreds }));
const mediaDownload = mock(async () => ({ pipe() {} }));
const socket = {
  ev: { on: mock((event, handler) => handlers.set(event, handler)) },
  sendMessage: mock(async function () {
    expect(this).toBe(socket);
  }),
  logout: mock(async () => {}),
  end: mock(() => {}),
  user: { id: "synthetic@s.whatsapp.net", lid: "synthetic@lid" },
};
const makeSocket = mock(() => socket);
const logger = {};
const pino = mock(() => logger);

mock.module("@whiskeysockets/baileys", () => ({
  default: makeSocket,
  downloadMediaMessage: mediaDownload,
  useMultiFileAuthState: auth,
  DisconnectReason: {
    loggedOut: 401,
    forbidden: 403,
    connectionLost: 408,
    timedOut: 408,
    multideviceMismatch: 411,
    connectionClosed: 428,
    connectionReplaced: 440,
    badSession: 500,
    unavailableService: 503,
    restartRequired: 515,
  },
}));
mock.module("pino", () => ({ default: pino }));

const { replyForCommand } = await import("@/src/commands.js");
const { processUpsert } = await import("@/src/messages.js");
const { createWhatsAppSession, downloadImageStream } = await import("@/src/whatsapp.js");
const { AlbumImageCatalog } = await import("@/src/album-catalog.js");
const { createControlHandler } = await import("@/src/control-server.js");
const { createDashboardSessionService, dashboardCookie } = await import("@/src/dashboard-auth.js");
const { ImageReceiver } = await import("@/src/image-receiver.js");
const { ReceivedImageStore } = await import("@/src/received-image-store.js");
const { SessionController } = await import("@/src/session-controller.js");
const importAuthCalls = auth.mock.calls.length;
const importSocketCalls = makeSocket.mock.calls.length;

function isolatedSocket() {
  const events = new Map();
  const socket = {
    ev: {
      on: mock((event, handler) => events.set(event, handler)),
    },
    end: mock(async () => events.get("connection.update")?.({ connection: "close" })),
    logout: mock(async () => events.get("connection.update")?.({ connection: "close" })),
    sendMessage: mock(async () => {}),
    user: { id: "synthetic@s.whatsapp.net" },
  };
  return { socket, events };
}

async function withTemporaryAuthDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), "whatsapp-adapter-auth-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const reply = { text: "Pong! Running on Bun 🚀" };
const incoming = (message, remoteJid = "synthetic@s.whatsapp.net", fromMe = false) => ({
  key: { remoteJid, fromMe },
  message,
});
const batch = (...messages) => ({ type: "notify", messages });

test("reusable imports do not access auth or create sockets", () => {
  expect(importAuthCalls).toBe(0);
  expect(importSocketCalls).toBe(0);
});

test("ping uses exact reply and destination with trimmed, case-insensitive text", async () => {
  expect(replyForCommand(" \n!PiNg\t")).toBe(reply.text);
  expect(replyForCommand("!unknown")).toBeUndefined();
  const send = mock(async () => {});
  await processUpsert(batch(incoming({ conversation: "  !PiNg  " })), send);
  expect(send.mock.calls).toEqual([["synthetic@s.whatsapp.net", reply]]);
});

test("supported text fields retain nullish precedence", async () => {
  const send = mock(async () => {});
  await processUpsert(
    batch(
      incoming({ extendedTextMessage: { text: "!ping" } }, "extended"),
      incoming({ conversation: null, extendedTextMessage: { text: "!ping" } }, "null"),
      incoming({ conversation: "", extendedTextMessage: { text: "!ping" } }),
      incoming({ conversation: "!unknown", extendedTextMessage: { text: "!ping" } }),
      incoming({ conversation: "!ping", extendedTextMessage: { text: "!unknown" } }, "plain"),
    ),
    send,
  );
  expect(send.mock.calls).toEqual([
    ["extended", reply],
    ["null", reply],
    ["plain", reply],
  ]);
});

test("non-notify batches are ignored before examining messages", async () => {
  const send = mock(async () => {});
  for (const type of ["append", "replace", undefined]) {
    await processUpsert({ type }, send);
  }
  expect(send).not.toHaveBeenCalled();
});

test("own-account, group, incomplete, empty and unknown messages are skipped", async () => {
  const send = mock(async () => {});
  await processUpsert(
    batch(
      incoming({ conversation: "!ping" }, "self", true),
      incoming({ conversation: "!ping" }, "synthetic@g.us"),
      incoming({ conversation: "!ping" }, null),
      incoming({ conversation: "!ping" }, ""),
      incoming(undefined),
      incoming({}),
      incoming({ conversation: "" }),
      incoming({ conversation: "   " }),
      incoming({ conversation: "!unknown" }),
    ),
    send,
  );
  expect(send).not.toHaveBeenCalled();
});

test("sends finish sequentially within a batch", async () => {
  const first = Promise.withResolvers();
  const events = [];
  const send = mock(async (jid) => {
    events.push(`start ${jid}`);
    if (jid === "first") await first.promise;
    events.push(`end ${jid}`);
  });
  const processing = processUpsert(
    batch(
      incoming({ conversation: "!ping" }, "first"),
      incoming({ conversation: "!ping" }, "second"),
    ),
    send,
  );
  expect(events).toEqual(["start first"]);
  first.resolve();
  await processing;
  expect(events).toEqual(["start first", "end first", "start second", "end second"]);
});

test("album opt-in accepts normalized exact direct-contact text and confirms after commit", async () => {
  const order = [];
  const approveConversation = mock(async (approval) => {
    order.push("commit");
    expect(approval).toEqual({
      accountJid: "owner@s.whatsapp.net",
      chatJid: "contact@s.whatsapp.net",
      displayName: "Contact",
    });
    return {
      approved: true,
      conversationId: "opaque-conversation-id",
      newlyApproved: true,
      shouldConfirm: true,
    };
  });
  const send = mock(async (jid, content) => {
    order.push("send");
    expect(jid).toBe("contact@s.whatsapp.net");
    expect(content).toEqual({
      text: "Hemos iniciado, ya estoy disponible!",
    });
  });
  const onAlbumApproved = mock(() => order.push("dashboard-update"));

  await processUpsert(
    batch({
      ...incoming({ conversation: "  ｉｎｉｃｉａ　Ａｌｂｕｍ\n" }, "contact@s.whatsapp.net"),
      pushName: "Contact",
    }),
    send,
    {
      accountJids: ["owner@s.whatsapp.net"],
      albumService: { approveConversation },
      onAlbumApproved,
    },
  );

  expect(approveConversation).toHaveBeenCalledTimes(1);
  expect(onAlbumApproved).toHaveBeenCalledTimes(1);
  expect(order).toEqual(["commit", "dashboard-update", "send"]);
});

test("album opt-in excludes non-exact, non-direct, self, outgoing, quoted, and caption text", async () => {
  const approveConversation = mock(async () => ({
    approved: true,
    newlyApproved: true,
    shouldConfirm: true,
  }));
  const send = mock(async () => {});
  const exactText = (text, remoteJid = "contact@s.whatsapp.net", fromMe = false) =>
    incoming({ conversation: text }, remoteJid, fromMe);

  await processUpsert(
    batch(
      exactText("iniciar album"),
      exactText("inicia album ahora"),
      exactText("inicia album!"),
      incoming({ imageMessage: { caption: "inicia album" } }),
      incoming({
        extendedTextMessage: {
          contextInfo: { quotedMessage: { conversation: "inicia album" } },
        },
      }),
      exactText("inicia album", "contact@g.us"),
      exactText("inicia album", "status@broadcast"),
      exactText("inicia album", "newsletter@newsletter"),
      exactText("inicia album", "owner@lid"),
      exactText("inicia album", "contact@s.whatsapp.net", true),
      {
        key: { remoteJid: "contact@s.whatsapp.net" },
        message: { conversation: "inicia album" },
      },
    ),
    send,
    {
      accountJids: ["owner@s.whatsapp.net", "owner@lid"],
      albumService: { approveConversation },
    },
  );
  await processUpsert(batch(exactText("inicia album")), send, {
    accountJids: [],
    albumService: { approveConversation },
  });
  await processUpsert({ type: "append", messages: [exactText("inicia album")] }, send, {
    accountJids: ["owner@s.whatsapp.net"],
    albumService: { approveConversation },
  });

  expect(approveConversation).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test("approval failure sends no confirmation and does not publish album state", async () => {
  const approveConversation = mock(async () => {
    throw new Error("synthetic approval persistence failure");
  });
  const send = mock(async () => {});
  const onAlbumApproved = mock(() => {});

  await expect(
    processUpsert(
      batch(incoming({ conversation: "inicia album" }, "contact@s.whatsapp.net")),
      send,
      {
        accountJids: ["owner@s.whatsapp.net"],
        albumService: { approveConversation },
        onAlbumApproved,
      },
    ),
  ).rejects.toThrow("synthetic approval persistence failure");
  expect(send).not.toHaveBeenCalled();
  expect(onAlbumApproved).not.toHaveBeenCalled();
});

test("committed approval is retained after send failure and never retried automatically", async () => {
  let attemptReserved = false;
  const approveConversation = mock(async () => {
    if (attemptReserved) {
      return {
        approved: true,
        newlyApproved: false,
        shouldConfirm: false,
      };
    }
    attemptReserved = true;
    return {
      approved: true,
      newlyApproved: true,
      shouldConfirm: true,
    };
  });
  const send = mock(async () => {
    throw new Error("synthetic confirmation send failure");
  });
  const upsert = batch(incoming({ conversation: "inicia album" }, "contact@s.whatsapp.net"));
  const options = {
    accountJids: ["owner@s.whatsapp.net"],
    albumService: { approveConversation },
  };

  await expect(processUpsert(upsert, send, options)).rejects.toThrow(
    "synthetic confirmation send failure",
  );
  await processUpsert(upsert, send, options);
  expect(attemptReserved).toBe(true);
  expect(approveConversation).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledTimes(1);
});

test("send rejection propagates without retry or subsequent sends", async () => {
  const error = new Error("synthetic send failure");
  const send = mock(async () => {
    throw error;
  });
  await expect(
    processUpsert(
      batch(
        incoming({ conversation: "!ping" }, "first"),
        incoming({ conversation: "!ping" }, "second"),
      ),
      send,
    ),
  ).rejects.toBe(error);
  expect(send.mock.calls).toEqual([["first", reply]]);
});

test("processing emits neither message bodies nor sender identifiers", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    await processUpsert(
      batch(
        incoming({ conversation: "private synthetic text" }, "private-sender"),
        incoming({ conversation: "!ping" }, "private-sender"),
      ),
      async () => {},
    );
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("explicit session factory wires one socket, persistence, transient pairing, and self-only sends", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const onPairing = mock(() => {});
  const onOpen = mock(() => {});
  const onClose = mock(() => {});
  const onUpsert = mock(() => {});
  const approveConversation = mock(async (approval) => {
    expect(approval).toEqual({
      accountJid: "synthetic@s.whatsapp.net",
      chatJid: "contact@s.whatsapp.net",
      displayName: "Contact",
    });
    return {
      approved: true,
      conversationId: "socket-conversation",
      newlyApproved: true,
      shouldConfirm: true,
    };
  });
  const onAlbumApproved = mock(() => {});
  try {
    const session = await createWhatsAppSession({
      onPairing,
      onOpen,
      onClose,
      onUpsert,
      albumService: { approveConversation },
      onAlbumApproved,
    });
    expect(auth.mock.calls).toEqual([["./auth_info"]]);
    expect(pino.mock.calls).toEqual([[{ level: "silent" }]]);
    expect(makeSocket.mock.calls).toEqual([
      [
        {
          auth: state,
          logger,
          markOnlineOnConnect: false,
        },
      ],
    ]);
    expect([...handlers.keys()]).toEqual(["creds.update", "connection.update", "messages.upsert"]);
    expect(typeof handlers.get("creds.update")).toBe("function");
    await handlers.get("creds.update")();
    expect(saveCreds).toHaveBeenCalledTimes(1);

    const connection = handlers.get("connection.update");
    connection({ qr: "synthetic-pairing-code" });
    expect(onPairing.mock.calls).toEqual([["synthetic-pairing-code"]]);
    connection({ connection: "open" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(makeSocket).toHaveBeenCalledTimes(1);

    const upsert = handlers.get("messages.upsert");
    upsert({ type: "append", messages: [incoming({ conversation: "!ping" })] });
    expect(onUpsert.mock.calls[0][0].type).toBe("append");
    upsert(
      batch(
        incoming({ imageMessage: { mimetype: "image/jpeg", caption: "!ping" } }, "image"),
        incoming({ imageMessage: { mimetype: "image/jpeg" } }, "self", true),
      ),
    );
    const commandSent = Promise.withResolvers();
    const albumSent = Promise.withResolvers();
    socket.sendMessage.mockImplementation(async function (jid, content) {
      expect(this).toBe(socket);
      if (content.text === reply.text) commandSent.resolve();
      if (content.text === "Hemos iniciado, ya estoy disponible!") {
        albumSent.resolve();
      }
    });
    upsert(batch(incoming({ conversation: "!ping" }, "self", true)));
    onUpsert.mockImplementationOnce(() => {
      throw new Error("private passive image failure");
    });
    upsert(
      batch(
        incoming(
          { imageMessage: { mimetype: "image/jpeg", caption: "!ping" } },
          "image-with-command",
        ),
        incoming({ conversation: "!ping" }),
      ),
    );
    await commandSent.promise;
    upsert(
      batch({
        ...incoming({ conversation: "inicia album" }, "contact@s.whatsapp.net"),
        pushName: "Contact",
      }),
    );
    await albumSent.promise;
    expect(approveConversation).toHaveBeenCalledTimes(1);
    expect(onAlbumApproved).toHaveBeenCalledWith({
      approved: true,
      conversationId: "socket-conversation",
      newlyApproved: true,
      shouldConfirm: true,
    });
    expect(socket.sendMessage).toHaveBeenCalledTimes(2);
    expect(onUpsert.mock.calls.length).toBe(5);
    expect(socket.sendMessage.mock.calls).toEqual([
      ["synthetic@s.whatsapp.net", reply],
      [
        "contact@s.whatsapp.net",
        {
          text: "Hemos iniciado, ya estoy disponible!",
        },
      ],
    ]);

    await session.sendSelf("synthetic manual self-chat");
    expect(socket.sendMessage.mock.calls[2]).toEqual([
      "synthetic@s.whatsapp.net",
      { text: "synthetic manual self-chat" },
    ]);

    const stream = await downloadImageStream(
      incoming({ imageMessage: { mimetype: "image/jpeg" } }),
    );
    expect(stream).toHaveProperty("pipe");
    expect(mediaDownload.mock.calls.at(-1)).toEqual([
      incoming({ imageMessage: { mimetype: "image/jpeg" } }),
      "stream",
      {},
    ]);

    socket.logout.mockImplementation(async () => {
      connection({
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
    });
    await session.logout();
    expect(onClose.mock.calls).toEqual([
      [{ loggedOut: true, reason: "logged-out-or-rejected", closeConfirmed: true }],
    ]);

    const secondSession = await createWhatsAppSession({ onPairing, onOpen, onClose, onUpsert });
    socket.end.mockImplementation(() => handlers.get("connection.update")({ connection: "close" }));
    await secondSession.end();
    expect(onClose.mock.calls.at(-1)).toEqual([
      { loggedOut: false, reason: "unknown", closeConfirmed: true },
    ]);

    const failure = new Error("synthetic event send failure");
    socket.sendMessage.mockRejectedValueOnce(failure);
    await expect(secondSession.sendSelf("synthetic failing send")).rejects.toBe(failure);
  } finally {
    log.mockRestore();
  }
});

test("saved-registration-only startup skips missing or unregistered auth without loading a socket", async () => {
  await withTemporaryAuthDirectory(async (root) => {
    const absentDirectory = join(root, "absent");
    const unregisteredDirectory = join(root, "unregistered");
    await mkdir(unregisteredDirectory);
    const unregisteredAuth = JSON.stringify({ registered: false, synthetic: "private fixture" });
    await writeFile(join(unregisteredDirectory, "creds.json"), unregisteredAuth, { mode: 0o600 });

    const loadAuthState = mock(async () => ({
      state: { creds: { registered: false }, keys: {} },
      saveCreds: mock(async () => {}),
    }));
    const makeSocket = mock(() => isolatedSocket().socket);

    for (const authDirectory of [absentDirectory, root, unregisteredDirectory]) {
      await expect(
        createWhatsAppSession(
          { savedRegistrationOnly: true },
          {
            authDirectory,
            loadAuthState,
            makeSocket,
          },
        ),
      ).rejects.toMatchObject({
        name: "WhatsAppSessionStartError",
        code: "registration-missing",
      });
    }

    expect(loadAuthState).not.toHaveBeenCalled();
    expect(makeSocket).not.toHaveBeenCalled();
    expect(await readFile(join(unregisteredDirectory, "creds.json"), "utf8")).toBe(
      unregisteredAuth,
    );
  });
});

test("saved-registration-only startup classifies malformed and unreadable auth without exposing it", async () => {
  await withTemporaryAuthDirectory(async (root) => {
    const malformedDirectory = join(root, "malformed");
    const unreadableDirectory = join(root, "unreadable");
    await mkdir(malformedDirectory);
    await mkdir(unreadableDirectory);
    const privateFixture = "synthetic private credential fixture";
    await writeFile(join(malformedDirectory, "creds.json"), `{${privateFixture}`, {
      mode: 0o600,
    });
    await writeFile(join(unreadableDirectory, "creds.json"), JSON.stringify({ registered: true }), {
      mode: 0o600,
    });

    const makeSocket = mock(() => isolatedSocket().socket);
    const loadAuthState = mock(async () => ({
      state: { creds: { registered: true }, keys: {} },
      saveCreds: mock(async () => {}),
    }));
    const unreadableFileSystem = {
      lstat,
      readdir,
      readFile: async (path, encoding) => {
        if (path === join(unreadableDirectory, "creds.json")) {
          throw Object.assign(new Error(privateFixture), { code: "EACCES" });
        }
        return readFile(path, encoding);
      },
    };

    await expect(
      createWhatsAppSession(
        { savedRegistrationOnly: true },
        {
          authDirectory: malformedDirectory,
          loadAuthState,
          makeSocket,
        },
      ),
    ).rejects.toMatchObject({ code: "saved-auth-malformed" });
    await expect(
      createWhatsAppSession(
        { savedRegistrationOnly: true },
        {
          authDirectory: unreadableDirectory,
          fileSystem: unreadableFileSystem,
          loadAuthState,
          makeSocket,
        },
      ),
    ).rejects.toMatchObject({ code: "saved-auth-unavailable" });

    expect(loadAuthState).not.toHaveBeenCalled();
    expect(makeSocket).not.toHaveBeenCalled();
    expect(await readFile(join(malformedDirectory, "creds.json"), "utf8")).toContain(
      privateFixture,
    );
    expect(JSON.stringify(loadAuthState.mock.calls)).not.toContain(privateFixture);
    expect(JSON.stringify(makeSocket.mock.calls)).not.toContain(privateFixture);
  });
});

test("saved-registration-only startup verifies loaded credentials before creating a socket", async () => {
  await withTemporaryAuthDirectory(async (authDirectory) => {
    await writeFile(
      join(authDirectory, "creds.json"),
      JSON.stringify({ registered: true, synthetic: "private fixture" }),
      { mode: 0o600 },
    );
    const loadAuthState = mock(async () => ({
      state: { creds: { registered: false }, keys: {} },
      saveCreds: mock(async () => {}),
    }));
    const makeSocket = mock(() => isolatedSocket().socket);

    await expect(
      createWhatsAppSession(
        { savedRegistrationOnly: true },
        {
          authDirectory,
          loadAuthState,
          makeSocket,
        },
      ),
    ).rejects.toMatchObject({
      name: "WhatsAppSessionStartError",
      code: "registration-missing",
    });

    expect(loadAuthState).toHaveBeenCalledTimes(1);
    expect(makeSocket).not.toHaveBeenCalled();
  });
});

test("adapter reports only fixed disconnect categories to its controller", async () => {
  for (const [statusCode, reason] of [
    [401, "logged-out-or-rejected"],
    [403, "forbidden"],
    [408, "connection-lost-or-timed-out"],
    [411, "multidevice-mismatch"],
    [428, "connection-closed"],
    [440, "connection-replaced"],
    [500, "bad-session"],
    [503, "service-unavailable"],
    [515, "restart-required"],
    [499, "unknown"],
  ]) {
    const { socket, events } = isolatedSocket();
    const onClose = mock(() => {});
    await createWhatsAppSession(
      { onClose },
      {
        loadAuthState: async () => ({
          state: { creds: { registered: false }, keys: {} },
          saveCreds: mock(async () => {}),
        }),
        makeSocket: () => socket,
        loggerFactory: () => ({}),
      },
    );
    events.get("connection.update")({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode }, message: "private adapter error" } },
    });

    expect(onClose).toHaveBeenCalledWith({
      loggedOut: statusCode === 401,
      reason,
      closeConfirmed: true,
    });
    expect(JSON.stringify(onClose.mock.calls)).not.toContain("private adapter error");
  }
});

test("automatic QR data is suppressed and its socket must confirm closure", async () => {
  await withTemporaryAuthDirectory(async (authDirectory) => {
    await writeFile(
      join(authDirectory, "creds.json"),
      JSON.stringify({ registered: true, synthetic: "private fixture" }),
      { mode: 0o600 },
    );
    const { socket, events } = isolatedSocket();
    const onPairing = mock(() => {});
    const onClose = mock(() => {});
    const session = await createWhatsAppSession(
      { savedRegistrationOnly: true, onPairing, onClose },
      {
        authDirectory,
        loadAuthState: async () => ({
          state: { creds: { registered: true }, keys: {} },
          saveCreds: mock(async () => {}),
        }),
        makeSocket: () => socket,
        loggerFactory: () => ({}),
      },
    );

    events.get("connection.update")({ qr: "synthetic private QR payload" });
    await session.end();

    expect(onPairing).not.toHaveBeenCalled();
    expect(socket.end).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({
      loggedOut: false,
      reason: "automatic-pairing-required",
      closeConfirmed: true,
    });
    expect(JSON.stringify(onClose.mock.calls)).not.toContain("synthetic private QR payload");
  });
});

test("automatic QR termination reports uncertain closure and never claims it is safe", async () => {
  await withTemporaryAuthDirectory(async (authDirectory) => {
    await writeFile(join(authDirectory, "creds.json"), JSON.stringify({ registered: true }), {
      mode: 0o600,
    });
    const { socket, events } = isolatedSocket();
    socket.end.mockImplementation(async () => {});
    const onClose = mock(() => {});
    await createWhatsAppSession(
      { savedRegistrationOnly: true, onClose },
      {
        authDirectory,
        closeTimeoutMs: 2,
        loadAuthState: async () => ({
          state: { creds: { registered: true }, keys: {} },
          saveCreds: mock(async () => {}),
        }),
        makeSocket: () => socket,
        loggerFactory: () => ({}),
      },
    );

    events.get("connection.update")({ qr: "synthetic private QR payload" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onClose).toHaveBeenCalledWith({
      loggedOut: false,
      reason: "socket-termination-uncertain",
      closeConfirmed: false,
    });
  });
});

async function withDebug(value, run) {
  const previous = process.env.DEBUG;
  const info = spyOn(console, "info").mockImplementation(() => {});
  if (value === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = value;
  try {
    await run(info);
  } finally {
    if (previous === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = previous;
    info.mockRestore();
  }
}

test("diagnostics are disabled unless DEBUG is exactly true", async () => {
  for (const value of [undefined, "", "false", "0", "1", "TRUE", "*"]) {
    await withDebug(value, async (info) => {
      const onPairing = mock(() => {});
      const onOpen = mock(() => {});
      const onClose = mock(() => {});
      await createWhatsAppSession({ onPairing, onOpen, onClose });
      const connection = handlers.get("connection.update");
      connection({ qr: "private QR" });
      connection({ isNewLogin: true });
      connection({ connection: "open" });
      saveCreds.mockRejectedValueOnce(new Error("private credentials"));
      await handlers.get("creds.update")();
      connection({
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
      expect(info).not.toHaveBeenCalled();
      expect(onPairing).toHaveBeenCalledWith("private QR");
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledWith({
        loggedOut: true,
        reason: "logged-out-or-rejected",
        closeConfirmed: true,
      });
      auth.mockRejectedValueOnce(new Error("private auth error"));
      await expect(createWhatsAppSession({})).rejects.toThrow("private auth error");
      expect(info).not.toHaveBeenCalled();
    });
  }
});

test("DEBUG diagnostics expose only fixed pairing stages and safe disconnect codes", async () => {
  await withDebug("true", async (info) => {
    const privateValue = "private QR / credentials / phone / message";
    const onClose = mock(() => {});
    await createWhatsAppSession({ onClose });
    const connection = handlers.get("connection.update");
    connection({ qr: privateValue });
    connection({ qr: `${privateValue}-replacement` });
    connection({ isNewLogin: true, credentials: privateValue });
    connection({
      connection: "close",
      lastDisconnect: {
        error: {
          output: { statusCode: 515, payload: privateValue },
          message: privateValue,
          stack: privateValue,
          data: { phone: privateValue },
        },
      },
    });
    connection({ connection: "open", qr: privateValue });
    connection({ connection: "close" });
    expect(info.mock.calls).toEqual([
      ["[whatsapp]", { event: "session-start", stage: "starting" }],
      ["[whatsapp]", { event: "qr-issued", stage: "awaiting-scan" }],
      ["[whatsapp]", { event: "qr-refreshed", stage: "awaiting-scan" }],
      ["[whatsapp]", { event: "pairing-accepted", stage: "paired-awaiting-connection" }],
      [
        "[whatsapp]",
        {
          event: "connection-close",
          stage: "paired-awaiting-connection",
          statusCode: 515,
          reason: "restart-required",
        },
      ],
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toContain(privateValue);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({
      loggedOut: false,
      reason: "restart-required",
      closeConfirmed: true,
    });
  });
});

test("DEBUG diagnostics distinguish rejection, timeout, and unknown codes without raw errors", async () => {
  await withDebug("true", async (info) => {
    for (const [code, expectedCode, reason] of [
      [401, 401, "logged-out-or-rejected"],
      [408, 408, "connection-lost-or-timed-out"],
      [440, 440, "connection-replaced"],
      [499, 499, "unknown"],
      [undefined, null, "unknown"],
      ["private error text", null, "unknown"],
      [NaN, null, "unknown"],
      [401.5, null, "unknown"],
      [1234567890, null, "unknown"],
    ]) {
      await createWhatsAppSession({});
      const connection = handlers.get("connection.update");
      connection({ connection: "open" });
      connection({
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: code }, message: "private error text" } },
      });
      expect(info.mock.calls.at(-2)).toEqual([
        "[whatsapp]",
        { event: "connection-open", stage: "connected" },
      ]);
      expect(info.mock.calls.at(-1)).toEqual([
        "[whatsapp]",
        { event: "connection-close", stage: "connected", statusCode: expectedCode, reason },
      ]);
    }
    expect(JSON.stringify(info.mock.calls)).not.toContain("private error text");
  });
});

test("DEBUG diagnostics report credential and startup failures without private errors", async () => {
  await withDebug("true", async (info) => {
    const privateError = new Error("private authentication material");
    const onCredentialSaveFailure = mock(() => {});
    await createWhatsAppSession({ onCredentialSaveFailure });
    saveCreds.mockRejectedValueOnce(privateError).mockRejectedValueOnce(privateError);
    await handlers.get("creds.update")();
    await handlers.get("creds.update")();
    expect(
      info.mock.calls.filter(([, record]) => record.event === "credentials-save-failed"),
    ).toHaveLength(1);
    expect(onCredentialSaveFailure).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.at(-1)).toEqual([
      "[whatsapp]",
      { event: "credentials-save-failed", stage: "starting" },
    ]);
    auth.mockRejectedValueOnce(privateError);
    await expect(createWhatsAppSession({})).rejects.toBe(privateError);
    expect(info.mock.calls.at(-1)).toEqual([
      "[whatsapp]",
      { event: "session-start-failed", stage: "starting" },
    ]);
    makeSocket.mockImplementationOnce(() => {
      throw privateError;
    });
    await expect(createWhatsAppSession({})).rejects.toBe(privateError);
    expect(info.mock.calls.at(-1)).toEqual([
      "[whatsapp]",
      { event: "session-start-failed", stage: "starting" },
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toContain(privateError.message);
  });
});

test("commands and consent-approved images continue with zero dashboard subscribers", async () => {
  const root = await mkdtemp(join(tmpdir(), "whatsapp-unattended-processing-"));
  const origin = "http://127.0.0.1:3218";
  const accountJid = "synthetic-owner@s.whatsapp.net";
  const chatJid = "synthetic-contact@s.whatsapp.net";
  const imageBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  const socketEvents = new Map();
  const pingWaiters = new Map();
  const savedWaiters = new Map();
  let pingCount = 0;
  let savedCount = 0;
  let activeSubscribers = 0;
  let manager;

  const socket = {
    ev: { on: (event, handler) => socketEvents.set(event, handler) },
    end: mock(async () => socketEvents.get("connection.update")?.({ connection: "close" })),
    logout: mock(async () => {}),
    sendMessage: mock(async (_jid, content) => {
      if (content.text !== "Pong! Running on Bun 🚀") return;
      pingCount += 1;
      pingWaiters.get(pingCount)?.resolve();
    }),
    user: { id: accountJid },
  };
  const waitForPing = (count) => {
    if (pingCount >= count) return Promise.resolve();
    const gate = Promise.withResolvers();
    pingWaiters.set(count, gate);
    return gate.promise;
  };
  const waitForSaved = (count) => {
    if (savedCount >= count) return Promise.resolve();
    const gate = Promise.withResolvers();
    savedWaiters.set(count, gate);
    return gate.promise;
  };
  const textUpsert = (id) => ({
    type: "notify",
    messages: [
      {
        key: { id, remoteJid: chatJid, fromMe: false },
        message: { conversation: "!ping" },
      },
    ],
  });
  const imageUpsert = (id) => ({
    type: "notify",
    messages: [
      {
        key: { id, remoteJid: chatJid, fromMe: false },
        message: { imageMessage: { mimetype: "image/png" } },
        messageTimestamp: 1_800_000_000,
        pushName: "Synthetic Contact",
      },
    ],
  });

  try {
    const store = new ReceivedImageStore({ root });
    const approval = await store.approveConversation({
      accountJid,
      chatJid,
      displayName: "Synthetic Contact",
    });
    const albumCatalog = new AlbumImageCatalog({ store });
    await albumCatalog.refresh();
    expect(albumCatalog.isConversationApproved(approval.conversationId)).toBe(true);

    const imageReceiver = new ImageReceiver({
      store,
      download: async () => Readable.from([imageBytes]),
      onSaved: () => {
        savedCount += 1;
        savedWaiters.get(savedCount)?.resolve();
      },
      isConversationApproved: (conversationId) =>
        albumCatalog.isConversationApproved(conversationId),
    });
    manager = new SessionController({
      createSession: (options) =>
        createWhatsAppSession(options, {
          loadAuthState: async () => ({
            state: { creds: { registered: false }, keys: {} },
            saveCreds: mock(async () => {}),
          }),
          makeSocket: () => socket,
          loggerFactory: () => ({}),
        }),
      imageReceiver,
      albumService: store,
      albumCatalog,
    });
    const subscribe = manager.subscribe.bind(manager);
    manager.subscribe = (listener) => {
      activeSubscribers += 1;
      const unsubscribe = subscribe(listener);
      let active = true;
      return () => {
        if (active) {
          active = false;
          activeSubscribers -= 1;
        }
        unsubscribe();
      };
    };

    await manager.start();
    socketEvents.get("connection.update")({ connection: "open" });
    expect(manager.getSnapshot().status).toBe("connected");
    expect(activeSubscribers).toBe(0);

    const firstPing = waitForPing(1);
    socketEvents.get("messages.upsert")(textUpsert("zero-subscriber-ping"));
    await firstPing;
    const firstImage = waitForSaved(1);
    socketEvents.get("messages.upsert")(imageUpsert("zero-subscriber-image"));
    await firstImage;
    expect(activeSubscribers).toBe(0);

    const dashboardAuth = createDashboardSessionService("synthetic owner passphrase");
    const dashboardToken = dashboardAuth.createSession();
    const handler = createControlHandler({
      manager,
      mediaStore: store,
      albumCatalog,
      dashboardAuth,
      expectedOrigin: origin,
    });
    const abort = new AbortController();
    const eventResponse = await handler(
      new Request(`${origin}/api/events`, {
        headers: { Cookie: dashboardCookie(dashboardToken) },
        signal: abort.signal,
      }),
    );
    const eventReader = eventResponse.body.getReader();
    await eventReader.read();
    expect(activeSubscribers).toBe(1);
    abort.abort();
    await eventReader.cancel().catch(() => {});
    expect(activeSubscribers).toBe(0);

    const signOut = await handler(
      new Request(`${origin}/api/auth/logout`, {
        method: "POST",
        headers: {
          Cookie: dashboardCookie(dashboardToken),
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(signOut.status).toBe(200);
    expect(socket.logout).not.toHaveBeenCalled();
    expect(manager.getSnapshot().status).toBe("connected");

    const postSignOutPing = waitForPing(2);
    socketEvents.get("messages.upsert")(textUpsert("post-signout-ping"));
    await postSignOutPing;
    const postSignOutImage = waitForSaved(2);
    socketEvents.get("messages.upsert")(imageUpsert("post-signout-image"));
    await postSignOutImage;
    await albumCatalog.refresh();

    const page = await albumCatalog.listPage({ limit: 24 });
    expect(page.items).toHaveLength(2);
    const savedActivity = manager
      .getSnapshot()
      .messages.filter((message) => message.kind === "image");
    expect(savedActivity).toHaveLength(2);
    expect(savedActivity.every((message) => message.albumed)).toBe(true);
    expect(manager.getSnapshot().status).toBe("connected");
    expect(activeSubscribers).toBe(0);
  } finally {
    if (manager) await manager.stopForProcessExit();
    await rm(root, { recursive: true, force: true });
  }
});

test("importing the application entry point does not open a WhatsApp session", async () => {
  const authCalls = auth.mock.calls.length;
  const socketCalls = makeSocket.mock.calls.length;
  await import("@/index.js");
  expect(auth.mock.calls.length).toBe(authCalls);
  expect(makeSocket.mock.calls.length).toBe(socketCalls);
});

test("WHATSAPP_AUTOSTART is enabled only by the exact string true", async () => {
  const { isWhatsAppAutostartEnabled } = await import("@/index.js");
  for (const value of [undefined, "", "false", "0", "TRUE", " true", "true "]) {
    expect(isWhatsAppAutostartEnabled(value)).toBe(false);
  }
  expect(isWhatsAppAutostartEnabled("true")).toBe(true);
});

test("root auth directory is ignored using synthetic paths", () => {
  const result = Bun.spawnSync(
    [
      "git",
      "check-ignore",
      "--no-index",
      "auth_info/synthetic-test.json",
      "auth_info/synthetic-nested/test.json",
    ],
    {
      cwd: new URL("..", import.meta.url).pathname,
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim().split("\n")).toEqual([
    "auth_info/synthetic-test.json",
    "auth_info/synthetic-nested/test.json",
  ]);
});
