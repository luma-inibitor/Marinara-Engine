import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../lib/logger.js";
import { getDataDir } from "../../utils/data-dir.js";
import {
  BaseLLMProvider,
  type ChatCompletionResult,
  type ChatMessage,
  type ChatOptions,
  type LLMUsage,
} from "../llm/base-provider.js";

export type RequestKind = "reply" | "reroll" | "impersonate" | "continue" | "agent" | "memory_recall";

export interface PromptSectionHash {
  name: string;
  kind: "section" | "marker" | "history" | "tail";
  hash: string;
  chars: number;
}

export interface RequestTelemetry {
  upstreamProvider?: string;
  generationId?: string;
  ttftMs?: number;
  sessionId?: string;
  costUsd?: number;
  presetHash?: string;
  promptSections?: PromptSectionHash[];
}

export type RequestLogRow = { ts: string; chatId: string; kind: RequestKind } & Record<string, unknown>;

const FILE_PATTERN = /^requests-(\d{8})\.jsonl$/;

export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function hashPromptSections(messages: readonly ChatMessage[]): PromptSectionHash[] {
  let lastHistory = -1;
  messages.forEach((message, index) => {
    if (message.contextKind === "history") lastHistory = index;
  });
  return messages.map((message, index) => {
    const text = typeof message.content === "string" ? message.content : "";
    return {
      name: `message[${index}]`,
      kind:
        message.contextKind === "history" ? "history" : lastHistory >= 0 && index > lastHistory ? "tail" : "section",
      hash: shortHash(text),
      chars: text.length,
    };
  });
}

export function hashPreset(input: {
  preset: {
    wrapFormat?: string | null;
    parameters?: string | null;
    variableValues?: string | null;
    sectionOrder: string;
  };
  sections: ReadonlyArray<Record<string, unknown> & { id: string }>;
  groups: ReadonlyArray<Record<string, unknown>>;
  choices: Record<string, string | string[]>;
}): string {
  let order: unknown;
  try {
    order = JSON.parse(input.preset.sectionOrder);
  } catch {
    order = [];
  }
  const byId = new Map(input.sections.map((section) => [section.id, section]));
  const sections = (Array.isArray(order) ? order : []).flatMap((id) => {
    const section = byId.get(String(id));
    if (!section) return [];
    return [
      [
        section.identifier,
        section.name,
        section.content,
        section.role,
        section.enabled,
        section.isMarker,
        section.groupId,
        section.markerConfig,
        section.injectionPosition,
        section.injectionDepth,
        section.injectionOrder,
      ],
    ];
  });
  const groups = input.groups.map((group) => [group.id, group.name, group.parentGroupId, group.order, group.enabled]);
  const choices = Object.keys(input.choices)
    .sort()
    .map((key) => [key, input.choices[key]]);
  return shortHash(
    JSON.stringify({
      wrapFormat: input.preset.wrapFormat ?? null,
      parameters: input.preset.parameters ?? null,
      variableValues: input.preset.variableValues ?? null,
      sections,
      groups,
      choices,
    }),
  );
}

export function generationRequestKind(input: {
  impersonate?: boolean | null;
  regenerateMessageId?: string | null;
  continueMessageId?: string | null;
}): RequestKind {
  if (input.impersonate) return "impersonate";
  if (input.regenerateMessageId) return "reroll";
  if (input.continueMessageId) return "continue";
  return "reply";
}

function telemetryDir(): string {
  return join(getDataDir(), "telemetry");
}

