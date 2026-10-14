import { diffWords, type DiffSegment } from "./word-diff";

export const LOREBOOK_APPROVAL_ENTRY_DELIMITER = "<!-- marinara:lorebook-entry:v1 -->";

export interface ApprovalEntryBlock {
  name: string;
  keys: string[];
  tag: string;
  targetLorebook?: string;
  order?: number;
  content: string;
}

export type ApprovalAction = "created" | "replaced" | "appended";

export interface ExistingLorebookEntry {
  id: string;
  lorebookId: string;
  name: string;
  content: string;
  keys: string[];
  locked?: boolean | string | null;
}

export interface ApprovalTarget {
  lorebookId: string | null;
  lorebookName: string | null;
  createsLorebook: boolean;
}

export interface ApprovalClassification {
  action: ApprovalAction;
  locked: boolean;
  existing: ExistingLorebookEntry | null;
  appendedText: string;
}

export type DiffRow =
  | { kind: "equal"; text: string }
  | { kind: "removed"; text: string }
  | { kind: "added"; text: string }
  | { kind: "changed"; before: string; after: string; segments: DiffSegment[] };

export type FoldedDiffRow = DiffRow | { kind: "fold"; rows: DiffRow[] };

function readHeading(line: string): string | null {
  if (!line.startsWith("###") || !/\s/u.test(line[3] ?? "")) return null;
  return line.slice(3).trim() || null;
}

function splitBlocks(text: string): Array<{ name: string; body: string }> {
  const lines = text.split(/\r?\n/);
  const starts: Array<{ line: number; name: string }> = [];
  for (let index = 0; index + 1 < lines.length; index++) {
    if (lines[index] !== LOREBOOK_APPROVAL_ENTRY_DELIMITER) continue;
    const name = readHeading(lines[index + 1]!);
    if (name) starts.push({ line: index + 2, name });
  }
  if (starts.length === 0) {
    for (let index = 0; index < lines.length; index++) {
      const name = readHeading(lines[index]!);
      if (name) starts.push({ line: index + 1, name });
    }
    if (starts[0]?.line !== 1) starts.length = 0;
  }
  return starts.map((start, index) => {
    const next = starts[index + 1];
    const end = next ? next.line - (lines[next.line - 2] === LOREBOOK_APPROVAL_ENTRY_DELIMITER ? 2 : 1) : lines.length;
    return { name: start.name, body: lines.slice(start.line, end).join("\n") };
  });
}

/** Mirrors the server's parser for the approval text format (agent-write-approval.ts). */
export function parseLorebookApprovalText(text: string): ApprovalEntryBlock[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const blocks = splitBlocks(trimmed);
  if (blocks.length === 0) return [{ name: "Approved Agent Lore", keys: [], tag: "", content: trimmed }];

  const parsed: ApprovalEntryBlock[] = [];
  for (const { name, body } of blocks) {
    const lines = body.replace(/^\r?\n/, "").split(/\r?\n/);
    const keys: string[] = [];
    let tag = "";
    let order: number | undefined;
    let targetLorebook: string | undefined;
    let contentStart = 0;
    let sawMetadata = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      const keyMatch = line.match(/^Keys:\s*(.*)$/i);
      const tagMatch = line.match(/^Tag:\s*(.*)$/i);
      const orderMatch = line.match(/^Order:\s*(.*)$/i);
      const lorebookMatch = line.match(/^Lorebook:\s*(.*)$/i);
      if (keyMatch) {
        keys.push(
          ...keyMatch[1]!
            .split(",")
            .map((key) => key.trim())
            .filter(Boolean),
        );
      } else if (tagMatch) {
        tag = tagMatch[1]!.trim();
      } else if (orderMatch) {
        const raw = orderMatch[1]!.trim();
        const value = /^[+-]?\d+$/u.test(raw) ? Number(raw) : NaN;
        order = Number.isSafeInteger(value) ? value : undefined;
      } else if (lorebookMatch) {
        targetLorebook = lorebookMatch[1]!.trim() || undefined;
      } else if (!line.trim()) {
        contentStart = index + 1;
        if (sawMetadata) break;
        continue;
      } else {
        break;
      }
      sawMetadata = true;
      contentStart = index + 1;
    }
    const content = lines.slice(contentStart).join("\n").trim();
    if (!name || !content) continue;
    parsed.push({
      name,
      keys: Array.from(new Set(keys)),
      tag,
      ...(targetLorebook ? { targetLorebook } : {}),
      ...(order !== undefined ? { order } : {}),
      content,
    });
  }
  return parsed;
}

