import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A 971-message chat froze the server for over a minute after each reply: every memory write re-read the
// chat and parsed every message's stored extras again (megabytes of cached prompts), without letting other
// requests run. A preparation run now parses each unchanged extra once and gives the event loop a turn per write.
const directory = mkdtempSync(join(tmpdir(), "marinara-run-stalls-"));
process.env.DATA_DIR = directory;
process.env.FILE_STORAGE_DIR = join(directory, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.MARINARA_LITE = "true";

const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  response.setHeader("content-type", "application/json");
  if (request.url === "/v1/systemone") {
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([id, value]) => {
        const message = body.state.transcript?.find((item: { messageId: string }) => item.messageId === id);
        const cut = (value as { instructions: string }).instructions.includes("cut to a new scene");
        return [id, { type: "noul", noul: cut && message?.content.startsWith("SCENE_CHANGE") ? 0.99 : 0.01 }];
      }),
    );
    response.end(JSON.stringify({ answers }));
    return;
  }
  response.end(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({ audience: "all", summary: "Mari and Kaito talked about work." }),
          },
          finish_reason: "stop",
        },
      ],
    }),
  );
});

const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createAdvancedMemoryService } = await import("../../packages/server/src/services/advanced-memory.js");
const db = await createFileNativeDB();
const chats = createChatsStorage(db);
const connections = createConnectionsStorage(db);
const memory = createAdvancedMemoryService(db);

try {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const helper = await connections.create({
    name: "Summary helper",
    provider: "custom",
    baseUrl: `${base}/v1`,
    model: "summary",
    apiKey: "fixture",
    maxContext: 65000,
  });
  const decision = await connections.create({
    name: "Jev",
    provider: "decision",
    decisionSource: "custom",
    baseUrl: base,
    model: "jev-latest",
    apiKey: "",
    maxStateTokens: 30000,
  });
  const chat = await chats.create({
    name: "Long chat",
    mode: "roleplay",
    characterIds: ["kaito"],
    connectionId: helper.id,
  });
  assert(chat);
  await memory.updateSettings(chat.id, {
    enabled: true,
    decisionEnabled: true,
    decisionConnectionId: decision.id,
    knowledgeStarts: { kaito: null },
    knowledgeConfirmed: true,
  });
  const scenes = 20;
  const cachedPrompt = "prompt ".repeat(2000);
  await chats.createMessagesBatch(chat.id, [
    ...Array.from({ length: scenes }, (_, index) => [
      { role: "user" as const, content: `SCENE_CHANGE Mari and Kaito meet at home on day ${index}.` },
      {
        role: "assistant" as const,
        characterId: "kaito",
        content: `Kaito tells Mari about day ${index} at work.`,
        extra: { cachedPrompt },
      },
      { role: "user" as const, content: "Mari thanks Kaito, and they talk for a while." },
    ]).flat(),
    // Generation records sit beside the flags memory reads; dropping one from the cached copy must keep the other.
    {
      role: "user",
      content: "SCENE_CHANGE Mari comes home late.",
      extra: { isConversationStart: true, cachedPrompt },
    },
    { role: "assistant", characterId: "kaito", content: "Kaito waves from the kitchen.", extra: { cachedPrompt } },
  ]);
  await memory.initialize(chat.id);

  const parse = JSON.parse;
  let extraParses = 0;
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (typeof text === "string" && text.includes(cachedPrompt)) extraParses++;
    return parse(text, reviver);
  }) as typeof JSON.parse;
  let turns = 0;
  let running = true;
  const tick = () => {
    turns++;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  try {
    await memory.initialize(chat.id, { detectScenes: false, closedOnly: true, blocking: false });
  } finally {
    running = false;
    JSON.parse = parse;
  }
  assert.equal(
    extraParses,
    0,
    "a later run reuses the extras an earlier read parsed, instead of parsing them per write",
  );
  assert.ok(
    turns >= scenes,
    `other requests must get a turn while scenes are checked: ${turns} turns for ${scenes} scenes`,
  );
  const messages = await chats.listMessages(chat.id);
  const prepared = await memory.prepare({
    chatId: chat.id,
    messages,
    audienceCharacterIds: ["kaito"],
    budgetTokens: 50000,
  });
  assert.deepEqual(
    prepared.messageIds,
    messages.slice(-2).map((message) => message.id),
    "the conversation start stored beside a cached prompt still starts the live context",
  );
  console.log("advanced memory run stalls regression passed");
} finally {
  provider.close();
  rmSync(directory, { recursive: true, force: true });
}
