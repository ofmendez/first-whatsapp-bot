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
  DisconnectReason: { loggedOut: 401 },
}));
mock.module("pino", () => ({ default: pino }));

const { replyForCommand } = await import("@/src/commands.js");
const { processUpsert } = await import("@/src/messages.js");
const { createWhatsAppSession, downloadImageStream } = await import("@/src/whatsapp.js");
const importAuthCalls = auth.mock.calls.length;
const importSocketCalls = makeSocket.mock.calls.length;

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
      text: "Álbum iniciado. Las imágenes de esta conversación se incluirán en el álbum.",
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
  const info = spyOn(console, "info").mockImplementation(() => {});
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
      if (
        content.text ===
        "Álbum iniciado. Las imágenes de esta conversación se incluirán en el álbum."
      ) {
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
          text: "Álbum iniciado. Las imágenes de esta conversación se incluirán en el álbum.",
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
    expect(onClose.mock.calls).toEqual([[{ loggedOut: true }]]);

    const secondSession = await createWhatsAppSession({ onPairing, onOpen, onClose, onUpsert });
    socket.end.mockImplementation(() => handlers.get("connection.update")({ connection: "close" }));
    await secondSession.end();
    expect(onClose.mock.calls.at(-1)).toEqual([{ loggedOut: false }]);

    const failure = new Error("synthetic event send failure");
    socket.sendMessage.mockRejectedValueOnce(failure);
    await expect(secondSession.sendSelf("synthetic failing send")).rejects.toBe(failure);
  } finally {
    log.mockRestore();
    info.mockRestore();
  }
});

test("pairing diagnostics expose only fixed lifecycle labels and safe disconnect codes", async () => {
  const info = spyOn(console, "info").mockImplementation(() => {});
  const privateValue = "private QR / auth key / phone / message";
  try {
    const onPairing = mock(() => {});
    const onClose = mock(() => {});
    await createWhatsAppSession({ onPairing, onClose });
    const connection = handlers.get("connection.update");
    connection({ qr: privateValue, user: privateValue });
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
    // Late library events cannot revive or duplicate diagnostics for a closed socket.
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
    expect(onPairing).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ loggedOut: false });
  } finally {
    info.mockRestore();
  }
});

test("disconnect diagnostics distinguish rejection, timeout, and unknown codes without raw errors", async () => {
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
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
  } finally {
    info.mockRestore();
  }
});

test("credential and startup failures are diagnosed without logging private errors", async () => {
  const info = spyOn(console, "info").mockImplementation(() => {});
  const privateError = new Error("private authentication material");
  try {
    await createWhatsAppSession({});
    saveCreds.mockRejectedValueOnce(privateError).mockRejectedValueOnce(privateError);
    await handlers.get("creds.update")();
    await handlers.get("creds.update")();
    expect(
      info.mock.calls.filter(([, record]) => record.event === "credentials-save-failed"),
    ).toHaveLength(1);
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
  } finally {
    info.mockRestore();
  }
});

test("importing the application entry point does not open a WhatsApp session", async () => {
  const authCalls = auth.mock.calls.length;
  const socketCalls = makeSocket.mock.calls.length;
  await import("@/index.js");
  expect(auth.mock.calls.length).toBe(authCalls);
  expect(makeSocket.mock.calls.length).toBe(socketCalls);
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