export function formatLorebookApprovalText(blocks: ApprovalEntryBlock[]): string {
  return blocks
    .map((block) =>
      [
        LOREBOOK_APPROVAL_ENTRY_DELIMITER,
        `### ${block.name}`,
        `Keys: ${block.keys.join(", ")}`,
        `Tag: ${block.tag}`,
        ...(block.targetLorebook ? [`Lorebook: ${block.targetLorebook}`] : []),
        ...(block.order !== undefined ? [`Order: ${block.order}`] : []),
        "",
        block.content,
      ].join("\n"),
    )
    .join("\n\n");
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function writableBooks(payload: Record<string, unknown>): Array<{ id: string; name: string }> {
  const raw = Array.isArray(payload.writableLorebooks) ? payload.writableLorebooks : [];
  return raw.flatMap((book) =>
    book && typeof book === "object" && typeof book.id === "string" && typeof book.name === "string"
      ? [{ id: book.id, name: book.name }]
      : [],
  );
}

/** Mirrors persistLorebookKeeperUpdates' routing: exact book name, then naming-scheme alias, then the preferred book. */
export function resolveApprovalTarget(block: ApprovalEntryBlock, payload: Record<string, unknown>): ApprovalTarget {
  const books = writableBooks(payload);
  const preferredId =
    stringField(payload, "preferredTargetLorebookId") ??
    (Array.isArray(payload.writableLorebookIds) && typeof payload.writableLorebookIds[0] === "string"
      ? payload.writableLorebookIds[0]
      : null);
  const preferred = {
    lorebookId: preferredId,
    lorebookName: books.find((book) => book.id === preferredId)?.name ?? null,
  };
  const rawTarget = block.targetLorebook?.trim();
  if (!rawTarget || payload.allowTargetRouting !== true) return { ...preferred, createsLorebook: !preferredId };

  const exact = books.find((book) => book.name === rawTarget);
  if (exact) return { lorebookId: exact.id, lorebookName: exact.name, createsLorebook: false };
  const scheme =
    payload.lorebookNamingScheme && typeof payload.lorebookNamingScheme === "object"
      ? (payload.lorebookNamingScheme as Record<string, unknown>)
      : {};
  const template = scheme[rawTarget.toLowerCase()];
  if (typeof template === "string") {
    const resolvedName = template.replaceAll("[WorldName]", stringField(payload, "worldName")?.trim() ?? "");
    const existing = books.find((book) => book.name === resolvedName);
    if (existing) return { lorebookId: existing.id, lorebookName: existing.name, createsLorebook: false };
    return { lorebookId: null, lorebookName: resolvedName, createsLorebook: true };
  }
  return { ...preferred, createsLorebook: !preferredId };
}

export function isLockedEntry(entry: Pick<ExistingLorebookEntry, "locked"> | null): boolean {
  return entry?.locked === true || entry?.locked === "true";
}

export function findExistingEntry(
  name: string,
  target: ApprovalTarget,
  entries: ExistingLorebookEntry[],
): ExistingLorebookEntry | null {
  if (!target.lorebookId) return null;
  const wanted = name.trim().toLowerCase();
  return (
    entries.find((entry) => entry.lorebookId === target.lorebookId && entry.name.trim().toLowerCase() === wanted) ??
    null
  );
}

export function classifyApprovalEntry(
  block: ApprovalEntryBlock,
  existing: ExistingLorebookEntry | null,
): ApprovalClassification {
  if (!existing) return { action: "created", locked: false, existing: null, appendedText: "" };
  const locked = isLockedEntry(existing);
  const current = existing.content.trim();
  const proposed = block.content.trim();
  if (current && proposed.length > current.length && proposed.startsWith(current)) {
    const appendedText = proposed.slice(current.length).trim();
    if (appendedText) return { action: "appended", locked, existing, appendedText };
  }
  return { action: "replaced", locked, existing, appendedText: "" };
}

const MAX_LINE_DIFF_CELLS = 250_000;

function words(line: string): string[] {
  return line.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

function similarity(left: string, right: string): number {
  const a = words(left);
  const b = new Set(words(right));
  if (a.length === 0 || b.size === 0) return 0;
  const shared = new Set(a.filter((word) => b.has(word))).size;
  return (2 * shared) / (new Set(a).size + b.size);
}

const PAIR_THRESHOLD = 0.6;

function pairHunk(removed: string[], added: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < removed.length && j < added.length) {
    if (similarity(removed[i]!, added[j]!) >= PAIR_THRESHOLD) {
      rows.push({
        kind: "changed",
        before: removed[i]!,
        after: added[j]!,
        segments: diffWords(removed[i]!, added[j]!),
      });
      i++;
      j++;
    } else if (j + 1 < added.length && similarity(removed[i]!, added[j + 1]!) >= PAIR_THRESHOLD) {
      rows.push({ kind: "added", text: added[j++]! });
    } else {
      rows.push({ kind: "removed", text: removed[i++]! });
    }
  }
  while (i < removed.length) rows.push({ kind: "removed", text: removed[i++]! });
  while (j < added.length) rows.push({ kind: "added", text: added[j++]! });
  return rows;
}

/**
 * Line-level diff: unchanged lines stay whole, a rewritten line is paired with the old line it most resembles
 * and word-diffed inside the pair, and everything else is a whole removed or added line.
 */
export function diffEntryLines(before: string, after: string): DiffRow[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  if (a.length * b.length > MAX_LINE_DIFF_CELLS) {
    return [
      ...a.map((text) => ({ kind: "removed" as const, text })),
      ...b.map((text) => ({ kind: "added" as const, text })),
    ];
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    if (removed.length || added.length) rows.push(...pairHunk(removed, added));
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      rows.push({ kind: "equal", text: a[i]! });
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      removed.push(a[i++]!);
    } else {
      added.push(b[j++]!);
    }
  }
  flush();
  return rows;
}

