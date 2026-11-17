import QRCode from "qrcode";
import {
  activityCountLabel,
  activityEmptyCopy,
  selectActivityMessages,
} from "@/src/activity-filter.js";
import { createAlbumVisibilityController } from "@/src/album-visibility-controller.js";

const byId = (id) => document.getElementById(id);
const startButton = byId("start-button");
const cancelButton = byId("cancel-button");
const logoutButton = byId("logout-button");
const dashboardSignOutButton = byId("dashboard-sign-out-button");
const pairingPanel = byId("pairing-panel");
const pairingQr = byId("pairing-qr");
const reviewPanel = byId("review-panel");
const recoveryPanel = byId("recovery-panel");
const recoveryHeading = byId("recovery-heading");
const recoveryMessage = byId("recovery-message");
const activityList = byId("activity-list");
const emptyState = byId("empty-state");
const albumedOnly = byId("albumed-only");
const albumVisibilityCount = byId("album-visibility-count");
const albumVisibilityFieldset = byId("album-visibility-fieldset");
const albumVisibilityList = byId("album-visibility-list");
const albumVisibilityEmpty = byId("album-visibility-empty");
const albumVisibilityFeedback = byId("album-visibility-feedback");
const albumVisibilityReload = byId("album-visibility-reload");
const albumVisibilitySave = byId("album-visibility-save");
const emptyStateTitle = byId("empty-state-title");
const emptyStateDescription = byId("empty-state-description");
const messageInput = byId("message-input");
const sendButton = byId("send-button");
const messages = new Map();
let currentStatus = "stopped";
let sending = false;
let qrGeneration = 0;
let latestMessageId = null;
let latestMessageSequence = -1;
let socketEvents;
let redirectingToLogin = false;
let albumVisibilityController;
let albumVisibilityListSignature;
const albumVisibilityInputs = new Map();

function redirectToLogin() {
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  socketEvents?.close();
  window.location.replace("/login/");
}

function clearPairingQr() {
  qrGeneration += 1;
  const context = pairingQr.getContext("2d");
  context?.clearRect(0, 0, pairingQr.width, pairingQr.height);
  pairingQr.hidden = true;
}

const stateNames = {
  stopped: "Stopped",
  starting: "Starting",
  pairing: "Pairing",
  connected: "Connected",
  reconnecting: "Reconnecting",
  stopping: "Cancelling",
  "logging-out": "Logging out",
  disconnected: "Connection lost",
  "logged-out": "Session logged out",
  "review-required": "Review required",
};

const recoveryCopy = {
  "automatic-pairing-required":
    "Automatic startup requested pairing. Start a session explicitly to scan a new code.",
  "socket-termination-uncertain":
    "Socket closure could not be confirmed. A replacement session is blocked until review.",
  "logged-out-or-rejected":
    "The saved account is logged out or its credentials were rejected. Start explicitly to pair again.",
  forbidden:
    "WhatsApp rejected the session. Review the account and saved authentication before retrying.",
  "multidevice-mismatch":
    "The saved session needs owner review before another connection can start.",
  "connection-replaced":
    "Another connection replaced this session. Review the account before starting again.",
  "bad-session": "The saved session is invalid. Review authentication before pairing again.",
  "unknown-disconnect": "Recovery stopped because the disconnect reason could not be classified.",
  "registration-missing":
    "No saved registered account was found. Start a session from this panel to pair explicitly.",
  "saved-auth-malformed":
    "Saved authentication is malformed. Review the local auth directory; credentials were not deleted.",
  "saved-auth-unavailable":
    "Saved authentication could not be read. Check service-account access; credentials were not deleted.",
  "startup-failed":
    "Session startup stopped for review. Check the service and saved authentication before retrying.",
  "credential-save-failed":
    "Saving WhatsApp credentials failed. Check storage permissions and available disk space before restarting.",
  "recovery-exhausted":
    "Five replacement attempts were used. Start a session to begin a fresh recovery cycle.",
  "logout-failed":
    "Logout did not complete. Review the session before trying to start another one.",
  "auth-cleanup-failed":
    "Local authentication cleanup failed. Review the auth directory before switching accounts.",
};

const validationCopy = {
  "not-run": "Self-chat event visibility has not been live-validated for this setup.",
  passed:
    "A manual self-chat check passed for this setup. This does not guarantee delivery or historical completeness.",
  "phone-message-not-visible":
    "Live check limitation: phone-authored self-chat events were not emitted to this panel.",
  "panel-message-not-visible":
    "Live check limitation: panel-authored self-chat events were not emitted to this panel.",
  "both-directions-not-visible":
    "Live check limitation: self-chat events were not emitted to this panel in either direction.",
};

