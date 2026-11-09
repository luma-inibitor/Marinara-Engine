/**
 * Generation records a saved message carries that only its newest copies need: the prompt sent (for Peek Prompt)
 * and the Advanced Memory snapshot (reused when that message is regenerated). Each is about as large as the whole
 * prompt, so a long chat that kept them on every message grew to hundreds of megabytes of records around a few
 * megabytes of story.
 */
export const PRUNED_GENERATION_RECORD_KEYS = ["cachedPrompt", "advancedMemorySnapshot"] as const;

/** How many of the newest messages of each role keep their records. */
export const GENERATION_RECORDS_KEPT_PER_ROLE = 2;

type ExtraHolder = { extra?: unknown };
type PrunableMessage = ExtraHolder & { id: string; role: string };
type PrunableSwipe = ExtraHolder & { index: number };

export type GenerationRecordStorage = {
  listMessages(chatId: string): Promise<PrunableMessage[]>;
  updateMessageExtra(id: string, partial: Record<string, unknown>): Promise<unknown>;
  getSwipes(messageId: string): Promise<PrunableSwipe[]>;
  updateSwipeExtra(messageId: string, swipeIndex: number, partial: Record<string, unknown>): Promise<unknown>;
};

// Stored extras are JSON.stringify output, so a present record always starts exactly like this. Checking the
// string first keeps the per-turn sweep from parsing every message's extras.
const RECORD_MARKERS: Record<(typeof PRUNED_GENERATION_RECORD_KEYS)[number], string> = {
  cachedPrompt: '"cachedPrompt":[',
  advancedMemorySnapshot: '"advancedMemorySnapshot":{',
};

/** The record keys this extra still holds, as a partial that clears them; null when it holds none. */
export function generationRecordClearPatch(extra: unknown): Record<string, null> | null {
  let record: Record<string, unknown> | null = null;
  if (typeof extra === "string") {
    if (!PRUNED_GENERATION_RECORD_KEYS.some((key) => extra.includes(RECORD_MARKERS[key]))) return null;
    try {
      const parsed: unknown = JSON.parse(extra);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) record = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    record = extra as Record<string, unknown>;
  }
  if (!record) return null;
  const patch: Record<string, null> = {};
  for (const key of PRUNED_GENERATION_RECORD_KEYS) {
    if (record[key] !== null && record[key] !== undefined) patch[key] = null;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Messages past the newest GENERATION_RECORDS_KEPT_PER_ROLE of their role, oldest first. Per role, because a
 * generated user-role message (an impersonation) carries the same records as a reply; keeping only the newest
 * assistant messages, as upstream does, left every impersonated turn holding its prompt for good.
 */
export function messagesPastRecordWindow<T extends PrunableMessage>(messages: readonly T[]): T[] {
  const seen = new Map<string, number>();
  const stale: T[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const count = (seen.get(message.role) ?? 0) + 1;
    seen.set(message.role, count);
    if (count > GENERATION_RECORDS_KEPT_PER_ROLE) stale.push(message);
  }
  return stale.reverse();
}

/** Clears the records from every message past the window, and from each of its swipes. Returns the messages cleared. */
export async function pruneStaleGenerationRecords(storage: GenerationRecordStorage, chatId: string): Promise<number> {
  const messages = await storage.listMessages(chatId);
  let cleared = 0;
  for (const message of messagesPastRecordWindow(messages)) {
    const patch = generationRecordClearPatch(message.extra);
    if (!patch) continue;
    await storage.updateMessageExtra(message.id, patch);
    for (const swipe of await storage.getSwipes(message.id)) {
      const swipePatch = generationRecordClearPatch(swipe.extra);
      if (swipePatch) await storage.updateSwipeExtra(message.id, swipe.index, swipePatch);
    }
    cleared += 1;
  }
  return cleared;
}
