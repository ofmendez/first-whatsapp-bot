import { expect, mock, spyOn, test } from "bun:test";

// Mock external facilities before importing application modules: no real auth or sockets.
const handlers = new Map();
const state = { synthetic: true };
const saveCreds = mock(async () => {});
const auth = mock(async () => ({ state, saveCreds }));
const socket = {
  ev: { on: mock((event, handler) => handlers.set(event, handler)) },
  sendMessage: mock(async function () {
    expect(this).toBe(socket);
  }),
};
const makeSocket = mock(() => socket);
const logger = {};
const pino = mock(() => logger);
const generateQR = mock(() => {});

mock.module("@whiskeysockets/baileys", () => ({
  default: makeSocket,
  useMultiFileAuthState: auth,
  DisconnectReason: { loggedOut: 401 },
}));
mock.module("pino", () => ({ default: pino }));
mock.module("qrcode-terminal", () => ({ default: { generate: generateQR } }));

const { replyForCommand } = await import("../src/commands.js");
const { processUpsert } = await import("../src/messages.js");
const { startWhatsApp } = await import("../src/whatsapp.js");
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
  await processUpsert(batch(
    incoming({ extendedTextMessage: { text: "!ping" } }, "extended"),
    incoming({ conversation: null, extendedTextMessage: { text: "!ping" } }, "null"),
    incoming({ conversation: "", extendedTextMessage: { text: "!ping" } }),
    incoming({ conversation: "!unknown", extendedTextMessage: { text: "!ping" } }),
    incoming({ conversation: "!ping", extendedTextMessage: { text: "!unknown" } }, "plain"),
  ), send);
  expect(send.mock.calls).toEqual([["extended", reply], ["null", reply], ["plain", reply]]);
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
  await processUpsert(batch(
    incoming({ conversation: "!ping" }, "self", true),
    incoming({ conversation: "!ping" }, "synthetic@g.us"),
    incoming({ conversation: "!ping" }, null),
    incoming({ conversation: "!ping" }, ""),
    incoming(undefined),
    incoming({}),
    incoming({ conversation: "" }),
    incoming({ conversation: "   " }),
    incoming({ conversation: "!unknown" }),
  ), send);
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
  const processing = processUpsert(batch(
    incoming({ conversation: "!ping" }, "first"),
    incoming({ conversation: "!ping" }, "second"),
  ), send);
  expect(events).toEqual(["start first"]);
  first.resolve();
  await processing;
  expect(events).toEqual(["start first", "end first", "start second", "end second"]);
});

test("send rejection propagates without retry or subsequent sends", async () => {
  const error = new Error("synthetic send failure");
  const send = mock(async () => { throw error; });
  await expect(processUpsert(batch(
    incoming({ conversation: "!ping" }, "first"),
    incoming({ conversation: "!ping" }, "second"),
  ), send)).rejects.toBe(error);
  expect(send.mock.calls).toEqual([["first", reply]]);
});

test("processing emits neither message bodies nor sender identifiers", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    await processUpsert(batch(
      incoming({ conversation: "private synthetic text" }, "private-sender"),
      incoming({ conversation: "!ping" }, "private-sender"),
    ), async () => {});
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("explicit startup wires one socket, persistence, pairing, lifecycle and bound sends", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await startWhatsApp();
    expect(auth.mock.calls).toEqual([["./auth_info"]]);
    expect(pino.mock.calls).toEqual([[{ level: "silent" }]]);
    expect(makeSocket.mock.calls).toEqual([[{
      auth: state, logger, markOnlineOnConnect: false,
    }]]);
    expect([...handlers.keys()]).toEqual(["creds.update", "connection.update", "messages.upsert"]);
    expect(handlers.get("creds.update")).toBe(saveCreds);
    await handlers.get("creds.update")();
    expect(saveCreds).toHaveBeenCalledTimes(1);

    const connection = handlers.get("connection.update");
    connection({ qr: "synthetic-pairing-code" });
    expect(generateQR.mock.calls).toEqual([["synthetic-pairing-code", { small: true }]]);
    connection({ connection: "open" });
    connection({ connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
    connection({ connection: "close", lastDisconnect: { error: { output: { statusCode: 500 } } } });
    connection({ connection: "close" });
    expect(log.mock.calls).toEqual([
      ["WhatsApp connected!"], ["Session logged out"], ["Connection lost"], ["Connection lost"],
    ]);
    expect(makeSocket).toHaveBeenCalledTimes(1);

    const upsert = handlers.get("messages.upsert");
    await upsert({ type: "append", messages: [incoming({ conversation: "!ping" })] });
    expect(socket.sendMessage).not.toHaveBeenCalled();
    await upsert(batch(incoming({ conversation: "!ping" })));
    expect(socket.sendMessage.mock.calls).toEqual([["synthetic@s.whatsapp.net", reply]]);
    const failure = new Error("synthetic event send failure");
    socket.sendMessage.mockRejectedValueOnce(failure);
    await expect(upsert(batch(incoming({ conversation: "!ping" })))).rejects.toBe(failure);
  } finally {
    log.mockRestore();
  }
});

test("entry point reports only a generic startup failure", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  const log = spyOn(console, "log").mockImplementation(() => {});
  auth.mockRejectedValueOnce(new Error("synthetic private credentials and sender"));
  try {
    await import("../index.js");
    await Bun.sleep(0);
    expect(error.mock.calls).toEqual([["WhatsApp startup failed"]]);
    expect(log).not.toHaveBeenCalled();
    expect(makeSocket).toHaveBeenCalledTimes(1);
  } finally {
    error.mockRestore();
    log.mockRestore();
  }
});

test("root auth directory is ignored using synthetic paths", () => {
  const result = Bun.spawnSync(["git", "check-ignore", "--no-index", "auth_info/synthetic-test.json", "auth_info/synthetic-nested/test.json"], {
    cwd: new URL("..", import.meta.url).pathname,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim().split("\n")).toEqual([
    "auth_info/synthetic-test.json", "auth_info/synthetic-nested/test.json",
  ]);
});