function updateClock() {
  const now = new Date();
  byId("local-clock").lastElementChild.textContent = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
}

function markConnectionChanged(status) {
  const marker = byId("connection-change");
  marker.textContent = `UPDATED · ${(stateNames[status] ?? "UNKNOWN").toUpperCase()}`;
  marker.hidden = false;
}

function renderRecovery(state) {
  const recovery = state.recovery && typeof state.recovery === "object" ? state.recovery : {};
  const attempt = Number.isInteger(recovery.attempt)
    ? Math.max(0, Math.min(5, recovery.attempt))
    : 0;
  const maxAttempts =
    Number.isInteger(recovery.maxAttempts) && recovery.maxAttempts > 0
      ? Math.min(5, recovery.maxAttempts)
      : 5;

  if (state.status === "reconnecting") {
    const timestamp =
      typeof recovery.nextRetryAt === "string" ? Date.parse(recovery.nextRetryAt) : Number.NaN;
    const nextRetry = Number.isFinite(timestamp)
      ? new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }).format(new Date(timestamp))
      : null;
    recoveryPanel.dataset.state = "pending";
    recoveryHeading.textContent = "Automatic recovery scheduled";
    recoveryMessage.textContent = nextRetry
      ? `Attempt ${attempt} of ${maxAttempts} · next attempt around ${nextRetry}. The service continues if this dashboard closes.`
      : `Attempt ${attempt} of ${maxAttempts} is waiting for the previous socket to close.`;
    recoveryPanel.hidden = false;
    return;
  }

  if (state.status === "starting" && attempt > 0) {
    recoveryPanel.dataset.state = "pending";
    recoveryHeading.textContent = "Automatic recovery attempt";
    recoveryMessage.textContent = `Attempt ${attempt} of ${maxAttempts} is starting.`;
    recoveryPanel.hidden = false;
    return;
  }

  const reason =
    typeof recovery.interventionReason === "string" &&
    Object.hasOwn(recoveryCopy, recovery.interventionReason)
      ? recovery.interventionReason
      : null;
  if (reason) {
    recoveryPanel.dataset.state = reason === "registration-missing" ? "pending" : "intervention";
    recoveryHeading.textContent =
      reason === "recovery-exhausted"
        ? "Automatic recovery stopped"
        : reason === "registration-missing"
          ? "Pairing is available"
          : "Owner action required";
    recoveryMessage.textContent = recoveryCopy[reason];
    recoveryPanel.hidden = false;
    return;
  }

  recoveryPanel.hidden = true;
  recoveryHeading.textContent = "";
  recoveryMessage.textContent = "";
}

function renderState(state) {
  if (!state || typeof state.status !== "string") return;
  const changed = currentStatus !== state.status;
  currentStatus = state.status;
  byId("connection-status").textContent = stateNames[state.status] ?? "Unknown";
  byId("connection-light").dataset.state = state.status;
  if (changed) markConnectionChanged(state.status);

  const canStart = ["stopped", "disconnected", "logged-out"].includes(state.status);
  startButton.hidden = !canStart;
  startButton.disabled = ["review-required"].includes(state.status);
  cancelButton.hidden = !["starting", "pairing"].includes(state.status);
  cancelButton.disabled = state.status === "starting";
  logoutButton.hidden = !["connected", "pairing", "starting"].includes(state.status);
  logoutButton.disabled = state.status !== "connected";
  messageInput.disabled = state.status !== "connected" || sending;
  sendButton.disabled = state.status !== "connected" || sending;
  pairingPanel.hidden = !state.qr || state.status !== "pairing";
  reviewPanel.hidden = state.status !== "review-required";
  renderRecovery(state);

  if (state.qr && state.status === "pairing") {
    const generation = ++qrGeneration;
    const nextQr = document.createElement("canvas");
    QRCode.toCanvas(nextQr, state.qr, { margin: 1, width: 240 })
      .then(() => {
        if (generation !== qrGeneration || currentStatus !== "pairing") return;
        pairingQr.width = nextQr.width;
        pairingQr.height = nextQr.height;
        pairingQr.getContext("2d")?.drawImage(nextQr, 0, 0);
        pairingQr.hidden = false;
      })
      .catch(() => {
        if (generation !== qrGeneration) return;
        clearPairingQr();
        byId("action-feedback").textContent =
          "The pairing code could not be rendered. Cancel and start a new pairing attempt.";
      });
  } else {
    clearPairingQr();
  }

  if (state.status === "review-required") {
    byId("review-message").textContent =
      state.message ??
      "The session could not be safely closed. Review the process before trying again.";
  }
  byId("self-chat-validation").textContent =
    validationCopy[state.selfChatValidation] ?? validationCopy["not-run"];

  if (Array.isArray(state.messages)) {
    const active = new Set(state.messages.map((message) => String(message.id)));
    const latestSnapshotSequence = state.messages.reduce(
      (latest, message) => Math.max(latest, Number(message.sequence) || 0),
      0,
    );
    for (const id of messages.keys()) {
      if (!active.has(id) && Number(messages.get(id)?.sequence) <= latestSnapshotSequence) {
        messages.delete(id);
      }
    }
    for (const message of state.messages) addMessage(message, false);
    if (["stopped", "logged-out"].includes(state.status) && state.messages.length === 0) {
      messages.clear();
      latestMessageId = null;
      latestMessageSequence = -1;
    } else if (!messages.has(String(latestMessageId))) {
      const latest = [...messages.values()].sort((a, b) => a.sequence - b.sequence).at(-1);
      latestMessageId = latest ? String(latest.id) : null;
      latestMessageSequence = latest ? Number(latest.sequence) || 0 : -1;
    }
    renderMessages();
  }
}

