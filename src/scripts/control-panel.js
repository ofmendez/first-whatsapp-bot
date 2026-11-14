import QRCode from "qrcode";
import {
  activityCountLabel,
  activityEmptyCopy,
  selectActivityMessages,
} from "@/src/activity-filter.js";

const byId = (id) => document.getElementById(id);
const startButton = byId("start-button");
const cancelButton = byId("cancel-button");
const logoutButton = byId("logout-button");
const dashboardSignOutButton = byId("dashboard-sign-out-button");
const pairingPanel = byId("pairing-panel");
const pairingQr = byId("pairing-qr");
const reviewPanel = byId("review-panel");
const activityList = byId("activity-list");
const emptyState = byId("empty-state");
const albumedOnly = byId("albumed-only");
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
  stopping: "Cancelling",
  "logging-out": "Logging out",
  disconnected: "Connection lost",
  "logged-out": "Session logged out",
  "review-required": "Review required",
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
await loadState();
if (!redirectingToLogin) connectEvents();
