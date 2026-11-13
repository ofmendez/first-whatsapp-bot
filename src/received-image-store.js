import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { normalizeJid } from "@/src/message-feed.js";

const IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"],
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeJidPart(jid) {
  return (
    jid
      .replaceAll("@", "-at-")
      .replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .slice(0, 72) || "unknown"
  );
}

function safeName(value) {
  if (typeof value !== "string") return "unknown-contact";
  const sanitized = Array.from(
    value
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^[._-]+|[._-]+$/g, ""),
  )
    .slice(0, 48)
    .join("");
  return sanitized || "unknown-contact";
}

function folderPrefix(accountJid, chatJid) {
  return `account-${safeJidPart(accountJid)}-${digest(accountJid).slice(0, 12)}--chat-${safeJidPart(chatJid)}-${digest(chatJid).slice(0, 12)}--`;
}

function normalizedImageType(value) {
  if (typeof value !== "string") return undefined;
  const type = value.split(";", 1)[0].trim().toLowerCase();
  return IMAGE_TYPES.has(type) ? type : undefined;
}

function timestampPart(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? String(Math.floor(timestamp / 1000))
    : String(Math.floor(Date.now() / 1000));
}

export class ReceivedImageStore {
  #root;
  #createId;
  #writeStreamFactory;
  #folders = new Map();
  #media = new Map();
  #savedMessages = new Map();

  constructor({
    root = "./received-images/",
    createMediaId = randomUUID,
    writeStreamFactory = createWriteStream,
  } = {}) {
    this.#root = resolve(root);
    this.#createId = createMediaId;
    this.#writeStreamFactory = writeStreamFactory;
  }

  async #folder(accountJid, chatJid, displayName) {
    const normalizedAccount = normalizeJid(accountJid);
    const normalizedChat = normalizeJid(chatJid);
    if (!normalizedAccount.includes("@") || !normalizedChat.includes("@")) {
      throw new Error("Image storage identity is unavailable");
    }

    const identity = `${normalizedAccount}\0${normalizedChat}`;
    let pending = this.#folders.get(identity);
    if (!pending) {
      pending = (async () => {
        await mkdir(this.#root, { recursive: true });
        const prefix = folderPrefix(normalizedAccount, normalizedChat);
        const entries = await readdir(this.#root, { withFileTypes: true });
        const existing = entries.find(
          (entry) => entry.isDirectory() && entry.name.startsWith(prefix),
        );
        if (existing) return resolve(this.#root, existing.name);

        const directory = resolve(this.#root, `${prefix}${safeName(displayName)}`);
        await mkdir(directory, { recursive: false });
        return directory;
      })();
      this.#folders.set(identity, pending);
    }

    try {
      return await pending;
    } catch (error) {
      this.#folders.delete(identity);
      throw error;
    }
  }

  async save({ accountJid, chatJid, displayName, messageId, timestamp, mimeType, stream }) {
    const contentType = normalizedImageType(mimeType);
    if (!contentType || !IMAGE_TYPES.has(contentType)) throw new Error("Unsupported image type");
    if (!stream || typeof stream.pipe !== "function")
      throw new Error("Image stream is unavailable");

    const normalizedAccount = normalizeJid(accountJid);
    const normalizedChat = normalizeJid(chatJid);
    if (!normalizedAccount.includes("@") || !normalizedChat.includes("@")) {
      throw new Error("Image storage identity is unavailable");
    }
    const identity = `${normalizedAccount}\0${normalizedChat}\0${String(messageId ?? randomUUID())}`;
    const key = digest(identity);
    const existing = this.#savedMessages.get(key);
    if (existing) return existing;

    const pending = this.#writeImage({
      accountJid: normalizedAccount,
      chatJid: normalizedChat,
      displayName,
      timestamp,
      contentType,
      key,
      stream,
    });
    this.#savedMessages.set(key, pending);
    try {
      const saved = await pending;
      this.#savedMessages.set(key, saved);
      return saved;
    } catch (error) {
      this.#savedMessages.delete(key);
      throw error;
    }
  }

  async #writeImage({ accountJid, chatJid, displayName, timestamp, contentType, key, stream }) {
    const directory = await this.#folder(accountJid, chatJid, displayName);
    const extension = IMAGE_TYPES.get(contentType);
    const filename = `image-${timestampPart(timestamp)}-${key.slice(0, 20)}.${extension}`;
    const destination = resolve(directory, filename);
    try {
      const existing = await stat(destination);
      if (!existing.isFile()) throw new Error("Image destination is unavailable");
      return this.#register(destination, contentType);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const temporary = resolve(directory, `.${filename}.${randomUUID()}.tmp`);
    try {
      await pipeline(stream, this.#writeStreamFactory(temporary, { flags: "wx", mode: 0o600 }));
      await rename(temporary, destination);
      return this.#register(destination, contentType);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  #register(path, contentType) {
    const mediaId = this.#createId();
    if (typeof mediaId !== "string" || !UUID_PATTERN.test(mediaId) || this.#media.has(mediaId)) {
      throw new Error("Media registration failed");
    }
    const record = { mediaId, path, contentType, previewUrl: `/api/media/${mediaId}` };
    this.#media.set(mediaId, record);
    return { ...record };
  }

  async openMedia(mediaId) {
    if (typeof mediaId !== "string" || !UUID_PATTERN.test(mediaId)) return undefined;
    const record = this.#media.get(mediaId);
    if (!record || !IMAGE_TYPES.has(record.contentType)) return undefined;

    try {
      const root = await realpath(this.#root);
      const path = await realpath(record.path);
      if (path !== root && !path.startsWith(`${root}${sep}`)) return undefined;
      if (!(await stat(path)).isFile()) return undefined;
      return { path, contentType: record.contentType };
    } catch {
      return undefined;
    }
  }
}

export { normalizedImageType };
