export function replyForCommand(text) {
  if (text.trim().toLowerCase() === "!ping") {
    return "Pong! Running on Bun 🚀";
  }
}
