import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OpenAIProvider } from "../../packages/server/src/services/llm/providers/openai.provider.js";
import type { BaseLLMProvider, ChatMessage } from "../../packages/server/src/services/llm/base-provider.js";
import {
  hashPromptSections,
  readRequestLog,
  RequestTelemetryRecorder,
  withRequestTelemetry,
} from "../../packages/server/src/services/telemetry/request-telemetry.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-request-telemetry-"));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const usage = {
  prompt_tokens: 100,
  completion_tokens: 10,
  total_tokens: 110,
  prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 5 },
  cost: 0.0042,
};
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const head = { id: "gen-123", provider: "Z.AI", model: body.model, object: "chat.completion" };
  if (body.stream) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ ...head, choices: [{ delta: { content: "Do" } }] })}\n\n`);
    response.write(
      `data: ${JSON.stringify({ ...head, choices: [{ delta: { content: "ne" }, finish_reason: "stop" }] })}\n\n`,
    );
    response.write(`data: ${JSON.stringify({ ...head, choices: [], usage })}\n\n`);
    response.end("data: [DONE]\n\n");
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ ...head, choices: [{ message: { content: "Done" }, finish_reason: "stop" }], usage }),
    );
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

async function drain(provider: BaseLLMProvider, messages: ChatMessage[], stream: boolean) {
  const gen = provider.chat(messages, { model: "z-ai/glm-5.2", stream });
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
}

const prompt: ChatMessage[] = [
  { role: "system", content: "You are a narrator.", contextKind: "prompt" },
  { role: "system", content: "World: a lighthouse.", contextKind: "prompt" },
  { role: "user", content: "Hello", contextKind: "history" },
  { role: "assistant", content: "Hi.", contextKind: "history" },
  { role: "user", content: "[Continue the scene.]" },
];

try {
  await test("OpenRouter response metadata reaches usage, the request log and generationInfo", async () => {
    const recorder = new RequestTelemetryRecorder({
      chatId: "chat-1",
      kind: "reroll",
      presetId: "preset-1",
      presetHash: "0123456789abcdef",
      origin: () => ({ model: "z-ai/glm-5.2", provider: "openrouter" }),
    });
    const provider = withRequestTelemetry(
      new OpenAIProvider(baseUrl, "test", undefined, undefined, undefined, "openrouter"),
      recorder,
    );
    for (const stream of [true, false]) {
      const result = await drain(provider, prompt, stream);
      assert.equal(result?.upstreamProvider, "Z.AI");
      assert.equal(result?.generationId, "gen-123");
      assert.equal(result?.costUsd, 0.0042);
      assert.equal(result?.cachedPromptTokens, 60);
      const completed = await provider.chatComplete(prompt, { model: "z-ai/glm-5.2", stream, onToken: () => {} });
      assert.equal(completed.usage?.upstreamProvider, "Z.AI");
      assert.equal(completed.usage?.generationId, "gen-123");
      assert.equal(completed.usage?.costUsd, 0.0042);
    }

    const summary = recorder.commit("message-1", 2);
    assert.equal(summary.upstreamProvider, "Z.AI");
    assert.equal(summary.generationId, "gen-123");
    assert.equal(typeof summary.ttftMs, "number");
    assert.ok(Math.abs(summary.costUsd! - 0.0042 * 4) < 1e-9, "cost is summed across the generation's requests");
    assert.equal(summary.presetHash, "0123456789abcdef");
    assert.equal(summary.sessionId, undefined);
    assert.deepEqual(summary.promptSections, hashPromptSections(prompt));

    const rows = await readRequestLog({ chatId: "chat-1", limit: 100 });
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.kind, "reroll");
      assert.equal(row.messageId, "message-1");
      assert.equal(row.swipeIndex, 2);
      assert.equal(row.upstreamProvider, "Z.AI");
      assert.equal(row.generationId, "gen-123");
      assert.equal(row.costUsd, 0.0042);
      assert.equal(row.promptTokens, 100);
      assert.equal(row.cachedTokens, 60);
      assert.equal(row.cacheWriteTokens, 5);
      assert.equal(row.connectionProvider, "openrouter");
      assert.equal(row.presetId, "preset-1");
      assert.equal(row.error, null);
      assert.equal(typeof row.ttftMs, "number");
      assert.equal(typeof row.durationMs, "number");
    }
    assert.deepEqual(await readRequestLog({ chatId: "other", limit: 100 }), []);
    assert.deepEqual(await readRequestLog({ chatId: "chat-1", since: new Date(Date.now() + 60_000), limit: 100 }), []);
  });

  await test("failed requests are logged with their error and without a message", async () => {
    const recorder = new RequestTelemetryRecorder({
      chatId: "chat-2",
      kind: "reply",
      presetId: null,
      origin: () => ({ model: "m", provider: "openrouter" }),
    });
    const provider = withRequestTelemetry(
      new OpenAIProvider("http://127.0.0.1:1/api/v1", "test", undefined, undefined, undefined, "openrouter"),
      recorder,
    );
    await assert.rejects(drain(provider, prompt, true));
    recorder.flush();
    const rows = await readRequestLog({ chatId: "chat-2", limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.messageId, null);
    assert.equal(typeof rows[0]!.error, "string");
  });

  await test("prompt section hashes are stable and change only where the prompt changed", () => {
    const first = hashPromptSections(prompt);
    assert.deepEqual(hashPromptSections(prompt.map((message) => ({ ...message }))), first);
    assert.deepEqual(
      first.map((section) => [section.name, section.kind]),
      [
        ["message[0]", "section"],
        ["message[1]", "section"],
        ["message[2]", "history"],
        ["message[3]", "history"],
        ["message[4]", "tail"],
      ],
    );
    assert.equal(first[1]!.chars, "World: a lighthouse.".length);
    assert.match(first[0]!.hash, /^[0-9a-f]{16}$/);

    const edited = prompt.map((message, index) =>
      index === 1 ? { ...message, content: "World: a lighthouse at night." } : message,
    );
    const second = hashPromptSections(edited);
    assert.deepEqual(
      second.map((section, index) => section.hash !== first[index]!.hash),
      [false, true, false, false, false],
    );
  });
} finally {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
}
