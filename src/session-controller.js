import { MessageFeed, normalizeJid, projectLiveMessageEntries } from "@/src/message-feed.js";

const STARTABLE_STATES = new Set(["stopped", "disconnected", "logged-out"]);
const REVIEW_MESSAGE =
  "The session could not be safely closed. Review the process before trying again.";
const RECOVERY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];
const STABLE_CONNECTION_MS = 60_000;
const RECOVERABLE_REASONS = new Set([
  "connection-lost-or-timed-out",
  "connection-closed",
  "service-unavailable",
  "restart-required",
]);
const KNOWN_CLOSE_REASONS = new Set([
  ...RECOVERABLE_REASONS,
  "logged-out-or-rejected",
  "forbidden",
  "multidevice-mismatch",
  "connection-replaced",
  "bad-session",
  "automatic-pairing-required",
  "socket-termination-uncertain",
  "unknown",
]);
const INTERVENTION_REASONS = new Set([
  "automatic-pairing-required",
  "socket-termination-uncertain",
  "logged-out-or-rejected",
  "forbidden",
  "multidevice-mismatch",
  "connection-replaced",
  "bad-session",
  "unknown-disconnect",
  "registration-missing",
  "saved-auth-malformed",
  "saved-auth-unavailable",
  "startup-failed",
  "credential-save-failed",
  "recovery-exhausted",
  "logout-failed",
  "auth-cleanup-failed",
]);
const TERMINAL_CLOSE_REASONS = new Set([
  "forbidden",
  "multidevice-mismatch",
  "connection-replaced",
  "bad-session",
  "unknown",
]);

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
  #activeAttempt = null;
  #startPromise = null;
  #logoutPromise = null;
  #cancelPromise = null;
  #sendInFlight = false;
  #attempt = 0;
  #retryTimer = null;
  #stableTimer = null;
  #recoveryAttempt = 0;
  #nextRetryAt = null;
  #interventionReason = null;
  #unattendedEnabled = false;
  #clock;
  #shuttingDown = false;
  #status = "stopped";
  #qr = null;
  #reviewMessage = null;
  #selfChatValidation;
  #albumService;
  #albumCatalog;
  #onAlbumApproved;

  constructor({
    createSession,
    clearAuth = async () => {},
    imageReceiver,
    albumService,
    albumCatalog,
    onAlbumApproved,
    messageLimit = 200,
    selfChatValidation = "not-run",
    unattendedEnabled = false,
    clock = {
      now: () => Date.now(),
      setTimeout: (...args) => setTimeout(...args),
      clearTimeout: (timer) => clearTimeout(timer),
    },
  }) {
    if (typeof createSession !== "function") {
      throw new TypeError("A WhatsApp session factory is required");
    }
    this.#createSession = createSession;
    this.#clearAuth = clearAuth;
    this.#imageReceiver = imageReceiver;
    this.#albumService = albumService;
    this.#albumCatalog = albumCatalog;
    this.#onAlbumApproved = onAlbumApproved;
    this.#unattendedEnabled = unattendedEnabled === true;
    this.#clock = clock;
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
      recovery: {
        attempt: this.#recoveryAttempt,
        maxAttempts: RECOVERY_DELAYS_MS.length,
        nextRetryAt: this.#nextRetryAt === null ? null : new Date(this.#nextRetryAt).toISOString(),
        interventionReason: this.#interventionReason,
      },
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

  #setStatus(status, { qr = null, reviewMessage = null, interventionReason } = {}) {
    this.#status = status;
    this.#qr = qr;
    this.#reviewMessage = reviewMessage;
    if (interventionReason !== undefined) this.#interventionReason = interventionReason;
    this.#publishState();
  }

  #isCurrentAttempt(attempt) {
    return this.#activeAttempt === attempt && attempt.generation === this.#attempt;
  }

  #clearRetryTimer() {
    if (this.#retryTimer !== null) this.#clock.clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#nextRetryAt = null;
  }

  #clearStableTimer() {
    if (this.#stableTimer !== null) this.#clock.clearTimeout(this.#stableTimer);
    this.#stableTimer = null;
  }

  #clearRecoveryTimers() {
    this.#clearRetryTimer();
    this.#clearStableTimer();
  }

  #receiveOpen(attempt) {
    if (
      !this.#isCurrentAttempt(attempt) ||
      attempt.closeConfirmed ||
      attempt.closeUncertain ||
      attempt.cancelled ||
      attempt.logoutRequested ||
      this.#shuttingDown ||
      !["starting", "pairing", "connected"].includes(this.#status)
    ) {
      return;
    }

    if (attempt.session) this.#session = attempt.session;
    this.#clearStableTimer();
    this.#setStatus("connected", { interventionReason: null });
    if (!this.#unattendedEnabled) return;

    const generation = attempt.generation;
    this.#stableTimer = this.#clock.setTimeout(() => {
      this.#stableTimer = null;
      if (
        !this.#isCurrentAttempt(attempt) ||
        generation !== this.#attempt ||
        this.#status !== "connected" ||
        attempt.closeConfirmed ||
        this.#shuttingDown
      ) {
        return;
      }
      this.#recoveryAttempt = 0;
      this.#interventionReason = null;
      this.#publishState();
    }, STABLE_CONNECTION_MS);
  }

  #receiveClose(attempt, details = {}) {
    if (!this.#isCurrentAttempt(attempt)) return;

    if (details.closeConfirmed === false) {
      if (!attempt.closeConfirmed) {
        attempt.closeUncertain = true;
        this.#requireIntervention("socket-termination-uncertain", attempt);
      }
      return;
    }
    if (attempt.closeConfirmed) return;

    attempt.closeConfirmed = true;
    attempt.closeUncertain = false;
    const reason =
      typeof details.reason === "string" && KNOWN_CLOSE_REASONS.has(details.reason)
        ? details.reason
        : details.reason === undefined
          ? undefined
          : "unknown";
    attempt.closeReason = reason;
    this.#clearStableTimer();
    if (this.#session === attempt.session) this.#session = null;

    if (
      this.#shuttingDown ||
      ["logging-out", "stopping"].includes(this.#status) ||
      attempt.cancelled ||
      attempt.logoutRequested
    ) {
      return;
    }
    if (
      reason === "automatic-pairing-required" &&
      attempt.automatic &&
      (this.#status !== "review-required" ||
        ["automatic-pairing-required", "socket-termination-uncertain"].includes(
          this.#interventionReason,
        ))
    ) {
      this.#clearRecoveryTimers();
      this.#setStatus("stopped", {
        interventionReason: "automatic-pairing-required",
      });
      return;
    }
    // Preserve an earlier intervention while recording the confirmed cleanup.
    if (this.#status === "review-required") return;

    if (details.loggedOut || reason === "logged-out-or-rejected") {
      this.#feed.clear();
      this.#publish({ type: "clear" });
      this.#clearRecoveryTimers();
      this.#setStatus("logged-out", {
        interventionReason: "logged-out-or-rejected",
      });
      return;
    }

    if (reason && RECOVERABLE_REASONS.has(reason)) {
      if (this.#unattendedEnabled) {
        this.#scheduleRecovery(attempt);
      } else {
        this.#setStatus("disconnected", { interventionReason: null });
      }
      return;
    }

    if (reason === "automatic-pairing-required" || reason === "socket-termination-uncertain") {
      this.#requireIntervention(reason, attempt);
      return;
    }

    if (reason && TERMINAL_CLOSE_REASONS.has(reason)) {
      this.#requireIntervention(reason === "unknown" ? "unknown-disconnect" : reason, attempt);
      return;
    }

    this.#setStatus("disconnected", { interventionReason: null });
  }

  #requireIntervention(reason, attempt, { stopSession = false } = {}) {
    const safeReason = INTERVENTION_REASONS.has(reason) ? reason : "startup-failed";
    this.#clearRecoveryTimers();
    this.#setStatus("review-required", {
      reviewMessage: REVIEW_MESSAGE,
      interventionReason: safeReason,
    });

    if (!stopSession || !attempt) return;
    attempt.stopOnSettlement = true;
    const session = attempt.session ?? this.#session;
    if (session) void this.#terminateForIntervention(attempt, session);
  }

  async #terminateForIntervention(attempt, session) {
    if (attempt.endRequested) return;
    attempt.endRequested = true;
    try {
      await session.end();
      if (this.#isCurrentAttempt(attempt)) {
        const pairingWasBlocked =
          this.#status === "review-required" &&
          this.#interventionReason === "automatic-pairing-required";
        attempt.closeConfirmed = true;
        attempt.closeUncertain = false;
        if (this.#session === session) this.#session = null;
        if (pairingWasBlocked) {
          this.#setStatus("stopped", {
            interventionReason: "automatic-pairing-required",
          });
        }
      }
    } catch {
      if (this.#isCurrentAttempt(attempt)) {
        attempt.closeUncertain = true;
        this.#requireIntervention("socket-termination-uncertain", attempt);
      }
    }
  }

  #receiveCredentialSaveFailure(attempt) {
    if (
      !this.#isCurrentAttempt(attempt) ||
      attempt.closeConfirmed ||
      this.#shuttingDown ||
      ["logging-out", "stopping"].includes(this.#status)
    ) {
      return;
    }
    this.#requireIntervention("credential-save-failed", attempt, { stopSession: true });
  }

  #scheduleRecovery(attempt) {
    if (!this.#unattendedEnabled) {
      this.#setStatus("disconnected", { interventionReason: null });
      return;
    }
    if (this.#retryTimer !== null) return;
    if (this.#recoveryAttempt >= RECOVERY_DELAYS_MS.length) {
      this.#setStatus("disconnected", { interventionReason: "recovery-exhausted" });
      return;
    }

    const retryNumber = ++this.#recoveryAttempt;
    const delay = RECOVERY_DELAYS_MS[retryNumber - 1];
    const expectedGeneration = attempt.generation;
    this.#nextRetryAt = this.#clock.now() + delay;
    this.#setStatus("reconnecting", { interventionReason: null });
    this.#retryTimer = this.#clock.setTimeout(() => {
      this.#retryTimer = null;
      this.#nextRetryAt = null;
      this.#publishState();
      return (async () => {
        const pendingStart = this.#startPromise;
        if (pendingStart) await pendingStart;
        if (
          this.#shuttingDown ||
          !this.#unattendedEnabled ||
          expectedGeneration !== this.#attempt ||
          this.#status !== "reconnecting"
        ) {
          return;
        }
        if (!attempt.closeConfirmed) {
          this.#requireIntervention("socket-termination-uncertain", attempt);
          return;
        }
        await this.#beginSession("recovery");
      })().catch(() => {
        if (expectedGeneration === this.#attempt && this.#status === "reconnecting") {
          this.#requireIntervention("startup-failed", attempt);
        }
      });
    }, delay);
  }

  #handleStartFailure(attempt, error) {
    if (!this.#isCurrentAttempt(attempt)) return;
    this.#session = null;
    this.#clearRecoveryTimers();

    const startErrorCode =
      error?.name === "WhatsAppSessionStartError" &&
      ["registration-missing", "saved-auth-malformed", "saved-auth-unavailable"].includes(
        error.code,
      )
        ? error.code
        : undefined;

    if (startErrorCode === "registration-missing" && attempt.kind === "automatic") {
      this.#setStatus("stopped", { interventionReason: "registration-missing" });
      return;
    }
    if (startErrorCode) {
      this.#requireIntervention(startErrorCode, attempt);
      return;
    }
    this.#requireIntervention("startup-failed", attempt);
  }

  async start() {
    return this.#beginSession("manual");
  }

  async startAutomatically() {
    if (!this.#unattendedEnabled) return this.getSnapshot();
    return this.#beginSession("automatic");
  }

  async #beginSession(kind) {
    if (this.#startPromise || this.#shuttingDown) return this.getSnapshot();
    if (kind === "manual" && !STARTABLE_STATES.has(this.#status)) {
      return this.getSnapshot();
    }
    if (kind === "automatic" && (!this.#unattendedEnabled || this.#status !== "stopped")) {
      return this.getSnapshot();
    }
    if (kind === "recovery" && this.#status !== "reconnecting") return this.getSnapshot();

    if (kind === "manual") {
      this.#clearRecoveryTimers();
      if (this.#interventionReason === "recovery-exhausted") this.#recoveryAttempt = 0;
    } else if (kind === "recovery") {
      this.#clearRetryTimer();
    }
    this.#interventionReason = null;

    const attempt = {
      generation: ++this.#attempt,
      kind,
      automatic: kind !== "manual",
      session: null,
      factorySettled: false,
      closeConfirmed: false,
      closeUncertain: false,
      cancelled: false,
      logoutRequested: false,
      stopOnSettlement: false,
      endRequested: false,
      shutdownRequested: false,
      shutdownCloseStarted: false,
    };
    this.#activeAttempt = attempt;
    this.#session = null;
    this.#setStatus("starting", {
      qr: null,
      reviewMessage: null,
      interventionReason: null,
    });

    const startPromise = (async () => {
      try {
        const session = await this.#createSession({
          savedRegistrationOnly: attempt.automatic,
          onPairing: (qr) => {
            if (!this.#isCurrentAttempt(attempt) || attempt.closeConfirmed) return;
            if (attempt.automatic) {
              this.#requireIntervention("automatic-pairing-required", attempt, {
                stopSession: true,
              });
              return;
            }
            if (["starting", "pairing"].includes(this.#status)) {
              this.#setStatus("pairing", { qr });
            }
          },
          onOpen: () => this.#receiveOpen(attempt),
          onClose: (details) => this.#receiveClose(attempt, details),
          onCredentialSaveFailure: () => this.#receiveCredentialSaveFailure(attempt),
          albumService: this.#albumService,
          onAlbumApproved: (approval) => {
            if (!this.#isCurrentAttempt(attempt) || this.#status !== "connected") return;
            const marked = this.#feed.markConversationAlbumed(approval?.conversationId);
            if (marked.length > 0) this.#publishState();
            try {
              const update = this.#onAlbumApproved?.(approval);
              if (update && typeof update.catch === "function") void update.catch(() => {});
            } catch {
              // Approval is durable even if a transient dashboard update fails.
            }
          },
          onUpsert: (upsert, selfJids) => {
            if (!this.#isCurrentAttempt(attempt) || this.#status !== "connected") return;
            const accountJid = normalizeJid(selfJids?.[0]);
            for (const { message, chatJid } of projectLiveMessageEntries(upsert, selfJids)) {
              let activityMetadata = {};
              try {
                const conversationId = this.#albumService?.getConversationIdentity?.(
                  accountJid,
                  chatJid,
                )?.conversationId;
                if (typeof conversationId === "string") {
                  activityMetadata = {
                    conversationId,
                    albumed: Boolean(this.#albumCatalog?.isConversationApproved?.(conversationId)),
                  };
                }
              } catch {
                // Event visibility does not depend on optional album metadata.
              }
              const appended = this.#feed.append({ ...message, ...activityMetadata });
              this.#publish({ type: "message", message: appended });
            }
            if (this.#imageReceiver) {
              void this.#imageReceiver
                .receive(upsert, selfJids, (image) => {
                  if (!this.#isCurrentAttempt(attempt) || this.#status !== "connected") return;
                  let activityImage = image;
                  if (typeof image.conversationId === "string") {
                    try {
                      activityImage = {
                        ...image,
                        albumed: Boolean(
                          this.#albumCatalog?.isConversationApproved?.(image.conversationId),
                        ),
                      };
                    } catch {
                      // An optional filter lookup must not affect image activity.
                    }
                  }
                  const appended = this.#feed.append(activityImage);
                  this.#publish({ type: "message", message: appended });
                })
                .catch(() => {});
            }
          },
        });
        attempt.factorySettled = true;
        attempt.session = session;

        if (this.#shuttingDown || attempt.shutdownRequested || !this.#isCurrentAttempt(attempt)) {
          if (!attempt.closeConfirmed && !attempt.shutdownCloseStarted) {
            attempt.shutdownCloseStarted = true;
            try {
              await session.end();
            } catch {
              // Shutdown is best-effort and never removes saved credentials.
            }
          }
          return;
        }

        if (!attempt.closeConfirmed && !attempt.closeUncertain) this.#session = session;
        if (attempt.stopOnSettlement) await this.#terminateForIntervention(attempt, session);
      } catch (error) {
        attempt.factorySettled = true;
        if (!this.#isCurrentAttempt(attempt) || this.#shuttingDown) return;
        this.#handleStartFailure(attempt, error);
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

    const attempt = this.#activeAttempt;
    this.#clearRecoveryTimers();
    if (attempt) attempt.cancelled = true;
    const cancelPromise = (async () => {
      this.#setStatus("stopping", { interventionReason: null });
      if (this.#startPromise) await this.#startPromise;
      const session = this.#session ?? attempt?.session;
      if (!session) {
        if (this.#status === "review-required") return this.getSnapshot();
        if (attempt?.closeConfirmed) {
          this.#feed.clear();
          this.#publish({ type: "clear" });
          this.#setStatus("stopped", { interventionReason: null });
          return this.getSnapshot();
        }
        this.#requireIntervention("socket-termination-uncertain", attempt);
        throw new SessionOperationError(REVIEW_MESSAGE, 409);
      }

      try {
        await session.end();
        if (this.#session === session) this.#session = null;
        if (attempt) {
          attempt.closeConfirmed = true;
          attempt.closeUncertain = false;
        }
        this.#feed.clear();
        this.#publish({ type: "clear" });
        this.#setStatus("stopped", { interventionReason: null });
        return this.getSnapshot();
      } catch {
        this.#requireIntervention("socket-termination-uncertain", attempt);
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
    const attempt = this.#activeAttempt;
    this.#clearRecoveryTimers();
    if (attempt) attempt.logoutRequested = true;
    const logoutPromise = (async () => {
      this.#setStatus("logging-out", { interventionReason: null });
      try {
        await session.logout();
        if (this.#session === session) this.#session = null;
        await this.#clearAuth();
        this.#feed.clear();
        this.#publish({ type: "clear" });
        this.#setStatus("stopped", { interventionReason: null });
        return this.getSnapshot();
      } catch {
        this.#requireIntervention("logout-failed", attempt);
        try {
          await session.end();
        } catch {
          this.#requireIntervention("socket-termination-uncertain", attempt);
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
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    this.#clearRecoveryTimers();
    this.clearTransient();
    const attempt = this.#activeAttempt;
    const pendingStart = this.#startPromise;
    const session = this.#session ?? (attempt?.closeConfirmed ? null : attempt?.session);
    if (attempt) {
      attempt.shutdownRequested = true;
      if (session) attempt.shutdownCloseStarted = true;
    }
    this.#session = null;
    this.#attempt += 1;
    this.#activeAttempt = null;
    if (session) {
      try {
        await session.end();
      } catch {
        // Process shutdown is best-effort and never removes local auth state.
      }
    }
    if (pendingStart) {
      try {
        await pendingStart;
      } catch {
        // Start failures are private and do not prevent process shutdown.
      }
    }
  }
}
