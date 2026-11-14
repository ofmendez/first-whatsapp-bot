import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;
const MAX_CURSOR_LENGTH = 512;
const IMAGE_FILENAME_PATTERN = /^image-(\d{1,12})-([a-f0-9]{20})\.(jpg|png|webp|gif|avif)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTENSION_TYPES = new Map([
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
  ["avif", "image/avif"],
]);
const SIGNATURE_BYTES = 16;

export class AlbumPaginationError extends Error {
  constructor() {
    super("Album pagination parameters are invalid.");
    this.name = "AlbumPaginationError";
    this.status = 400;
  }
}

function parseLimit(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9]\d*$/.test(text)) {
    throw new AlbumPaginationError();
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new AlbumPaginationError();
  return Math.min(parsed, MAX_LIMIT);
}

function validIsoDate(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function encodeCursor(record) {
  return Buffer.from(JSON.stringify({ v: 1, timestamp: record.timestamp, id: record.id })).toString(
    "base64url",
  );
}

function decodeCursor(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new AlbumPaginationError();
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new AlbumPaginationError();
    const cursor = JSON.parse(decoded.toString("utf8"));
    if (
      !cursor ||
      typeof cursor !== "object" ||
      Array.isArray(cursor) ||
      Object.keys(cursor).length !== 3 ||
      cursor.v !== 1 ||
      !validIsoDate(cursor.timestamp) ||
      !UUID_PATTERN.test(cursor.id)
    ) {
      throw new AlbumPaginationError();
    }
    return { timestamp: cursor.timestamp, id: cursor.id };
  } catch {
    throw new AlbumPaginationError();
  }
}

function sortDescending(left, right) {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp > right.timestamp ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id > right.id ? -1 : 1;
}

function isAfterCursor(record, cursor) {
  return (
    record.timestamp < cursor.timestamp ||
    (record.timestamp === cursor.timestamp && record.id < cursor.id)
  );
}

function imageTypeFromHeader(header) {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    header.length >= 8 &&
    header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    header.length >= 12 &&
    header.toString("ascii", 0, 4) === "RIFF" &&
    header.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (header.length >= 6 && ["GIF87a", "GIF89a"].includes(header.toString("ascii", 0, 6))) {
    return "image/gif";
  }
  if (
    header.length >= 12 &&
    header.toString("ascii", 4, 8) === "ftyp" &&
    ["avif", "avis"].includes(header.toString("ascii", 8, 12))
  ) {
    return "image/avif";
  }
  return undefined;
}