function fileDate(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

let pendingWrites: Promise<void> = Promise.resolve();

export function appendRequestLog(rows: RequestLogRow | RequestLogRow[]): Promise<void> {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return pendingWrites;
  const byFile = new Map<string, string>();
  for (const row of list) {
    const file = join(telemetryDir(), `requests-${fileDate(new Date(row.ts))}.jsonl`);
    byFile.set(file, (byFile.get(file) ?? "") + `${JSON.stringify(row)}\n`);
  }
  pendingWrites = pendingWrites
    .then(async () => {
      await mkdir(telemetryDir(), { recursive: true });
      for (const [file, text] of byFile) await appendFile(file, text, "utf8");
    })
    .catch((error: unknown) => logger.warn(error, "[telemetry] Could not write the request log"));
  return pendingWrites;
}

export async function readRequestLog(query: {
  chatId?: string;
  since?: Date;
  limit: number;
}): Promise<RequestLogRow[]> {
  await pendingWrites;
  let files: string[];
  try {
    files = (await readdir(telemetryDir())).filter((name) => FILE_PATTERN.test(name)).sort();
  } catch {
    return [];
  }
  const sinceDay = query.since ? fileDate(query.since) : null;
  const sinceMs = query.since?.getTime();
  let rows: RequestLogRow[] = [];
  for (const name of files.reverse()) {
    const day = FILE_PATTERN.exec(name)![1]!;
    if (sinceDay && day < sinceDay) break;
    const matches: RequestLogRow[] = [];
    for (const line of (await readFile(join(telemetryDir(), name), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      let row: RequestLogRow;
      try {
        row = JSON.parse(line) as RequestLogRow;
      } catch {
        continue;
      }
      if (query.chatId && row.chatId !== query.chatId) continue;
      if (sinceMs !== undefined && !(Date.parse(row.ts) >= sinceMs)) continue;
      matches.push(row);
    }
    rows = [...matches, ...rows];
    if (rows.length >= query.limit) break;
  }
  return rows.slice(-query.limit);
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

export class RequestTelemetryRecorder {
  private pending: RequestLogRow[] = [];

  constructor(
    private readonly context: {
      chatId: string;
      kind: RequestKind;
      presetId: string | null;
      presetHash?: string;
      origin: () => { model: string; provider: string };
    },
  ) {}

  start(messages: readonly ChatMessage[]) {
    const startedAt = Date.now();
    const promptSections = hashPromptSections(messages);
    let ttftMs: number | undefined;
    let ended = false;
    const end = (usage: LLMUsage | undefined, error: string | null, finishReason?: string) => {
      if (ended) return;
      ended = true;
      const durationMs = Date.now() - startedAt;
      if (!error) ttftMs ??= durationMs;
      const origin = this.context.origin();
      this.pending.push({
        ts: new Date(startedAt).toISOString(),
        chatId: this.context.chatId,
        messageId: null,
        swipeIndex: null,
        kind: this.context.kind,
        model: origin.model,
        connectionProvider: origin.provider,
        presetId: this.context.presetId,
        presetHash: this.context.presetHash ?? null,
        upstreamProvider: usage?.upstreamProvider ?? null,
        generationId: usage?.generationId ?? null,
        sessionId: usage?.sessionId ?? null,
        ttftMs: ttftMs ?? null,
        costUsd: usage?.costUsd ?? null,
        promptTokens: usage?.promptTokens ?? null,
        cachedTokens: usage?.cachedPromptTokens ?? null,
        cacheWriteTokens: usage?.cacheWritePromptTokens ?? null,
        durationMs,
        finishReason: finishReason ?? usage?.finishReason ?? null,
        error,
        promptSections,
      });
    };
    return {
      token: () => {
        ttftMs ??= Date.now() - startedAt;
      },
      done: (usage: LLMUsage | undefined, finishReason?: string) => end(usage, null, finishReason),
      fail: (error: unknown) => end(undefined, describeError(error)),
      close: () => end(undefined, "aborted"),
    };
  }

  commit(messageId: string, swipeIndex: number | null): RequestTelemetry {
    const rows = this.pending;
    this.pending = [];
    for (const row of rows) {
      row.messageId = messageId;
      row.swipeIndex = swipeIndex;
    }
    void appendRequestLog(rows);
    const last = rows.filter((row) => row.error === null).at(-1) ?? rows.at(-1);
    const costs = rows.map((row) => row.costUsd).filter((cost): cost is number => typeof cost === "number");
    const summary: RequestTelemetry = {
      upstreamProvider: (last?.upstreamProvider as string | null) ?? undefined,
      generationId: (last?.generationId as string | null) ?? undefined,
      ttftMs: (last?.ttftMs as number | null) ?? undefined,
      sessionId: (last?.sessionId as string | null) ?? undefined,
      costUsd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : undefined,
      presetHash: this.context.presetHash,
      promptSections: last?.promptSections as PromptSectionHash[] | undefined,
    };
    return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined)) as RequestTelemetry;
  }

  flush(): void {
    const rows = this.pending;
    this.pending = [];
    void appendRequestLog(rows);
  }
}

export function withRequestTelemetry(provider: BaseLLMProvider, recorder: RequestTelemetryRecorder): BaseLLMProvider {
  class RequestTelemetryProvider extends BaseLLMProvider {
    constructor() {
      super("", "", provider.maxContextValue ?? undefined, null, provider.maxTokensOverrideValue);
    }

    async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown> {
      const request = recorder.start(messages);
      const stream = provider.chat(messages, options);
      try {
        while (true) {
          const chunk = await stream.next();
          if (chunk.done) {
            request.done(chunk.value || undefined);
            return chunk.value;
          }
          request.token();
          yield chunk.value;
        }
      } catch (error) {
        if (options.signal?.aborted) request.close();
        else request.fail(error);
        throw error;
      } finally {
        request.close();
        await stream.return(undefined).catch(() => {});
      }
    }

    override async chatComplete(messages: ChatMessage[], options: ChatOptions): Promise<ChatCompletionResult> {
      const request = recorder.start(messages);
      try {
        const result = await provider.chatComplete(messages, {
          ...options,
          ...(options.onToken
            ? {
                onToken: (token: string) => {
                  request.token();
                  return options.onToken!(token);
                },
              }
            : {}),
        });
        request.done(result.usage, result.finishReason);
        return result;
      } catch (error) {
        if (options.signal?.aborted) request.close();
        else request.fail(error);
        throw error;
      }
    }

    override embed(texts: string[], model: string, signal?: AbortSignal) {
      return provider.embed(texts, model, signal);
    }
  }
  return new RequestTelemetryProvider();
}
