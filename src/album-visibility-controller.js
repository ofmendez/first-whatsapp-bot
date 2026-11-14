const CONVERSATION_ID_PATTERN = /^[a-f0-9]{64}$/;

function normalizeVisibilityList(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.conversations)
  ) {
    throw new Error("The album visibility response is invalid.");
  }

  const seen = new Set();
  const conversations = [];
  for (const conversation of value.conversations) {
    if (
      !conversation ||
      typeof conversation !== "object" ||
      typeof conversation.conversationId !== "string" ||
      !CONVERSATION_ID_PATTERN.test(conversation.conversationId) ||
      seen.has(conversation.conversationId) ||
      typeof conversation.label !== "string" ||
      conversation.label.length === 0 ||
      conversation.label.length > 64 ||
      !Number.isSafeInteger(conversation.imageCount) ||
      conversation.imageCount < 0 ||
      typeof conversation.visible !== "boolean"
    ) {
      throw new Error("The album visibility response is invalid.");
    }
    seen.add(conversation.conversationId);
    conversations.push({
      conversationId: conversation.conversationId,
      label: conversation.label,
      imageCount: conversation.imageCount,
      visible: conversation.visible,
    });
  }
  return { revision: value.revision, conversations };
}

export function createAlbumVisibilityController({
  load: loadVisibility,
  save: saveVisibility,
  onChange = () => {},
} = {}) {
  if (
    typeof loadVisibility !== "function" ||
    typeof saveVisibility !== "function" ||
    typeof onChange !== "function"
  ) {
    throw new TypeError("Album visibility load, save, and change handlers are required.");
  }

  let conversations = [];
  let revision;
  let savedVisibility = new Map();
  let selectedVisibility = new Map();
  let status = "loading";
  let errorPhase;
  let message = "Loading saved visibility…";

  function hasUnsavedChanges() {
    return conversations.some(
      ({ conversationId }) =>
        savedVisibility.get(conversationId) !== selectedVisibility.get(conversationId),
    );
  }

  function getSnapshot() {
    const dirty = hasUnsavedChanges();
    return {
      status,
      errorPhase,
      revision,
      conversations: conversations.map((conversation) => ({
        ...conversation,
        visible: selectedVisibility.get(conversation.conversationId) === true,
      })),
      hasUnsavedChanges: dirty,
      canSave:
        revision !== undefined && dirty && !["loading", "saving", "conflict"].includes(status),
      canReload: status === "conflict" || status === "error",
      reloadLabel: errorPhase === "load" ? "Retry loading" : "Discard edits & reload",
      message,
    };
  }

  function emit() {
    onChange(getSnapshot());
  }

  async function load() {
    status = "loading";
    errorPhase = undefined;
    message = "Loading saved visibility…";
    emit();

    try {
      const result = normalizeVisibilityList(await loadVisibility());
      conversations = result.conversations;
      revision = result.revision;
      savedVisibility = new Map(
        conversations.map(({ conversationId, visible }) => [conversationId, visible]),
      );
      selectedVisibility = new Map(savedVisibility);
      status = "saved";
      message = "Saved visibility settings loaded.";
      errorPhase = undefined;
    } catch {
      status = "error";
      errorPhase = "load";
      message = "Could not load saved visibility. Check the connection and try again.";
    }
    emit();
    return getSnapshot();
  }

  function setVisible(conversationId, visible) {
    if (
      typeof conversationId !== "string" ||
      typeof visible !== "boolean" ||
      !selectedVisibility.has(conversationId) ||
      status === "loading" ||
      status === "saving"
    ) {
      return getSnapshot();
    }

    selectedVisibility.set(conversationId, visible);
    errorPhase = undefined;
    if (hasUnsavedChanges()) {
      status = "unsaved";
      message = "Unsaved changes. Save to apply them.";
    } else {
      status = "saved";
      message = "Changes match saved visibility.";
    }
    emit();
    return getSnapshot();
  }

  async function saveChanges() {
    if (
      revision === undefined ||
      !hasUnsavedChanges() ||
      ["loading", "saving", "conflict"].includes(status)
    ) {
      return getSnapshot();
    }

    const submittedRevision = revision;
    const hiddenConversationIds = conversations
      .filter(({ conversationId }) => selectedVisibility.get(conversationId) !== true)
      .map(({ conversationId }) => conversationId);
    status = "saving";
    errorPhase = undefined;
    message = "Saving visibility…";
    emit();

    try {
      const result = await saveVisibility({
        revision: submittedRevision,
        hiddenConversationIds,
      });
      if (
        !result ||
        !Number.isSafeInteger(result.revision) ||
        result.revision <= submittedRevision
      ) {
        throw new Error("The album visibility save response is invalid.");
      }
      revision = result.revision;
      savedVisibility = new Map(selectedVisibility);
      status = "saved";
      message = "Saved. Subsequent album requests will use this selection.";
    } catch (error) {
      errorPhase = "save";
      if (error?.status === 409) {
        status = "conflict";
        message =
          "Another dashboard tab saved first. Your edits are kept; reload saved settings before saving again.";
      } else {
        status = "error";
        message = "Could not save visibility. Your edits are kept; retry or reload.";
      }
    }
    emit();
    return getSnapshot();
  }

  return {
    getSnapshot,
    load,
    save: saveChanges,
    setVisible,
  };
}
