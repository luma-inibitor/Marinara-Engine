// Editing a swipe that is not showing (PATCH /:chatId/messages/:messageId?swipeIndex=N).
//   - The edit lands on that swipe only: the message row and the shown swipe keep their text.
//   - The shown swipe is refused as "active", so the route sends it through updateMessageContent.
//   - A missing swipe or message is null.
//   - A stale raw command copy on the edited swipe is cleared, as updateMessageContent does.
//
// Project imports are DYNAMIC, after the env assignments (see the gallery
// suites for why).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-swipe-edit-target-"));
const storeDir = join(dataDir, "storage");
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = storeDir;

const { createFileNativeDB, encodeShardKey } = await import("../../packages/server/src/db/file-backed-store.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");

const writeShard = (table: string, key: string, rows: unknown[]) => {
  mkdirSync(join(storeDir, "tables", table), { recursive: true });
  writeFileSync(join(storeDir, "tables", table, `${encodeShardKey(key)}.json`), JSON.stringify(rows));
};

writeShard("chats", "c1", [{ id: "c1", name: "c1", mode: "conversation" }]);
writeShard("messages", "c1", [
  {
    id: "m1",
    chatId: "c1",
    role: "assistant",
    content: "shown",
    activeSwipeIndex: 1,
    createdAt: "2026-11-01T10:00:00.000Z",
  },
]);
writeShard("message_swipes", "c1", [
  {
    id: "s0",
    messageId: "m1",
    index: 0,
    content: "first",
    extra: JSON.stringify({ conversationCommandContent: "first [raw]" }),
  },
  { id: "s1", messageId: "m1", index: 1, content: "shown" },
  { id: "s2", messageId: "m1", index: 2, content: "third" },
]);

const db = await createFileNativeDB();
const storage = createChatsStorage(db);
const swipeText = async (index: number) =>
  (await storage.getSwipes("m1")).find((swipe: { index: number }) => swipe.index === index)?.content;

try {
  const edited = await storage.updateInactiveSwipeContent("m1", 2, "third, edited", { authored: true });
  assert.notEqual(edited, null, "an inactive swipe is editable");
  assert.notEqual(edited, "active", "an inactive swipe is not the shown one");
  assert.equal(await swipeText(2), "third, edited", "the edit lands on the targeted swipe");
  assert.equal(await swipeText(1), "shown", "the shown swipe keeps its text");
  assert.equal(await swipeText(0), "first", "other swipes keep their text");
  const message = await storage.getMessage("m1");
  assert.equal(message?.content, "shown", "the message row keeps the shown text");
  assert.equal(message?.activeSwipeIndex, 1, "the shown swipe does not change");

  await storage.updateInactiveSwipeContent("m1", 0, "first, edited");
  const first = (await storage.getSwipes("m1")).find((swipe: { index: number }) => swipe.index === 0);
  assert.equal(first?.content, "first, edited");
  assert.equal(
    JSON.parse(first?.extra ?? "{}").conversationCommandContent,
    null,
    "a stale raw command copy is cleared so the edit reaches the model if the swipe is shown later",
  );

  assert.equal(await storage.updateInactiveSwipeContent("m1", 1, "nope"), "active", "the shown swipe is refused");
  assert.equal(await swipeText(1), "shown", "a refused edit writes nothing");
  assert.equal(await storage.updateInactiveSwipeContent("m1", 9, "nope"), null, "a missing swipe is null");
  assert.equal(await storage.updateInactiveSwipeContent("missing", 0, "nope"), null, "a missing message is null");
} finally {
  await db._fileStore.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("Swipe edit target regressions passed.");
