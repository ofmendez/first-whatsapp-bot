import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, mock, test } from "bun:test";
import { processUpsert } from "@/src/messages.js";
import { ReceivedImageStore } from "@/src/received-image-store.js";

const accountJid = "owner@s.whatsapp.net";
const chatJid = "contact@s.whatsapp.net";
const optIn = {
  type: "notify",
  messages: [
    {
      key: { remoteJid: chatJid, fromMe: false },
      message: { conversation: "inicia album" },
      pushName: "Contact",
    },
  ],
};

test("approval is committed before a failed confirmation and suppresses sends after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "album-command-restart-"));
  try {
    const store = new ReceivedImageStore({ root });
    const send = mock(async (jid, content) => {
      const folder = await store.ensureConversationFolder({
        accountJid,
        chatJid,
        displayName: "Contact",
      });
      expect(jid).toBe(chatJid);
      expect(content.text).toBe(
        "Álbum iniciado. Las imágenes de esta conversación se incluirán en el álbum.",
      );
      expect(await store.readAlbumApproval(folder)).toMatchObject({
        conversationId: store.getConversationIdentity(accountJid, chatJid).conversationId,
      });
      throw new Error("synthetic confirmation failure");
    });

    await expect(
      processUpsert(optIn, send, { accountJids: [accountJid], albumService: store }),
    ).rejects.toThrow("synthetic confirmation failure");

    const restartedStore = new ReceivedImageStore({ root });
    const retrySend = mock(async () => {});
    await processUpsert(optIn, retrySend, {
      accountJids: [accountJid],
      albumService: restartedStore,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(retrySend).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent duplicate opt-ins reserve and send only one confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "album-command-concurrent-"));
  try {
    const store = new ReceivedImageStore({ root });
    const send = mock(async () => {});
    const onAlbumApproved = mock(() => {});
    const options = {
      accountJids: [accountJid],
      albumService: store,
      onAlbumApproved,
    };

    await Promise.all([processUpsert(optIn, send, options), processUpsert(optIn, send, options)]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(onAlbumApproved).toHaveBeenCalledTimes(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