function addMessage(message, announce = true) {
  const isImage = message?.kind === "image";
  if (!message || message.id == null || (!isImage && typeof message.text !== "string")) return;
  const id = String(message.id);
  messages.set(id, message);
  const sequence = Number(message.sequence) || 0;
  if (sequence >= latestMessageSequence) {
    latestMessageId = id;
    latestMessageSequence = sequence;
  }
  if (announce) renderMessages(id);
}

function renderMessages(newestId) {
  if (newestId != null) {
    latestMessageId = String(newestId);
    latestMessageSequence =
      Number(messages.get(latestMessageId)?.sequence) || latestMessageSequence;
  }
  const sorted = selectActivityMessages(messages.values(), albumedOnly.checked);
  activityList.replaceChildren();
  if (sorted.length === 0) {
    const copy = activityEmptyCopy({
      albumedOnly: albumedOnly.checked,
      retainedCount: messages.size,
    });
    emptyStateTitle.textContent = copy.heading;
    emptyStateDescription.textContent = copy.description;
    activityList.append(emptyState);
    emptyState.hidden = false;
  } else {
    emptyState.hidden = true;
    for (const message of sorted) {
      const row = document.createElement("article");
      row.className =
        "message-row border-b border-[#e0e6e7] px-6 py-3.75 max-mobile:px-4.25 max-mobile:py-3.5";
      if (String(message.id) === latestMessageId) row.classList.add("message-row-new");
      row.dataset.direction = message.direction === "outgoing" ? "outgoing" : "incoming";

      const meta = document.createElement("div");
      meta.className = "message-meta flex min-w-0 items-baseline gap-3";
      const label = document.createElement("strong");
      label.className = "truncate";
      label.textContent = message.label || "Direct chat";
      const direction = document.createElement("span");
      direction.textContent = message.direction === "outgoing" ? "SENT" : "RECEIVED";
      const isNewest = String(message.id) === latestMessageId;
      const marker = document.createElement("span");
      marker.className = "message-new-mark";
      marker.textContent = "NEW";
      const time = document.createElement("time");
      time.className = "ml-auto whitespace-nowrap";
      const date = new Date(message.timestamp);
      time.dateTime = Number.isNaN(date.getTime()) ? "" : date.toISOString();
      time.textContent = Number.isNaN(date.getTime())
        ? "—"
        : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
      meta.append(label, direction);
      if (isNewest) meta.append(marker);
      meta.append(time);

      row.append(meta);
      if (message.kind === "image") {
        const preview = document.createElement("div");
        preview.className = "message-preview-frame";
        const previewUrl =
          typeof message.previewUrl === "string" &&
          /^\/api\/media\/[0-9a-f-]{36}$/i.test(message.previewUrl)
            ? message.previewUrl
            : undefined;
        if (previewUrl && !message.unavailable) {
          const image = document.createElement("img");
          image.className = "message-preview";
          image.src = previewUrl;
          image.alt = "Received image preview";
          image.loading = "lazy";
          image.decoding = "async";
          image.addEventListener(
            "error",
            () => {
              preview.replaceChildren(createImageUnavailable());
            },
            { once: true },
          );
          preview.append(image);
        } else {
          preview.append(createImageUnavailable());
        }
        row.append(preview);
        if (typeof message.caption === "string" && message.caption) {
          const caption = document.createElement("p");
          caption.className = "message-body message-caption mt-2";
          caption.textContent = message.caption;
          row.append(caption);
        }
      } else {
        const body = document.createElement("p");
        body.className = "message-body mt-1.75";
        body.textContent = message.text;
        row.append(body);
      }
      activityList.append(row);
    }
  }
  byId("activity-count").textContent = activityCountLabel(sorted.length);
}

