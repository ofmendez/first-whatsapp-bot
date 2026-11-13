import { createHash, randomUUID } from "node:crypto";
import { normalizeJid, projectLiveImages } from "@/src/message-feed.js";
import { normalizedImageType } from "@/src/received-image-store.js";

function messageIdentity(accountJid, image) {
  const messageId =
    typeof image.message?.key?.id === "string" && image.message.key.id
      ? image.message.key.id
      : randomUUID();
  return createHash("sha256")
    .update(`${accountJid}\0${image.remoteJid}\0${messageId}`)
    .digest("hex");
}

export class ImageReceiver {
  #store;
  #download;
  #seen = new Set();

  constructor({ store, download }) {
    if (!store || typeof store.save !== "function")
      throw new TypeError("A received-image store is required");
    if (typeof download !== "function")
      throw new TypeError("A media download function is required");
    this.#store = store;
    this.#download = download;
  }

  async receive(upsert, selfJids, onImage) {
    const images = projectLiveImages(upsert, selfJids);
    if (images.length === 0) return;

    const accountJid = normalizeJid(selfJids?.[0]);
    const pending = [];
    for (const image of images) {
      const identity = messageIdentity(accountJid, image);
      if (this.#seen.has(identity)) continue;
      this.#seen.add(identity);
      pending.push(this.#receiveOne({ image, accountJid, onImage }));
    }
    await Promise.all(pending);
  }

  async #receiveOne({ image, accountJid, onImage }) {
    const event = {
      kind: "image",
      direction: image.direction,
      isSelfChat: image.isSelfChat,
      label: image.label,
      timestamp: image.timestamp,
      ...(image.caption ? { caption: image.caption } : {}),
    };

    try {
      const mimeType = normalizedImageType(image.mimeType);
      if (!accountJid || !mimeType) throw new Error("Image metadata is unavailable");
      const stream = await this.#download(image.message);
      const saved = await this.#store.save({
        accountJid,
        chatJid: image.remoteJid,
        displayName: image.isSelfChat
          ? image.message.pushName || "self"
          : image.message.pushName || "unknown-contact",
        messageId: image.message.key?.id,
        timestamp: image.timestamp,
        mimeType,
        stream,
      });
      event.previewUrl = saved.previewUrl;
      event.unavailable = false;
    } catch {
      event.unavailable = true;
    }

    try {
      onImage?.(event);
    } catch {
      // A panel subscriber must not affect media handling or command processing.
    }
  }
}
