// regression-layout: source-path the last check reads the generate route to catch a fork rebase that drops its call to the sweep.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GENERATION_RECORDS_KEPT_PER_ROLE,
  generationRecordClearPatch,
  messagesPastRecordWindow,
  pruneStaleGenerationRecords,
  type GenerationRecordStorage,
} from "../../../packages/server/src/routes/generate/prune-generation-records.js";

// A long roleplay chat kept the full prompt and the memory snapshot on every impersonated (user-role) turn, because
// the pruning only looked at assistant messages: 816 such turns made a 716 MB chat out of 7 MB of story.

const prompt = [{ role: "system", content: "x".repeat(50) }];
const snapshot = { audienceCharacterIds: [], prepared: { receipt: "r" } };
const generated = () => JSON.stringify({ cachedPrompt: prompt, advancedMemorySnapshot: snapshot, thinking: "t" });

// --- clear patch: only the record keys that are present, and nothing else ---
assert.equal(generationRecordClearPatch(JSON.stringify({ thinking: "t" })), null);
assert.equal(generationRecordClearPatch(JSON.stringify({ cachedPrompt: null, advancedMemorySnapshot: null })), null);
assert.equal(generationRecordClearPatch("not json"), null);
assert.equal(generationRecordClearPatch(null), null);
assert.deepEqual(generationRecordClearPatch(generated()), { cachedPrompt: null, advancedMemorySnapshot: null });
assert.deepEqual(generationRecordClearPatch(JSON.stringify({ cachedPrompt: prompt })), { cachedPrompt: null });
assert.deepEqual(generationRecordClearPatch({ advancedMemorySnapshot: snapshot }), { advancedMemorySnapshot: null });

// --- window: the newest messages of each role keep their records ---
type Message = { id: string; role: string; extra: string };
const roles = ["user", "assistant", "user", "assistant", "narrator", "user", "assistant", "user", "assistant"];
const messages: Message[] = roles.map((role, index) => ({ id: `m${index}`, role, extra: generated() }));
assert.equal(GENERATION_RECORDS_KEPT_PER_ROLE, 2);
assert.deepEqual(
  messagesPastRecordWindow(messages).map((m) => m.id),
  ["m0", "m1", "m2", "m3"],
  "user and assistant messages past their newest two are stale; the only narrator message is kept",
);

// --- prune: messages past the window and all their swipes, in place, nothing else ---
const swipes = new Map<string, Array<{ index: number; extra: string }>>(
  messages.map((m) => [
    m.id,
    [
      { index: 0, extra: m.extra },
      { index: 1, extra: generated() },
      { index: 2, extra: JSON.stringify({ thinking: "plain" }) },
    ],
  ]),
);
const merge = (extra: string, partial: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(extra), ...partial });
const writes: string[] = [];
const storage: GenerationRecordStorage = {
  listMessages: async () => messages,
  updateMessageExtra: async (id, partial) => {
    writes.push(`message ${id}`);
    const message = messages.find((m) => m.id === id)!;
    message.extra = merge(message.extra, partial);
  },
  getSwipes: async (messageId) => swipes.get(messageId) ?? [],
  updateSwipeExtra: async (messageId, index, partial) => {
    writes.push(`swipe ${messageId}/${index}`);
    const swipe = swipes.get(messageId)!.find((s) => s.index === index)!;
    swipe.extra = merge(swipe.extra, partial);
  },
};

assert.equal(await pruneStaleGenerationRecords(storage, "chat"), 4);
for (const message of messages) {
  const extra = JSON.parse(message.extra);
  const stale = ["m0", "m1", "m2", "m3"].includes(message.id);
  assert.equal(extra.cachedPrompt, stale ? null : extra.cachedPrompt, `${message.id} cachedPrompt`);
  if (!stale) assert.ok(Array.isArray(extra.cachedPrompt) && extra.advancedMemorySnapshot, `${message.id} keeps both`);
  else assert.equal(extra.advancedMemorySnapshot, null, `${message.id} advancedMemorySnapshot`);
  assert.equal(extra.thinking, "t", "other extras are untouched");
  for (const swipe of swipes.get(message.id)!) {
    const swipeExtra = JSON.parse(swipe.extra);
    if (stale) assert.equal(generationRecordClearPatch(swipe.extra), null, `${message.id}/${swipe.index} cleared`);
    if (swipe.index === 2) assert.deepEqual(swipeExtra, { thinking: "plain" }, "a swipe with no records is not written");
  }
}
assert.ok(!writes.includes("swipe m0/2"));

// A second turn finds nothing left to clear and writes nothing.
writes.length = 0;
assert.equal(await pruneStaleGenerationRecords(storage, "chat"), 0);
assert.deepEqual(writes, []);

// --- the generate route calls it after every saved message, not the old assistant-only loop ---
const route = readFileSync(new URL("../../../packages/server/src/routes/generate.routes.ts", import.meta.url), "utf8");
assert.match(route, /await pruneStaleGenerationRecords\(chats, input\.chatId\);/);
assert.doesNotMatch(route, /filter\(\(m\) => m\.role === "assistant"\)\.slice\(0, -2\)/);

console.log("Generation record pruning regression passed.");
