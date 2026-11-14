export const ALBUM_PAGE_SIZE = 24;

const IMAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CURSOR_LENGTH = 512;

export function formatAlbumDate(value) {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;

  const date = new Date(milliseconds);
  if (date.toISOString() !== value) return undefined;
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function normalizeItem(value, origin) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { id, date, mediaUrl, caption } = value;
  if (typeof id !== "string" || !IMAGE_ID_PATTERN.test(id)) return undefined;
  const dateLabel = formatAlbumDate(date);
  if (!dateLabel || mediaUrl !== `/api/album/media/${id}`) return undefined;

  let safeCaption;
  if (typeof caption === "string" && caption.length > 0 && caption.length <= 16_384) {
    safeCaption = caption;
  }
  return {
    id,
    date,
    dateLabel,
    mediaUrl: new URL(mediaUrl, origin).pathname,
    ...(safeCaption ? { caption: safeCaption } : {}),
  };
}

function validPage(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray(value.items) &&
    (value.nextCursor === null ||
      (typeof value.nextCursor === "string" &&
        value.nextCursor.length > 0 &&
        value.nextCursor.length <= MAX_CURSOR_LENGTH))
  );
}

export function albumPlacement(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError("Gallery placement index must be a non-negative integer");
  }
  return `gallery-${(index % 4) + 1}`;
}

export class AlbumGalleryLoader {
  #request;
  #onItems;
  #onState;
  #onUnauthorized;
  #origin;
  #ids = new Set();
  #seenCursors = new Set();
  #cursor = null;
  #hasMore = true;
  #loaded = false;
  #activeRequest;
  #phase = "idle";

  constructor({
    request = (...args) => globalThis.fetch(...args),
    onItems = () => {},
    onState = () => {},
    onUnauthorized = () => {},
    origin = globalThis.location?.origin ?? "http://localhost",
  } = {}) {
    if (typeof request !== "function") throw new TypeError("An album page requester is required");
    if (typeof onItems !== "function" || typeof onState !== "function") {
      throw new TypeError("Album gallery callbacks must be functions");
    }
    if (typeof onUnauthorized !== "function") {
      throw new TypeError("The album authorization callback must be a function");
    }
    this.#request = request;
    this.#onItems = onItems;
    this.#onState = onState;
    this.#onUnauthorized = onUnauthorized;
    this.#origin = origin;
  }

  get state() {
    return {
      phase: this.#phase,
      hasMore: this.#hasMore,
      loaded: this.#loaded,
      count: this.#ids.size,
      cursor: this.#cursor,
    };
  }

  loadNextPage() {
    if (this.#activeRequest) return this.#activeRequest;
    if (!this.#hasMore) return Promise.resolve(false);

    const cursor = this.#cursor;
    this.#setPhase(this.#loaded ? "loading-more" : "loading-initial");
    const active = this.#loadPage(cursor);
    this.#activeRequest = active;
    return active.finally(() => {
      if (this.#activeRequest === active) this.#activeRequest = undefined;
    });
  }

  #setPhase(phase) {
    this.#phase = phase;
    this.#onState(this.state);
  }

  async #loadPage(cursor) {
    const url = new URL("/api/album/images", this.#origin);
    url.searchParams.set("limit", String(ALBUM_PAGE_SIZE));
    if (cursor !== null) url.searchParams.set("cursor", cursor);

    try {
      const response = await this.#request(`${url.pathname}${url.search}`, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (response.status === 401) {
        this.#hasMore = false;
        this.#setPhase("unauthorized");
        this.#onUnauthorized();
        return false;
      }
      if (!response.ok) throw new Error("Album page request failed");

      const payload = await response.json();
      if (
        !validPage(payload) ||
        (cursor !== null && this.#seenCursors.has(cursor)) ||
        (payload.nextCursor !== null &&
          (payload.nextCursor === cursor || this.#seenCursors.has(payload.nextCursor)))
      ) {
        throw new Error("Album page response is invalid");
      }

      const records = [];
      for (const rawItem of payload.items) {
        const item = normalizeItem(rawItem, this.#origin);
        if (!item || this.#ids.has(item.id)) continue;
        this.#ids.add(item.id);
        records.push(item);
      }
      this.#cursor = payload.nextCursor;
      if (cursor !== null) this.#seenCursors.add(cursor);
      this.#hasMore = payload.nextCursor !== null;
      this.#loaded = true;
      this.#onItems(records);

      if (this.#ids.size === 0 && !this.#hasMore) {
        this.#setPhase("empty");
      } else if (!this.#hasMore) {
        this.#setPhase("end");
      } else {
        this.#setPhase("ready");
      }
      return true;
    } catch {
      this.#setPhase(this.#loaded ? "error-more" : "error-initial");
      return false;
    }
  }
}