async function inspectImageFile(directory, filename) {
  if (basename(filename) !== filename || !IMAGE_FILENAME_PATTERN.test(filename)) return undefined;
  try {
    const realDirectory = await realpath(directory);
    const path = resolve(realDirectory, filename);
    const metadata = await lstat(path);
    const realPath = await realpath(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || dirname(realPath) !== realDirectory) {
      return undefined;
    }

    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      const header = Buffer.alloc(SIGNATURE_BYTES);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      return imageTypeFromHeader(header.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

function legacyTimestamp(filename) {
  const match = IMAGE_FILENAME_PATTERN.exec(filename);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export class AlbumImageCatalog {
  #store;
  #records = new Map();
  #approvedConversationIds = new Set();
  #refreshPromise;
  #initialized = false;

  constructor({ store } = {}) {
    if (
      !store ||
      typeof store.listConversationDirectories !== "function" ||
      typeof store.readAlbumApproval !== "function" ||
      typeof store.getAlbumVisibility !== "function" ||
      typeof store.inspectImageMetadata !== "function" ||
      typeof store.ensureImageMetadata !== "function"
    ) {
      throw new TypeError("A received-image store is required for the album catalog");
    }
    this.#store = store;
  }

  async refresh() {
    if (this.#refreshPromise) return this.#refreshPromise;
    const pending = this.#buildCatalog();
    this.#refreshPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.#refreshPromise === pending) this.#refreshPromise = undefined;
    }
  }

  async notifyChanged() {
    return this.refresh();
  }

  markConversationApproved(conversationId) {
    if (typeof conversationId !== "string" || !/^[a-f0-9]{64}$/i.test(conversationId)) {
      return false;
    }
    this.#approvedConversationIds.add(conversationId);
    return true;
  }

  isConversationApproved(conversationId) {
    return typeof conversationId === "string" && this.#approvedConversationIds.has(conversationId);
  }

  async #buildCatalog() {
    const records = new Map();
    const conflicts = new Set();
    const approvedConversationIds = new Set();
    const directories = await this.#store.listConversationDirectories();
    for (const directory of directories) {
      const approval = await this.#store.readAlbumApproval(directory);
      if (!approval) continue;
      approvedConversationIds.add(approval.conversationId);

      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !IMAGE_FILENAME_PATTERN.test(entry.name)) {
          continue;
        }
        const headerType = await inspectImageFile(directory, entry.name);
        if (!headerType) continue;
        const extension = IMAGE_FILENAME_PATTERN.exec(entry.name)?.[3];
        if (EXTENSION_TYPES.get(extension) !== headerType) continue;

        let result = await this.#store.inspectImageMetadata(directory, entry.name);
        if (result.status === "missing") {
          const timestamp = legacyTimestamp(entry.name);
          if (!timestamp) continue;
          await this.#store.ensureImageMetadata({
            directory,
            filename: entry.name,
            timestamp,
            mimeType: headerType,
          });
          result = await this.#store.inspectImageMetadata(directory, entry.name);
        }
        if (result.status !== "valid") continue;
        const metadata = result.metadata;
        if (metadata.mimeType !== headerType) continue;

        const record = {
          id: metadata.id,
          conversationId: approval.conversationId,
          directory,
          filename: entry.name,
          timestamp: metadata.timestamp,
          mimeType: metadata.mimeType,
          effectiveCaption: metadata.effectiveCaption,
        };
        if (conflicts.has(record.id)) continue;
        if (records.has(record.id)) {
          records.delete(record.id);
          conflicts.add(record.id);
          continue;
        }
        records.set(record.id, record);
      }
    }
    this.#records = records;
    this.#approvedConversationIds = approvedConversationIds;
    this.#initialized = true;
    return records.size;
  }

  async #currentRecord(record) {
    const approval = await this.#store.readAlbumApproval(record.directory);
    if (!approval || approval.conversationId !== record.conversationId) return undefined;

    const result = await this.#store.inspectImageMetadata(record.directory, record.filename);
    if (
      result.status !== "valid" ||
      result.metadata.id !== record.id ||
      result.metadata.timestamp !== record.timestamp ||
      result.metadata.mimeType !== record.mimeType
    ) {
      return undefined;
    }
    const headerType = await inspectImageFile(record.directory, record.filename);
    if (headerType !== record.mimeType) return undefined;
    return { ...record, effectiveCaption: result.metadata.effectiveCaption };
  }

  async listPage({ limit, cursor } = {}) {
    const pageLimit = parseLimit(limit);
    const key = cursor === undefined || cursor === null ? undefined : decodeCursor(cursor);
    const visibility = await this.#store.getAlbumVisibility();
    const hiddenConversationIds = new Set(visibility.hiddenConversationIds);
    if (!key) await this.refresh();

    const sorted = [...this.#records.values()].sort(sortDescending);
    const page = [];
    for (const record of sorted) {
      if (key && !isAfterCursor(record, key)) continue;
      if (hiddenConversationIds.has(record.conversationId)) continue;
      const current = await this.#currentRecord(record);
      if (!current) {
        this.#records.delete(record.id);
        continue;
      }
      page.push(current);
      if (page.length > pageLimit) break;
    }

    const hasMore = page.length > pageLimit;
    const selected = page.slice(0, pageLimit);
    return {
      items: selected.map((record) => ({
        id: record.id,
        mediaUrl: `/api/album/media/${record.id}`,
        date: record.timestamp,
        ...(record.effectiveCaption ? { caption: record.effectiveCaption } : {}),
      })),
      nextCursor: hasMore ? encodeCursor(selected.at(-1)) : null,
    };
  }

  async openMedia(id) {
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) return undefined;
    const visibility = await this.#store.getAlbumVisibility();
    const hiddenConversationIds = new Set(visibility.hiddenConversationIds);
    if (!this.#initialized) await this.refresh();
    const record = this.#records.get(id);
    if (!record || hiddenConversationIds.has(record.conversationId)) return undefined;
    const current = await this.#currentRecord(record);
    if (!current) {
      this.#records.delete(id);
      return undefined;
    }
    try {
      const path = resolve(record.directory, record.filename);
      const [realDirectory, realPath, metadata] = await Promise.all([
        realpath(record.directory),
        realpath(path),
        lstat(path),
      ]);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        dirname(realPath) !== realDirectory ||
        (await inspectImageFile(record.directory, record.filename)) !== record.mimeType
      ) {
        return undefined;
      }
      return { path: realPath, contentType: record.mimeType };
    } catch {
      return undefined;
    }
  }
}