function renderAlbumVisibility(snapshot) {
  const conversations = snapshot.conversations;
  const signature = JSON.stringify(
    conversations.map(({ conversationId, label, imageCount }) => [
      conversationId,
      label,
      imageCount,
    ]),
  );
  if (signature !== albumVisibilityListSignature) {
    albumVisibilityList.replaceChildren();
    albumVisibilityInputs.clear();
    for (const conversation of conversations) {
      const option = document.createElement("label");
      option.className =
        "album-visibility-option flex min-h-16 cursor-pointer items-center gap-3 px-3.5 py-3";

      const checkbox = document.createElement("input");
      checkbox.className = "size-4 shrink-0 accent-brand";
      checkbox.type = "checkbox";
      checkbox.id = `album-visibility-${conversation.conversationId}`;
      checkbox.dataset.conversationId = conversation.conversationId;
      checkbox.setAttribute("aria-describedby", "album-visibility-help");
      checkbox.addEventListener("change", () => {
        albumVisibilityController.setVisible(conversation.conversationId, checkbox.checked);
      });

      const copy = document.createElement("span");
      copy.className = "flex min-w-0 flex-1 items-center justify-between gap-3";
      const name = document.createElement("strong");
      name.className = "min-w-0 truncate text-sm font-semibold text-ink";
      name.textContent = conversation.label;
      const count = document.createElement("span");
      count.className = "album-visibility-option-count shrink-0 text-right text-[11px] text-muted";
      count.textContent = `${conversation.imageCount} ${conversation.imageCount === 1 ? "image" : "images"}`;

      option.htmlFor = checkbox.id;
      option.append(checkbox, name, count);
      albumVisibilityList.append(option);
      albumVisibilityInputs.set(conversation.conversationId, checkbox);
    }
    albumVisibilityListSignature = signature;
  }

  for (const conversation of conversations) {
    const checkbox = albumVisibilityInputs.get(conversation.conversationId);
    if (!checkbox) continue;
    checkbox.checked = conversation.visible;
    checkbox.disabled = snapshot.status === "loading" || snapshot.status === "saving";
    checkbox.parentElement.dataset.visible = String(conversation.visible);
  }

  const loaded = snapshot.revision !== undefined;
  const count = conversations.length;
  albumVisibilityCount.textContent = loaded
    ? `${count} APPROVED CONVERSATION${count === 1 ? "" : "S"}`
    : snapshot.status === "loading"
      ? "Loading approvals…"
      : "Approvals unavailable";
  albumVisibilityFieldset.disabled =
    !loaded || snapshot.status === "loading" || snapshot.status === "saving";
  albumVisibilityEmpty.hidden = !loaded || count > 0;
  albumVisibilityFeedback.textContent = snapshot.message;
  albumVisibilityFeedback.dataset.state = snapshot.status;
  albumVisibilitySave.disabled = !snapshot.canSave;
  albumVisibilitySave.textContent = snapshot.status === "saving" ? "Saving…" : "Save visibility";
  albumVisibilityReload.hidden = !snapshot.canReload;
  albumVisibilityReload.disabled = snapshot.status === "loading" || snapshot.status === "saving";
  albumVisibilityReload.textContent = snapshot.reloadLabel;
}

function createImageUnavailable() {
  const placeholder = document.createElement("p");
  placeholder.className = "image-unavailable";
  placeholder.setAttribute("role", "status");
  placeholder.textContent = "Image unavailable.";
  return placeholder;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) {
    redirectToLogin();
    throw new Error("Your dashboard session has ended.");
  }
  if (!response.ok)
    throw new Error(result.error || "Request failed. Review the session state and try again.");
  return result;
}

async function loadAlbumVisibility() {
  const response = await fetch("/api/album/conversations", {
    credentials: "same-origin",
    cache: "no-store",
  });
  return readVisibilityResponse(response);
}

async function saveAlbumVisibility(payload) {
  const response = await fetch("/api/album/visibility", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readVisibilityResponse(response);
}

async function readVisibilityResponse(response) {
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) {
    redirectToLogin();
    const error = new Error("Your dashboard session has ended.");
    error.status = 401;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(result.error || "Album visibility request failed.");
    error.status = response.status;
    throw error;
  }
  return result;
}