export function foldDiffRows(rows: DiffRow[], context = 1, minimumRun = 4): FoldedDiffRow[] {
  const folded: FoldedDiffRow[] = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index]!.kind !== "equal") {
      folded.push(rows[index]!);
      index++;
      continue;
    }
    let end = index;
    while (end < rows.length && rows[end]!.kind === "equal") end++;
    const run = rows.slice(index, end);
    const keepBefore = index === 0 ? 0 : context;
    const keepAfter = end === rows.length ? 0 : context;
    if (run.length - keepBefore - keepAfter >= minimumRun) {
      folded.push(...run.slice(0, keepBefore));
      folded.push({ kind: "fold", rows: run.slice(keepBefore, run.length - keepAfter) });
      folded.push(...run.slice(run.length - keepAfter));
    } else {
      folded.push(...run);
    }
    index = end;
  }
  return folded;
}

export interface DiffStats {
  added: number;
  removed: number;
  changed: number;
}

export function diffStats(rows: DiffRow[]): DiffStats {
  const stats = { added: 0, removed: 0, changed: 0 };
  for (const row of rows) {
    if (row.kind === "equal") continue;
    if (row.kind === "added" && !row.text.trim()) continue;
    if (row.kind === "removed" && !row.text.trim()) continue;
    stats[row.kind]++;
  }
  return stats;
}

export function composeEntryContent(classification: ApprovalClassification, draft: string): string {
  if (classification.action === "appended" && classification.existing) {
    return `${classification.existing.content.trim()}\n\n${draft.trim()}`;
  }
  return draft.trim();
}
