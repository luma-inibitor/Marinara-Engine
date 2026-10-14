// ──────────────────────────────────────────────
// Per-entry review of a Lorebook Keeper write proposal
// ──────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ListPlus,
  Loader2,
  Lock,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation as useUiTranslation } from "react-i18next";
import type { AgentWriteApprovalProposal, LorebookEntry } from "@marinara-engine/shared";
import { cn } from "../../lib/utils";
import { useEntriesAcrossLorebooks } from "../../hooks/use-lorebooks";
import {
  classifyApprovalEntry,
  composeEntryContent,
  diffEntryLines,
  diffStats,
  findExistingEntry,
  foldDiffRows,
  formatLorebookApprovalText,
  parseLorebookApprovalText,
  resolveApprovalTarget,
  type ApprovalAction,
  type ApprovalClassification,
  type ApprovalEntryBlock,
  type ApprovalTarget,
  type DiffRow,
  type FoldedDiffRow,
} from "../../lib/lorebook-approval-review";

type BusyAction = "accept" | "regenerate" | null;

interface Props {
  proposal: AgentWriteApprovalProposal;
  busyAction: BusyAction;
  error: string | null;
  canRegenerate: boolean;
  onAccept: (text: string) => void;
  onDiscard: () => void;
  onRegenerate: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

interface ReviewEntry {
  index: number;
  block: ApprovalEntryBlock;
  target: ApprovalTarget;
  classification: ApprovalClassification;
  proposedBody: string;
  reason: string;
}

interface EntryState {
  included: boolean;
  open: boolean;
  editing: boolean;
  draft?: string;
  snapshot?: { draft?: string; name?: string };
  name?: string;
  removedKeys: string[];
}

const ACTION_META: Record<ApprovalAction, { icon: typeof Sparkles; tone: string; labelKey: string }> = {
  created: { icon: Sparkles, tone: "text-[var(--primary)]", labelKey: "ui.chat.mariediteasyviewer.actionNew" },
  replaced: {
    icon: Pencil,
    tone: "text-[var(--muted-foreground)]",
    labelKey: "ui.modals.lorebookapprovalreview.actionReplaced",
  },
  appended: { icon: ListPlus, tone: "text-emerald-500", labelKey: "ui.modals.lorebookapprovalreview.actionAppended" },
};

const GUTTER = { removed: "\u2212", added: "+", changed: "~" };

function readReason(payload: Record<string, unknown> | undefined, name: string): string {
  const updates = Array.isArray(payload?.updates) ? payload.updates : [];
  const wanted = name.trim().toLowerCase();
  for (const update of updates) {
    if (!update || typeof update !== "object") continue;
    const record = update as Record<string, unknown>;
    const entry = record.entry && typeof record.entry === "object" ? (record.entry as Record<string, unknown>) : {};
    const updateName = [record.entryName, record.name, entry.name].find((value) => typeof value === "string");
    if (typeof updateName === "string" && updateName.trim().toLowerCase() === wanted) {
      return typeof record.reason === "string" ? record.reason.trim() : "";
    }
  }
  return "";
}

function DiffLine({ row }: { row: DiffRow }) {
  const { t: localizeUi } = useUiTranslation();
  if (row.kind === "equal") {
    return (
      <div className="flex gap-2 text-[var(--muted-foreground)]">
        <span aria-hidden="true" className="w-3 shrink-0 select-none text-center" />
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{row.text || " "}</span>
      </div>
    );
  }
  if (row.kind === "removed") {
    return (
      <div className="flex gap-2 rounded bg-[var(--destructive)]/10">
        <span
          aria-hidden="true"
          className="w-3 shrink-0 select-none text-center font-semibold text-[var(--destructive)]"
        >
          {GUTTER.removed}
        </span>
        <del className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[var(--foreground)]">
          <span className="sr-only">{localizeUi("ui.modals.lorebookapprovalreview.srRemoved")}</span>
          {row.text || " "}
        </del>
      </div>
    );
  }
  if (row.kind === "added") {
    return (
      <div className="flex gap-2 rounded bg-emerald-500/10">
        <span aria-hidden="true" className="w-3 shrink-0 select-none text-center font-semibold text-emerald-500">
          {GUTTER.added}
        </span>
        <ins className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[var(--foreground)] no-underline">
          <span className="sr-only">{localizeUi("ui.modals.lorebookapprovalreview.srAdded")}</span>
          {row.text || " "}
        </ins>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <span aria-hidden="true" className="w-3 shrink-0 select-none text-center font-semibold text-amber-500">
        {GUTTER.changed}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        {row.segments.map((segment, index) =>
          segment.type === "equal" ? (
            <span key={index}>{segment.value}</span>
          ) : segment.type === "added" ? (
            <ins key={index} className="rounded bg-emerald-500/25 text-[var(--foreground)] no-underline">
              <span className="sr-only">{localizeUi("ui.modals.lorebookapprovalreview.srAdded")}</span>
              {segment.value}
            </ins>
          ) : (
            <del key={index} className="rounded bg-[var(--destructive)]/25 text-[var(--foreground)] line-through">
              <span className="sr-only">{localizeUi("ui.modals.lorebookapprovalreview.srRemoved")}</span>
              {segment.value}
            </del>
          ),
        )}
      </span>
    </div>
  );
}

function DiffView({ rows }: { rows: FoldedDiffRow[] }) {
  const { t: localizeUi } = useUiTranslation();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  return (
    <div className="flex flex-col gap-0.5 text-xs leading-relaxed">
      {rows.map((row, index) =>
        row.kind === "fold" ? (
          expanded.has(index) ? (
            row.rows.map((inner, innerIndex) => <DiffLine key={`${index}:${innerIndex}`} row={inner} />)
          ) : (
            <button
              key={index}
              type="button"
              onClick={() => setExpanded((current) => new Set(current).add(index))}
              className="my-0.5 self-start rounded-md px-2 py-1 text-[0.625rem] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] max-sm:min-h-11"
            >
              {localizeUi("ui.modals.lorebookapprovalreview.unchangedLines", { count: row.rows.length })}
            </button>
          )
        ) : (
          <DiffLine key={index} row={row} />
        ),
      )}
    </div>
  );
}

function AppendedView({ existing, added }: { existing: string; added: string }) {
  const { t: localizeUi } = useUiTranslation();
  const [showAll, setShowAll] = useState(false);
  const lines = existing.split(/\r?\n/);
  const tailStart = Math.max(0, lines.length - 3);
  const visible = showAll ? lines : lines.slice(tailStart);
  const rows: DiffRow[] = [
    ...visible.map((text) => ({ kind: "equal" as const, text })),
    { kind: "equal", text: "" },
    ...added.split(/\r?\n/).map((text) => ({ kind: "added" as const, text })),
  ];
  return (
    <div className="flex flex-col gap-0.5">
      {!showAll && tailStart > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mb-0.5 self-start rounded-md px-2 py-1 text-[0.625rem] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] max-sm:min-h-11"
        >
          {localizeUi("chat.settings.inlineLorebook.showMore", { count: tailStart })}
        </button>
      )}
      <DiffView rows={rows} />
    </div>
  );
}