albumVisibilityController = createAlbumVisibilityController({
  load: loadAlbumVisibility,
  save: saveAlbumVisibility,
  onChange: renderAlbumVisibility,
});

albumVisibilitySave.addEventListener("click", () => albumVisibilityController.save());
albumVisibilityReload.addEventListener("click", () => albumVisibilityController.load());

dashboardSignOutButton.addEventListener("click", async () => {
  dashboardSignOutButton.disabled = true;
  try {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error();
    socketEvents?.close();
    window.location.replace("/login/");
  } catch {
    dashboardSignOutButton.disabled = false;
    byId("action-feedback").textContent =
      "Dashboard sign-out could not be completed. Check the connection and try again.";
  }
});

albumedOnly.addEventListener("change", () => renderMessages());

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  byId("action-feedback").textContent = "Starting a session…";
  try {
    const result = await api("/api/session/start");
    renderState(result.state);
    byId("action-feedback").textContent = "";
  } catch (error) {
    startButton.disabled = !["stopped", "disconnected", "logged-out"].includes(currentStatus);
    byId("action-feedback").textContent = error.message;
  }
});

cancelButton.addEventListener("click", async () => {
  cancelButton.disabled = true;
  byId("action-feedback").textContent = "Cancelling pairing…";
  try {
    const result = await api("/api/session/cancel");
    renderState(result.state);
    byId("action-feedback").textContent = "Pairing cancelled. You can start a new attempt.";
  } catch (error) {
    cancelButton.disabled = !["starting", "pairing"].includes(currentStatus);
    byId("action-feedback").textContent = error.message;
  }
});

logoutButton.addEventListener("click", async () => {
  if (
    !window.confirm(
      "Log out this WhatsApp account? Local authentication will be removed after logout completes.",
    )
  )
    return;
  logoutButton.disabled = true;
  byId("action-feedback").textContent = "Logging out. Keep this page open until the session ends…";
  try {
    const result = await api("/api/session/logout");
    renderState(result.state);
    byId("action-feedback").textContent = "Logged out. A new account can now be paired.";
  } catch (error) {
    byId("action-feedback").textContent = error.message;
    const result = await fetch("/api/state", { credentials: "same-origin" })
      .then((response) => response.json())
      .catch(() => null);
    if (result?.state) renderState(result.state);
  }
});

byId("send-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (sending) return;
  const text = messageInput.value;
  if (!text.trim()) {
    byId("send-result").textContent = "Enter a message before sending.";
    return;
  }
  sending = true;
  messageInput.disabled = true;
  sendButton.disabled = true;
  byId("send-result").textContent = "Sending once to your own chat…";
  try {
    await api("/api/messages/send", { text });
    messageInput.value = "";
    byId("send-result").textContent = "Sent. Waiting for the live event to appear.";
  } catch (error) {
    byId("send-result").textContent = error.message;
  } finally {
    sending = false;
    messageInput.disabled = currentStatus !== "connected";
    sendButton.disabled = currentStatus !== "connected";
  }
});

async function loadState() {
  try {
    const response = await fetch("/api/state", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) {
      redirectToLogin();
      return;
    }
    if (!response.ok) throw new Error();
    const result = await response.json();
    renderState(result.state);
    byId("connection-status").textContent = stateNames[currentStatus] ?? "Stopped";
  } catch {
    byId("connection-status").textContent = "Panel unavailable";
    byId("action-feedback").textContent =
      "The local control service could not be reached. Restart the application and reload.";
  }
}

function connectEvents() {
  socketEvents?.close();
  socketEvents = new EventSource("/api/events", { withCredentials: true });
  socketEvents.addEventListener("update", (event) => {
    let update;
    try {
      update = JSON.parse(event.data);
    } catch {
      return;
    }
    if (update.type === "state") renderState(update.state);
    if (update.type === "message") addMessage(update.message);
    if (update.type === "clear") {
      messages.clear();
      latestMessageId = null;
      latestMessageSequence = -1;
      renderMessages();
    }
  });
  socketEvents.onerror = async () => {
    const response = await fetch("/api/state", {
      credentials: "same-origin",
      cache: "no-store",
    }).catch(() => null);
    if (response?.status === 401) {
      redirectToLogin();
      return;
    }
    byId("action-feedback").textContent =
      "Live updates are reconnecting. The session state remains available.";
  };
  socketEvents.onopen = () => {
    if (byId("action-feedback").textContent.startsWith("Live updates are reconnecting")) {
      byId("action-feedback").textContent = "";
    }
  };
}

updateClock();
setInterval(updateClock, 60_000);
await Promise.all([loadState(), albumVisibilityController.load()]);
if (!redirectingToLogin) connectEvents();
