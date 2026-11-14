import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
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
const IMAGE_FILENAME_PATTERN = /^image-(\d{1,12})-([a-f0-9]{20})\.(jpg|png|webp|gif|avif)$/;
const ALBUM_RECORD_VERSION = 1;
const IMAGE_METADATA_VERSION = 1;
const MAX_IMAGE_METADATA_BYTES = 64 * 1024;
const MAX_CAPTION_LENGTH = 16_384;
const IMAGE_METADATA_FIELDS = new Set([
  "version",
  "id",
  "filename",
  "timestamp",
  "mimeType",
  "caption",
  "captionOverride",
]);
const ALBUM_RECORD_FIELDS = new Set([
  "version",
  "accountJid",
  "chatJid",
  "conversationId",
  "albumed",
  "approvedAt",
  "confirmationAttemptReserved",
  "confirmationAttemptReservedAt",
]);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function conversationId(accountJid, chatJid) {
  return digest(`album-conversation\0${accountJid}\0${chatJid}`);
}

function validIsoDate(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function messageDate(value) {
  let milliseconds;
  if (typeof value === "string" && value.trim()) {
    milliseconds = Date.parse(value);
  } else if (typeof value === "number") {
    milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
  } else {
    return undefined;
  }
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function effectiveCaption(metadata) {
  if (metadata.captionOverride === null || metadata.captionOverride === undefined) {
    return metadata.caption;
  }
  return metadata.captionOverride || undefined;
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
  #writeMetadataFile;
  #renameMetadataFile;
  #folders = new Map();
  #media = new Map();
  #savedMessages = new Map();
  #approvalLocks = new Map();
  #metadataLocks = new Map();

  constructor({
    root = "./received-images/",
    createMediaId = randomUUID,
    writeStreamFactory = createWriteStream,
    writeMetadataFile = writeFile,
    renameMetadataFile = rename,
  } = {}) {
    this.#root = resolve(root);
    this.#createId = createMediaId;
    this.#writeStreamFactory = writeStreamFactory;
    this.#writeMetadataFile = writeMetadataFile;
    this.#renameMetadataFile = renameMetadataFile;
  }

  getConversationIdentity(accountJid, chatJid) {
    const identity = this.#normalizedIdentity(accountJid, chatJid);
    return { conversationId: conversationId(identity.accountJid, identity.chatJid) };
  }

  #normalizedIdentity(accountJid, chatJid) {
    const normalizedAccount = normalizeJid(accountJid);
    const normalizedChat = normalizeJid(chatJid);
    if (!normalizedAccount.includes("@") || !normalizedChat.includes("@")) {
      throw new Error("Image storage identity is unavailable");
    }
    return { accountJid: normalizedAccount, chatJid: normalizedChat };
  }

  async #folder(accountJid, chatJid, displayName) {
    const identityParts = this.#normalizedIdentity(accountJid, chatJid);
    const normalizedAccount = identityParts.accountJid;
    const normalizedChat = identityParts.chatJid;

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

  async ensureConversationFolder({ accountJid, chatJid, displayName }) {
    return this.#folder(accountJid, chatJid, displayName);
  }

  async listConversationDirectories() {
    let entries;
    try {
      entries = await readdir(this.#root, { withFileTypes: true });
    } catch {
      return [];
    }
    let root;
    try {
      root = await realpath(this.#root);
    } catch {
      return [];
    }

    const directories = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = resolve(this.#root, entry.name);
      const directory = await this.#safeConversationDirectory(candidate);
      if (directory && dirname(directory) === root) directories.push(directory);
    }
    return directories.sort();
  }

  async #withApprovalLock(identity, operation) {
    const previous = this.#approvalLocks.get(identity) ?? Promise.resolve();
    let release;
    const current = new Promise((resolvePromise) => {
      release = resolvePromise;
    });
    this.#approvalLocks.set(identity, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#approvalLocks.get(identity) === current) this.#approvalLocks.delete(identity);
    }
  }

  async #readAlbumRecord(directory, expectedIdentity) {
    const markerPath = resolve(directory, "album.json");
    let metadata;
    try {
      metadata = await lstat(markerPath);
    } catch (error) {
      if (error?.code === "ENOENT") return { exists: false, valid: false };
      return { exists: true, valid: false };
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return { exists: true, valid: false };
    }

    try {
      const root = await realpath(this.#root);
      const realDirectory = await realpath(directory);
      const realMarker = await realpath(markerPath);
      if (
        !realDirectory.startsWith(`${root}${sep}`) ||
        realMarker !== resolve(realDirectory, "album.json")
      ) {
        return { exists: true, valid: false };
      }

      const record = JSON.parse(await readFile(realMarker, "utf8"));
      if (
        !record ||
        typeof record !== "object" ||
        Array.isArray(record) ||
        Object.keys(record).some((key) => !ALBUM_RECORD_FIELDS.has(key))
      ) {
        return { exists: true, valid: false };
      }

      const identity =
        expectedIdentity ?? this.#normalizedIdentity(record.accountJid, record.chatJid);
      const expectedConversationId = conversationId(identity.accountJid, identity.chatJid);
      const hasReservation =
        record.confirmationAttemptReserved === true &&
        validIsoDate(record.confirmationAttemptReservedAt);
      const hasNoReservation =
        record.confirmationAttemptReserved === false &&
        record.confirmationAttemptReservedAt === null;
      const valid =
        record.version === ALBUM_RECORD_VERSION &&
        record.accountJid === identity.accountJid &&
        record.chatJid === identity.chatJid &&
        record.conversationId === expectedConversationId &&
        typeof record.albumed === "boolean" &&
        validIsoDate(record.approvedAt) &&
        (hasReservation || hasNoReservation) &&
        basename(realDirectory).startsWith(folderPrefix(identity.accountJid, identity.chatJid));
      return valid
        ? {
            exists: true,
            valid: true,
            record,
            directory: realDirectory,
          }
        : { exists: true, valid: false };
    } catch {
      return { exists: true, valid: false };
    }
  }

  async readAlbumApproval(directory) {
    const status = await this.#readAlbumRecord(directory);
    if (!status.valid || !status.record.albumed) return undefined;
    return {
      conversationId: status.record.conversationId,
      approvedAt: status.record.approvedAt,
      directory: status.directory,
    };
  }

  async approveConversation({ accountJid, chatJid, displayName }) {
    const identity = this.#normalizedIdentity(accountJid, chatJid);
    const key = `${identity.accountJid}\0${identity.chatJid}`;
    return this.#withApprovalLock(key, async () => {
      const directory = await this.#folder(identity.accountJid, identity.chatJid, displayName);
      const previous = await this.#readAlbumRecord(directory, identity);
      if (previous.exists && !previous.valid) {
        throw new Error("Album approval record is invalid");
      }
      if (previous.valid && previous.record.albumed) {
        return {
          approved: true,
          conversationId: previous.record.conversationId,
          newlyApproved: false,
          shouldConfirm: false,
        };
      }

      const now = new Date().toISOString();
      const confirmationAttemptReserved =
        previous.valid && previous.record.confirmationAttemptReserved;
      const record = {
        version: ALBUM_RECORD_VERSION,
        accountJid: identity.accountJid,
        chatJid: identity.chatJid,
        conversationId: conversationId(identity.accountJid, identity.chatJid),
        albumed: true,
        approvedAt: now,
        confirmationAttemptReserved: true,
        confirmationAttemptReservedAt: confirmationAttemptReserved
          ? previous.record.confirmationAttemptReservedAt
          : now,
      };
      const markerPath = resolve(directory, "album.json");
      const temporary = resolve(directory, `.album.${randomUUID()}.tmp`);
      try {
        await this.#writeMetadataFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
        await this.#renameMetadataFile(temporary, markerPath);
      } catch {
        await rm(temporary, { force: true }).catch(() => {});
        throw new Error("Album approval could not be saved");
      }

      return {
        approved: true,
        conversationId: record.conversationId,
        newlyApproved: true,
        shouldConfirm: !confirmationAttemptReserved,
      };
    });
  }

  async #withMetadataLock(key, operation) {
    const previous = this.#metadataLocks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolvePromise) => {
      release = resolvePromise;
    });
    this.#metadataLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#metadataLocks.get(key) === current) this.#metadataLocks.delete(key);
    }
  }

  async #safeConversationDirectory(directory) {
    try {
      const [root, realDirectory, metadata] = await Promise.all([
        realpath(this.#root),
        realpath(directory),
        lstat(directory),
      ]);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || dirname(realDirectory) !== root) {
        return undefined;
      }
      return realDirectory;
    } catch {
      return undefined;
    }
  }

  #validImageMetadata(value, filename) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !IMAGE_METADATA_FIELDS.has(key))
    ) {
      return undefined;
    }
    const match = IMAGE_FILENAME_PATTERN.exec(filename);
    const timestamp = match && validIsoDate(value.timestamp) ? Date.parse(value.timestamp) : NaN;
    const hasCaption =
      value.caption === undefined ||
      (typeof value.caption === "string" &&
        value.caption.length <= MAX_CAPTION_LENGTH &&
        !value.caption.includes("\0"));
    const hasOverride =
      value.captionOverride === undefined ||
      value.captionOverride === null ||
      (typeof value.captionOverride === "string" &&
        value.captionOverride.length <= MAX_CAPTION_LENGTH &&
        !value.captionOverride.includes("\0"));
    if (
      !match ||
      value.version !== IMAGE_METADATA_VERSION ||
      !UUID_PATTERN.test(value.id) ||
      value.filename !== filename ||
      !validIsoDate(value.timestamp) ||
      String(Math.floor(timestamp / 1000)) !== match[1] ||
      normalizedImageType(value.mimeType) !== value.mimeType ||
      IMAGE_TYPES.get(value.mimeType) !== match[3] ||
      !hasCaption ||
      !hasOverride
    ) {
      return undefined;
    }
    return {
      version: value.version,
      id: value.id,
      filename: value.filename,
      timestamp: value.timestamp,
      mimeType: value.mimeType,
      ...(value.caption !== undefined ? { caption: value.caption } : {}),
      ...(Object.hasOwn(value, "captionOverride")
        ? { captionOverride: value.captionOverride }
        : {}),
    };
  }

  async #loadImageMetadata(directory, filename) {
    if (
      typeof filename !== "string" ||
      basename(filename) !== filename ||
      !IMAGE_FILENAME_PATTERN.test(filename)
    ) {
      return { status: "invalid" };
    }
    const realDirectory = await this.#safeConversationDirectory(directory);
    if (!realDirectory) return { status: "invalid" };

    const originalPath = resolve(realDirectory, filename);
    const metadataPath = resolve(realDirectory, `${filename}.json`);
    try {
      const original = await lstat(originalPath);
      const realOriginal = await realpath(originalPath);
      if (
        !original.isFile() ||
        original.isSymbolicLink() ||
        dirname(realOriginal) !== realDirectory
      ) {
        return { status: "invalid" };
      }
    } catch {
      return { status: "invalid" };
    }

    let metadata;
    try {
      metadata = await lstat(metadataPath);
    } catch (error) {
      return error?.code === "ENOENT" ? { status: "missing" } : { status: "invalid" };
    }
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_IMAGE_METADATA_BYTES
    ) {
      return { status: "invalid" };
    }

    try {
      const realMetadata = await realpath(metadataPath);
      if (dirname(realMetadata) !== realDirectory) return { status: "invalid" };
      const value = JSON.parse(await readFile(realMetadata, "utf8"));
      const record = this.#validImageMetadata(value, filename);
      return record
        ? { status: "valid", record, effectiveCaption: effectiveCaption(record) }
        : { status: "invalid" };
    } catch {
      return { status: "invalid" };
    }
  }

  async readImageMetadata(directory, filename) {
    const result = await this.#loadImageMetadata(directory, filename);
    if (result.status !== "valid") return undefined;
    return { ...result.record, effectiveCaption: result.effectiveCaption };
  }

  async inspectImageMetadata(directory, filename) {
    const result = await this.#loadImageMetadata(directory, filename);
    return result.status === "valid"
      ? {
          status: "valid",
          metadata: { ...result.record, effectiveCaption: result.effectiveCaption },
        }
      : { status: result.status };
  }

  async ensureImageMetadata({ directory, filename, timestamp, mimeType, caption }) {
    const contentType = normalizedImageType(mimeType);
    if (!contentType) return undefined;
    return this.#ensureImageMetadata({
      directory,
      filename,
      timestamp,
      mimeType: contentType,
      caption,
    });
  }

  async #ensureImageMetadata({ directory, filename, timestamp, mimeType, caption }) {
    const key = resolve(directory, filename);
    return this.#withMetadataLock(key, async () => {
      const existing = await this.#loadImageMetadata(directory, filename);
      if (existing.status === "valid") return existing.record;
      if (existing.status === "invalid") return undefined;

      const date = messageDate(timestamp);
      if (!date) return undefined;
      if (
        caption !== undefined &&
        (typeof caption !== "string" ||
          caption.length > MAX_CAPTION_LENGTH ||
          caption.includes("\0"))
      ) {
        return undefined;
      }

      const record = {
        version: IMAGE_METADATA_VERSION,
        id: randomUUID(),
        filename,
        timestamp: date,
        mimeType,
        ...(caption ? { caption } : {}),
      };
      const metadataPath = resolve(directory, `${filename}.json`);
      const temporary = resolve(directory, `.${filename}.${randomUUID()}.tmp`);
      try {
        await this.#writeMetadataFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
        await this.#renameMetadataFile(temporary, metadataPath);
        return record;
      } catch {
        await rm(temporary, { force: true }).catch(() => {});
        return undefined;
      }
    });
  }

  async save({
    accountJid,
    chatJid,
    displayName,
    messageId,
    timestamp,
    mimeType,
    caption,
    stream,
  }) {
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
      caption,
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

  async #writeImage({
    accountJid,
    chatJid,
    displayName,
    timestamp,
    contentType,
    caption,
    key,
    stream,
  }) {
    const directory = await this.#folder(accountJid, chatJid, displayName);
    const extension = IMAGE_TYPES.get(contentType);
    const filename = `image-${timestampPart(timestamp)}-${key.slice(0, 20)}.${extension}`;
    const destination = resolve(directory, filename);
    try {
      const existing = await stat(destination);
      if (!existing.isFile()) throw new Error("Image destination is unavailable");
      const saved = this.#register(destination, contentType);
      const metadata = await this.#ensureImageMetadata({
        directory,
        filename,
        timestamp,
        mimeType: contentType,
        caption,
      });
      return metadata ? { ...saved, imageId: metadata.id } : saved;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const temporary = resolve(directory, `.${filename}.${randomUUID()}.tmp`);
    try {
      await pipeline(stream, this.#writeStreamFactory(temporary, { flags: "wx", mode: 0o600 }));
      await rename(temporary, destination);
      const saved = this.#register(destination, contentType);
      const metadata = await this.#ensureImageMetadata({
        directory,
        filename,
        timestamp,
        mimeType: contentType,
        caption,
      });
      return metadata ? { ...saved, imageId: metadata.id } : saved;
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