function PlainText({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--foreground)]">{text}</p>;
}

export function LorebookApprovalReview({
  proposal,
  busyAction,
  error,
  canRegenerate,
  onAccept,
  onDiscard,
  onRegenerate,
  onDirtyChange,
}: Props) {
  const { t: localizeUi } = useUiTranslation();
  const payload = useMemo(() => proposal.payload ?? {}, [proposal.payload]);
  const blocks = useMemo(() => parseLorebookApprovalText(proposal.text), [proposal.text]);
  const targets = useMemo(() => blocks.map((block) => resolveApprovalTarget(block, payload)), [blocks, payload]);
  const lorebookIds = useMemo(
    () => targets.flatMap((target) => (target.lorebookId ? [target.lorebookId] : [])),
    [targets],
  );
  const current = useEntriesAcrossLorebooks(lorebookIds);
  const loadFailed = current.isError;
  const ready = !!current.entries || loadFailed;
  // The hook returns a fresh array every render; key the review on the entries' content instead.
  const currentEntriesRef = useRef<LorebookEntry[]>([]);
  currentEntriesRef.current = current.entries ?? [];
  const entriesSignature = (current.entries ?? [])
    .map((entry) => `${entry.id}:${entry.updatedAt}:${String(entry.locked)}`)
    .join("|");

  const entries = useMemo<ReviewEntry[]>(() => {
    const existingEntries = currentEntriesRef.current;
    return blocks.map((block, index) => {
      const target = targets[index]!;
      const classification = classifyApprovalEntry(block, findExistingEntry(block.name, target, existingEntries));
      return {
        index,
        block,
        target,
        classification,
        proposedBody: classification.action === "appended" ? classification.appendedText : block.content,
        reason: readReason(payload, block.name),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- entriesSignature stands in for the entries array
  }, [blocks, targets, entriesSignature, payload]);

  const [state, setState] = useState<EntryState[]>([]);
  const initializedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || initializedFor.current === proposal.text) return;
    initializedFor.current = proposal.text;
    const openByDefault = (entry: ReviewEntry) =>
      entries.length <= 3 || entry.classification.action === "replaced" || entry.classification.locked;
    setState(
      entries.map((entry) => ({
        included: !entry.classification.locked,
        open: openByDefault(entry),
        editing: false,
        removedKeys: [],
      })),
    );
  }, [ready, entries, proposal.text]);

  const dirty = state.some(
    (item, index) =>
      item.draft !== undefined ||
      item.name !== undefined ||
      item.removedKeys.length > 0 ||
      item.included !== !entries[index]?.classification.locked,
  );
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const update = (index: number, patch: Partial<EntryState>) =>
    setState((items) => items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));

  const multipleBooks = new Set(targets.map((target) => target.lorebookId ?? target.lorebookName)).size > 1;
  const counts = { created: 0, replaced: 0, appended: 0, locked: 0 };
  for (const entry of entries) {
    if (entry.classification.locked) counts.locked++;
    else counts[entry.classification.action]++;
  }
  const selected = state.filter((item, index) => item.included && !entries[index]?.classification.locked).length;
  const edited = state.filter(
    (item) => item.draft !== undefined || item.name !== undefined || item.removedKeys.length,
  ).length;
  const skipped = entries.length - counts.locked - selected;

  const buildText = (onlyIncluded: boolean) =>
    formatLorebookApprovalText(
      entries.flatMap((entry, index) => {
        const item = state[index];
        if (!item || entry.classification.locked || (onlyIncluded && !item.included)) return [];
        const body = item.draft ?? entry.proposedBody;
        return [
          {
            ...entry.block,
            name: item.name?.trim() || entry.block.name,
            keys: entry.block.keys.filter((key) => !item.removedKeys.includes(key)),
            content: item.draft === undefined ? entry.block.content : composeEntryContent(entry.classification, body),
          },
        ];
      }),
    );

  const copyAsText = async () => {
    try {
      await navigator.clipboard.writeText(buildText(false));
      toast.success(localizeUi("markdown.copied"));
    } catch {
      toast.error(localizeUi("ui.modals.lorebookapprovalreview.copyFailed"));
    }
  };

  if (!ready || state.length !== entries.length) {
    return (
      <div className="flex items-center gap-2 py-8 text-xs text-[var(--muted-foreground)]">
        <Loader2 size="0.875rem" className="animate-spin" />
        {localizeUi("ui.ui.panelstates.loading")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5" aria-live="polite">
        <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-[0.6875rem] font-semibold text-[var(--accent-foreground)]">
          {localizeUi("ui.modals.lorebookapprovalreview.entries", { count: entries.length })}
        </span>
        {(["created", "replaced", "appended"] as const).map((action) => {
          if (!counts[action]) return null;
          const meta = ACTION_META[action];
          const Icon = meta.icon;
          return (
            <span
              key={action}
              className="inline-flex items-center gap-1 rounded-full bg-[var(--secondary)] px-2 py-0.5 text-[0.6875rem] font-medium text-[var(--secondary-foreground)]"
            >
              <Icon size="0.6875rem" className={meta.tone} />
              {localizeUi(`ui.modals.lorebookapprovalreview.count_${action}`, { count: counts[action] })}
            </span>
          );
        })}
        {counts.locked > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--secondary)] px-2 py-0.5 text-[0.6875rem] font-medium text-[var(--secondary-foreground)]">
            <Lock size="0.6875rem" className="text-amber-500" />
            {localizeUi("ui.modals.lorebookapprovalreview.count_locked", { count: counts.locked })}
          </span>
        )}
      </div>

      {loadFailed && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-500 ring-1 ring-amber-500/25">
          {localizeUi("ui.modals.lorebookapprovalreview.loadFailed")}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {entries.map((entry, index) => {
          const item = state[index]!;
          const { classification, block } = entry;
          const locked = classification.locked;
          const meta = ACTION_META[classification.action];
          const Icon = meta.icon;
          const name = item.name ?? block.name;
          const body = item.draft ?? entry.proposedBody;
          const existingContent = classification.existing?.content ?? "";
          const rows = classification.action === "replaced" ? diffEntryLines(existingContent, body) : [];
          const stats = diffStats(rows);
          const existingKeys = classification.existing?.keys ?? [];
          const existingKeySet = new Set(existingKeys.map((key) => key.toLowerCase()));
          const newKeys = block.keys.filter((key) => !existingKeySet.has(key.toLowerCase()));
          const isEdited = item.draft !== undefined || item.name !== undefined || item.removedKeys.length > 0;
          const bodyId = `lorebook-approval-entry-${index}`;
          const delta =
            classification.action === "created"
              ? localizeUi("ui.modals.lorebookapprovalreview.wordCount", {
                  count: body.split(/\s+/).filter(Boolean).length,
                })
              : classification.action === "appended"
                ? localizeUi("ui.modals.lorebookapprovalreview.addedLines", {
                    count: body.split(/\r?\n/).filter((line) => line.trim()).length,
                  })
                : localizeUi("ui.modals.lorebookapprovalreview.lineStats", {
                    added: stats.added,
                    changed: stats.changed,
                  });
          const startEdit = () =>
            update(index, { editing: true, open: true, snapshot: { draft: item.draft, name: item.name } });
          const cancelEdit = () =>
            update(index, {
              editing: false,
              draft: item.snapshot?.draft,
              name: item.snapshot?.name,
              snapshot: undefined,
            });

          return (
            <div
              key={index}
              className={cn(
                "rounded-lg border bg-[var(--background)]/40",
                item.editing ? "border-[var(--ring)]" : "border-[var(--border)]",
              )}
            >
              <div className="flex min-w-0 items-center gap-1 px-1.5 py-1">
                <label
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center max-sm:h-11 max-sm:w-11",
                    locked ? "cursor-not-allowed" : "cursor-pointer",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={item.included && !locked}
                    disabled={locked}
                    onChange={(event) => update(index, { included: event.target.checked })}
                    aria-label={localizeUi("ui.modals.lorebookapprovalreview.include", { name })}
                    className="h-4 w-4 accent-[var(--primary)]"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => update(index, { open: !item.open })}
                  aria-expanded={item.open}
                  aria-controls={bodyId}
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md py-1.5 text-left max-sm:min-h-11"
                >
                  {item.open ? (
                    <ChevronDown size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" />
                  ) : (
                    <ChevronRight size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" />
                  )}
                  <span
                    className={cn("inline-flex shrink-0 items-center gap-1 text-[0.625rem] font-semibold", meta.tone)}
                  >
                    <Icon size="0.75rem" />
                    {localizeUi(meta.labelKey)}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 truncate text-xs font-semibold",
                      item.included && !locked ? "text-[var(--foreground)]" : "text-[var(--muted-foreground)]",
                    )}
                  >
                    {name}
                  </span>
                  <span className="shrink-0 text-[0.625rem] text-[var(--muted-foreground)]">{delta}</span>
                  {stats.removed > 0 && !locked && (
                    <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-amber-500">
                      {localizeUi("ui.modals.lorebookapprovalreview.linesRemoved", { count: stats.removed })}
                    </span>
                  )}
                  {locked && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-amber-500">
                      <Lock size="0.625rem" />
                      {localizeUi("ui.lorebooks.expandeddrawer.locked")}
                    </span>
                  )}
                  {isEdited && (
                    <span className="shrink-0 rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-[0.625rem] font-medium text-[var(--accent-foreground)]">
                      {localizeUi("ui.chat.mariediteasyviewer.actionEdited")}
                    </span>
                  )}
                  {!item.included && !locked && (
                    <span className="shrink-0 text-[0.625rem] text-[var(--muted-foreground)]">
                      {localizeUi("ui.characters.schedulemanager.skipped")}
                    </span>
                  )}
                </button>
                {!locked && (
                  <button
                    type="button"
                    onClick={item.editing ? () => update(index, { editing: false, snapshot: undefined }) : startEdit}
                    aria-pressed={item.editing}
                    aria-label={localizeUi("ui.modals.lorebookapprovalreview.edit", { name })}
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] max-sm:h-11 max-sm:w-11",
                      item.editing && "bg-[var(--accent)] text-[var(--accent-foreground)]",
                    )}
                  >
                    <Pencil size="0.8125rem" />
                  </button>
                )}
              </div>

              {item.open && (
                <div id={bodyId} className="flex flex-col gap-2.5 px-3 pb-3 sm:pl-10">
                  {entry.reason && (
                    <p className="text-[0.6875rem] italic text-[var(--muted-foreground)]">{entry.reason}</p>
                  )}
                  {(multipleBooks || entry.target.createsLorebook) && entry.target.lorebookName && (
                    <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
                      {localizeUi(
                        entry.target.createsLorebook
                          ? "ui.modals.lorebookapprovalreview.createsLorebook"
                          : "ui.modals.lorebookapprovalreview.targetLorebook",
                        { name: entry.target.lorebookName },
                      )}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-1">
                    <span className="mr-1 text-[0.625rem] font-semibold uppercase text-[var(--muted-foreground)]">
                      {localizeUi("ui.chat.mariediteasyviewer.primaryKeys")}
                    </span>
                    {existingKeys.map((key) => (
                      <span
                        key={`existing:${key}`}
                        className="rounded-md bg-[var(--secondary)]/60 px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]"
                      >
                        {key}
                      </span>
                    ))}
                    {newKeys.map((key) => {
                      const removed = item.removedKeys.includes(key);
                      if (removed) {
                        return (
                          <button
                            key={`new:${key}`}
                            type="button"
                            onClick={() =>
                              update(index, { removedKeys: item.removedKeys.filter((value) => value !== key) })
                            }
                            aria-label={localizeUi("ui.modals.lorebookapprovalreview.restoreKey", { key })}
                            title={localizeUi("ui.chat.databaseworkspaceapprovalcard.restore")}
                            className="rounded-md bg-[var(--destructive)]/25 px-1.5 py-0.5 text-[0.625rem] text-[var(--foreground)] line-through hover:opacity-80 max-sm:min-h-8"
                          >
                            {key}
                          </button>
                        );
                      }
                      return (
                        <span
                          key={`new:${key}`}
                          className="inline-flex items-center gap-0.5 rounded-md bg-emerald-500/25 py-0.5 pl-1.5 pr-0.5 text-[0.625rem] text-[var(--foreground)]"
                        >
                          {localizeUi("ui.modals.lorebookapprovalreview.addedKey", { key })}
                          {!locked && (
                            <button
                              type="button"
                              onClick={() => update(index, { removedKeys: [...item.removedKeys, key] })}
                              aria-label={localizeUi("ui.modals.lorebookapprovalreview.removeKey", { key })}
                              className="flex h-4 w-4 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] max-sm:h-8 max-sm:w-8"
                            >
                              <X size="0.625rem" />
                            </button>
                          )}
                        </span>
                      );
                    })}
                  </div>

                  {item.editing && (
                    <div className="flex flex-col gap-2">
                      {classification.action === "created" && (
                        <label className="flex flex-col gap-1">
                          <span className="text-[0.625rem] font-semibold uppercase text-[var(--muted-foreground)]">
                            {localizeUi("ui.lorebooks.lorebookeditor.name")}
                          </span>
                          <input
                            value={name}
                            onChange={(event) => update(index, { name: event.target.value })}
                            onKeyDown={(event) => event.key === "Escape" && event.stopPropagation()}
                            className="h-9 rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-3 text-xs text-[var(--foreground)] outline-none focus:border-[var(--ring)] focus:ring-1 focus:ring-[var(--ring)] max-sm:h-11"
                          />
                        </label>
                      )}
                      <label className="flex flex-col gap-1">
                        <span className="text-[0.625rem] font-semibold uppercase text-[var(--muted-foreground)]">
                          {localizeUi(
                            classification.action === "appended"
                              ? "ui.chat.mariediteasyviewer.content"
                              : "ui.chat.mariediteasyviewer.content",
                          )}
                        </span>
                        <textarea
                          value={body}
                          autoFocus
                          onChange={(event) => update(index, { draft: event.target.value })}
                          onKeyDown={(event) => event.key === "Escape" && event.stopPropagation()}
                          rows={Math.min(14, Math.max(4, body.split("\n").length + 1))}
                          className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-3 py-2 text-xs leading-relaxed text-[var(--foreground)] outline-none focus:border-[var(--ring)] focus:ring-1 focus:ring-[var(--ring)]"
                        />
                      </label>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => update(index, { editing: false, snapshot: undefined })}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90 max-sm:min-h-11"
                        >
                          <Check size="0.75rem" />
                          {localizeUi("ui.chat.summarypopover.done")}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--muted-foreground)] hover:bg-[var(--accent)] max-sm:min-h-11"
                        >
                          {localizeUi("decisionDebug.cancel")}
                        </button>
                        {(item.draft !== undefined || item.name !== undefined) && (
                          <button
                            type="button"
                            onClick={() => update(index, { draft: undefined, name: undefined })}
                            className="rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--muted-foreground)] hover:bg-[var(--accent)] max-sm:min-h-11"
                          >
                            {localizeUi("ui.modals.lorebookapprovalreview.resetToProposal")}
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="max-h-80 overflow-auto rounded-lg bg-[var(--secondary)]/40 p-2.5 ring-1 ring-[var(--border)] max-sm:max-h-none">
                    {classification.action === "created" && <PlainText text={body} />}
                    {classification.action === "appended" && (
                      <AppendedView existing={existingContent.trim()} added={body} />
                    )}
                    {classification.action === "replaced" && <DiffView rows={foldDiffRows(rows)} />}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <div className="rounded-lg bg-[var(--destructive)]/10 px-3 py-2 text-xs text-[var(--destructive)]">{error}</div>
      )}

      <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3 sm:flex-row sm:items-center">
        <p className="flex-1 text-[0.6875rem] text-[var(--muted-foreground)]">
          {localizeUi("ui.modals.lorebookapprovalreview.statusSelected", {
            selected,
            total: entries.length - counts.locked,
          })}
          {edited > 0 && ` · ${localizeUi("ui.modals.lorebookapprovalreview.statusEdited", { count: edited })}`}
          {skipped > 0 && ` · ${localizeUi("ui.modals.lorebookapprovalreview.statusSkipped")}`}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={copyAsText}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] max-sm:min-h-11"
          >
            <Copy size="0.75rem" />
            {localizeUi("markdown.copy")}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] disabled:opacity-50 max-sm:min-h-11"
          >
            <Trash2 size="0.75rem" />
            {localizeUi("ui.agents.agenteditor.discard")}
          </button>
          <button
            type="button"
            onClick={onRegenerate}
            disabled={!canRegenerate || busyAction !== null}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] disabled:opacity-50 max-sm:min-h-11"
          >
            {busyAction === "regenerate" ? (
              <Loader2 size="0.75rem" className="animate-spin" />
            ) : (
              <RefreshCw size="0.75rem" />
            )}
            {localizeUi("ui.agents.secretplotpanel.regenerate")}
          </button>
          <button
            type="button"
            onClick={() => onAccept(buildText(true))}
            disabled={busyAction !== null || selected === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-2 text-xs font-medium text-[var(--primary-foreground)] transition-all hover:opacity-90 disabled:opacity-50 max-sm:min-h-11"
          >
            {busyAction === "accept" ? <Loader2 size="0.75rem" className="animate-spin" /> : <Check size="0.75rem" />}
            {localizeUi("ui.modals.agentwriteapprovalmodal.accept")}
          </button>
        </div>
      </div>
    </div>
  );
}
