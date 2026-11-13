import { MessageFeed, projectLiveMessages } from "@/src/message-feed.js";

const STARTABLE_STATES = new Set(["stopped", "disconnected", "logged-out"]);
const REVIEW_MESSAGE =
  "The session could not be safely closed. Review the process before trying again.";

export class SessionOperationError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = "SessionOperationError";
    this.status = status;
  }
}

export class SessionController {
  #createSession;
  #clearAuth;
  #feed;
  #imageReceiver;
  #listeners = new Set();
  #session = null;
  #startPromise = null;
  #logoutPromise = null;
  #cancelPromise = null;
  #sendInFlight = false;
  #attempt = 0;
  #status = "stopped";
  #qr = null;
  #reviewMessage = null;
  #selfChatValidation;

  constructor({
    createSession,
    clearAuth = async () => {},
    imageReceiver,
    messageLimit = 200,
    selfChatValidation = "not-run",
  }) {
    if (typeof createSession !== "function") {
      throw new TypeError("A WhatsApp session factory is required");
    }
    this.#createSession = createSession;
    this.#clearAuth = clearAuth;
    this.#imageReceiver = imageReceiver;
    this.#feed = new MessageFeed(messageLimit);
    this.#selfChatValidation = [
      "not-run",
      "passed",
      "phone-message-not-visible",
      "panel-message-not-visible",
      "both-directions-not-visible",
    ].includes(selfChatValidation)
      ? selfChatValidation
      : "not-run";
  }

  getSnapshot() {
    return {
      status: this.#status,
      qr: this.#qr,
      messages: this.#feed.snapshot(),
      selfChatValidation: this.#selfChatValidation,
      ...(this.#status === "review-required"
        ? { message: this.#reviewMessage ?? REVIEW_MESSAGE }
        : {}),
    };
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #publish(update) {
    for (const listener of this.#listeners) {
      try {
        listener(update);
      } catch {
        // Subscribers are isolated from the WhatsApp event path.
      }
    }
  }

  #publishState() {
    this.#publish({ type: "state", state: this.getSnapshot() });
  }

  #setStatus(status, { qr = null, reviewMessage = null } = {}) {
    this.#status = status;
    this.#qr = qr;
    this.#reviewMessage = reviewMessage;
    this.#publishState();
  }

  #receiveClose(attempt, { loggedOut = false } = {}) {
    if (
      attempt !== this.#attempt ||
      ["logging-out", "stopping", "review-required"].includes(this.#status)
    )
      return;
    this.#session = null;
    if (loggedOut) {
      this.#feed.clear();
      this.#publish({ type: "clear" });
    }
    this.#setStatus(loggedOut ? "logged-out" : "disconnected");
  }

  async start() {
    if (this.#startPromise) return this.getSnapshot();
    if (!STARTABLE_STATES.has(this.#status)) return this.getSnapshot();

    const attempt = ++this.#attempt;
    this.#setStatus("starting");
    const startPromise = (async () => {
      try {
        const session = await this.#createSession({
          onPairing: (qr) => {
            if (attempt === this.#attempt && ["starting", "pairing"].includes(this.#status)) {
              this.#setStatus("pairing", { qr });
            }
          },
          onOpen: () => {
            if (attempt === this.#attempt && this.#status !== "logging-out") {
              this.#setStatus("connected");
            }
          },
          onClose: (details) => this.#receiveClose(attempt, details),
          onUpsert: (upsert, selfJids) => {
            if (attempt !== this.#attempt || this.#status !== "connected") return;
            for (const message of projectLiveMessages(upsert, selfJids)) {
              const appended = this.#feed.append(message);
              this.#publish({ type: "message", message: appended });
            }
            if (this.#imageReceiver) {
              void this.#imageReceiver
                .receive(upsert, selfJids, (image) => {
                  if (attempt !== this.#attempt || this.#status !== "connected") return;
                  const appended = this.#feed.append(image);
                  this.#publish({ type: "message", message: appended });
                })
                .catch(() => {});
            }
          },
        });

        if (
          attempt === this.#attempt &&
          ["starting", "pairing", "connected"].includes(this.#status)
        ) {
          this.#session = session;
        }
      } catch {
        if (attempt === this.#attempt) {
          this.#session = null;
          this.#setStatus("review-required", { reviewMessage: REVIEW_MESSAGE });
        }
      }
    })();
    this.#startPromise = startPromise;
    try {
      await startPromise;
      return this.getSnapshot();
    } finally {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    }
  }

  async cancel() {
    if (this.#cancelPromise) return this.getSnapshot();
    if (!["starting", "pairing"].includes(this.#status)) {
      throw new SessionOperationError("There is no pairing attempt to cancel.");
    }

    const cancelPromise = (async () => {
      if (this.#startPromise) await this.#startPromise;
      const session = this.#session;
      if (!session) {
        if (["starting", "pairing"].includes(this.#status)) {
          this.#setStatus("review-required", { reviewMessage: REVIEW_MESSAGE });
          throw new SessionOperationError(REVIEW_MESSAGE, 409);
        }
        return this.getSnapshot();
      }

      this.#setStatus("stopping");
      try {
        await session.end();
        if (this.#session === session) this.#session = null;
        this.#feed.clear();
        this.#publish({ type: "clear" });
        this.#setStatus("stopped");
        return this.getSnapshot();
      } catch {
        this.#setStatus("review-required", { reviewMessage: REVIEW_MESSAGE });
        throw new SessionOperationError(REVIEW_MESSAGE, 409);
      }
    })();

    this.#cancelPromise = cancelPromise;
    try {
      return await cancelPromise;
    } finally {
      if (this.#cancelPromise === cancelPromise) this.#cancelPromise = null;
    }
  }

  async logout() {
    if (this.#logoutPromise) return this.getSnapshot();
    if (this.#status !== "connected" || !this.#session) {
      throw new SessionOperationError("Log out is available only for a connected session.");
    }

    const session = this.#session;
    const logoutPromise = (async () => {
      this.#setStatus("logging-out");
      try {
        await session.logout();
        if (this.#session === session) this.#session = null;
        await this.#clearAuth();
        this.#feed.clear();
        this.#publish({ type: "clear" });
        this.#setStatus("stopped");
        return this.getSnapshot();
      } catch {
        this.#setStatus("review-required", { reviewMessage: REVIEW_MESSAGE });
        try {
          await session.end();
        } catch {
          // Keep the review-required state and do not permit a replacement socket.
        }
        throw new SessionOperationError(REVIEW_MESSAGE, 409);
      }
    })();

    this.#logoutPromise = logoutPromise;
    try {
      return await logoutPromise;
    } finally {
      if (this.#logoutPromise === logoutPromise) this.#logoutPromise = null;
    }
  }

  async sendSelf(text) {
    if (this.#status !== "connected" || !this.#session) {
      throw new SessionOperationError("Connect a session before sending.");
    }
    if (typeof text !== "string" || !text.trim()) {
      throw new SessionOperationError("Enter a nonempty message.", 400);
    }
    if (this.#sendInFlight) {
      throw new SessionOperationError(
        "A send is already in progress. Wait for its result before sending again.",
      );
    }

    this.#sendInFlight = true;
    try {
      await this.#session.sendSelf(text);
      return { ok: true };
    } catch {
      throw new SessionOperationError("Message could not be sent. No retry was attempted.", 502);
    } finally {
      this.#sendInFlight = false;
    }
  }

  clearTransient() {
    this.#qr = null;
    this.#feed.clear();
    this.#publish({ type: "clear" });
    this.#publishState();
  }

  async stopForProcessExit() {
    this.clearTransient();
    const session = this.#session;
    this.#session = null;
    if (session) {
      try {
        await session.end();
      } catch {
        // Process shutdown is best-effort and never removes local auth state.
      }
    }
  }
}
