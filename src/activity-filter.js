const CONVERSATION_ID_PATTERN = /^[a-f0-9]{64}$/i;

export function selectActivityMessages(messages, albumedOnly = false) {
  const ordered = [...messages].sort(
    (left, right) => (Number(left.sequence) || 0) - (Number(right.sequence) || 0),
  );
  if (!albumedOnly) return ordered;
  return ordered.filter(
    (message) =>
      message?.albumed === true &&
      typeof message.conversationId === "string" &&
      CONVERSATION_ID_PATTERN.test(message.conversationId),
  );
}

export function activityCountLabel(count) {
  return `${count} ${count === 1 ? "EVENT" : "EVENTS"}`;
}

export function activityEmptyCopy({ albumedOnly = false, retainedCount = 0 } = {}) {
  if (albumedOnly && retainedCount > 0) {
    return {
      heading: "No albumed activity matches",
      description:
        "Activity is still being collected. Events from albumed conversations will appear here.",
    };
  }
  return {
    heading: "Waiting for a session",
    description:
      "New text and image events appear here while connected. No history is requested or restored.",
  };
}
