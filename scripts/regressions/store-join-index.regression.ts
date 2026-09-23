// A joined select was a nested loop over every (base row, joined row) pair.
// getPreviousOutput joins a chat's agent runs against its messages, so a
// long chat paid rows x messages condition evaluations, each with an object
// spread, on the event loop: about 142 million pairs and ten blocked minutes
// on a 7k-run, 20k-message chat. Joins on an equality now bucket the joined
// table once and probe it per base row; results and their order are the same.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-join-index-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");

const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { and, desc, eq, ne } = await import("../../packages/server/src/db/file-query.js");
const { agentRuns, chats, messages } = await import("../../packages/server/src/db/schema/index.js");

const CHAT = "chat-long";
const MESSAGES = 20_000;
const RUNS = 5_000;
const CONFIG = "config-tracker";
const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();

const db = await createFileNativeDB();
try {
  await db.insert(chats).values({ id: CHAT, name: "long", mode: "roleplay" });
  await db.insert(messages).values(
    Array.from({ length: MESSAGES }, (_, i) => ({
      id: `m-${i}`,
      chatId: CHAT,
      role: i % 2 ? "assistant" : "user",
      content: `message ${i}`,
      activeSwipeIndex: 0,
      createdAt: at(i),
    })),
  );
  const run = (id: string, messageId: string, i: number, extra: Partial<typeof agentRuns.$inferInsert> = {}) => ({
    id,
    agentConfigId: CONFIG,
    chatId: CHAT,
    messageId,
    swipeIndex: 0,
    resultType: "context_injection",
    resultData: `{"i":${i}}`,
    success: "true",
    createdAt: at(i),
    ...extra,
  });
  await db.insert(agentRuns).values([
    ...Array.from({ length: RUNS }, (_, i) => run(`r-${i}`, `m-${i * 4}`, i)),
    // A second run on the same message and a run whose message does not exist.
    run("r-dup", "m-8", RUNS + 1),
    run("r-orphan", "m-missing", RUNS + 2),
    run("r-other-config", "m-12", RUNS + 3, { agentConfigId: "config-other" }),
  ]);

  const started = performance.now();
  const rows = await db
    .select()
    .from(agentRuns)
    .innerJoin(messages, eq(agentRuns.messageId, messages.id))
    .where(
      and(
        eq(agentRuns.agentConfigId, CONFIG),
        eq(agentRuns.chatId, CHAT),
        eq(messages.chatId, CHAT),
        eq(agentRuns.success, "true"),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(agentRuns.createdAt));
  const elapsedMs = performance.now() - started;

  assert.equal(
    rows.length,
    RUNS + 1,
    "every run with a real message joins exactly once, orphan and other config excluded",
  );
  assert.equal(rows[0].agent_runs.id, `r-${RUNS - 1}`, "ordered by message time descending");
  const onM8 = rows.filter((row) => row.messages.id === "m-8").map((row) => row.agent_runs.id);
  assert.deepEqual(onM8, ["r-dup", "r-2"], "two runs on one message both join, newest run first");
  assert.ok(
    rows.every((row) => row.agent_runs.messageId === row.messages.id),
    "join condition holds on every row",
  );
  assert.ok(
    elapsedMs < 5_000,
    `joined select took ${Math.round(elapsedMs)} ms; the nested loop took minutes at this size`,
  );

  // A join with no equality between the two tables still takes the full scan path.
  const scanned = await db
    .select()
    .from(chats)
    .innerJoin(messages, ne(chats.id, messages.id))
    .where(eq(chats.id, CHAT));
  assert.equal(scanned.length, MESSAGES, "non-equality join pairs the chat with every message");

  console.log(`Store join index regression passed: ${rows.length} joined rows in ${Math.round(elapsedMs)} ms.`);
} finally {
  await db._fileStore.close();
  rmSync(dataDir, { recursive: true, force: true });
}
