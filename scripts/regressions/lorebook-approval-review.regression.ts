// Lorebook Keeper approval review: the client rebuilds per-entry review data from the proposal text and sends
// the reviewed entries back in the same text format. These checks pin that round trip against the server's own
// formatter and parser, so the two cannot drift apart silently.
import assert from "node:assert/strict";
import {
  buildLorebookWriteApprovalProposal,
  parseLorebookWriteApprovalText,
} from "../../packages/server/src/routes/generate/agent-write-approval.js";
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
  type ExistingLorebookEntry,
} from "../../packages/client/src/lib/lorebook-approval-review.js";

const protocolBefore = [
  "Custody protocols for Crow:",
  "- Compliant Rest: Crow keeps his bedroom if he sleeps through the night.",
  "- Yard access is supervised between 15:00 and 16:00.",
  "- The basement requires direct escort.",
].join("\n");
const protocolAfter = [
  "Custody protocols for Crow:",
  "- Compliant Rest: Crow keeps his own bedroom if he sleeps through the night without incident.",
  "- The basement requires direct escort.",
  '- Forms of address: Crow must not call Benjamin "Ben".',
].join("\n");

const existing: ExistingLorebookEntry[] = [
  {
    id: "rel",
    lorebookId: "book",
    name: "Benjamin-Crow Relationship",
    content: "They share a history.\n\nCrow bullied Benjamin in school.",
    keys: ["Benjamin and Crow"],
    locked: false,
  },
  { id: "protocol", lorebookId: "book", name: "Custody Protocol", content: protocolBefore, keys: ["house rules"] },
  { id: "vault", lorebookId: "book", name: "Vault", content: "Sealed.", keys: [], locked: "true" },
];

const proposal = buildLorebookWriteApprovalProposal({
  chatId: "chat",
  agentType: "lorebook-keeper",
  agentName: "Lorebook Keeper",
  preferredTargetLorebookId: "book",
  writableLorebookIds: ["book"],
  writableLorebooks: [{ id: "book", name: "Benjamin Kurtz" }],
  existingEntries: existing,
  updates: [
    {
      action: "create",
      entryName: "Greta",
      content: "A retriever with a soft mouth.",
      keys: ["Greta"],
      tag: "character",
    },
    {
      action: "update",
      entryName: "Benjamin-Crow Relationship",
      newFacts: ["Crow is Benjamin's only registered dependent."],
      keys: ["Benjamin and Crow", "registered dependent"],
      reason: "A new fact about their arrangement.",
    },
    {
      action: "update",
      entryName: "Custody Protocol",
      content: protocolAfter,
      keys: ["house rules", "forms of address"],
    },
    { action: "update", entryName: "Vault", content: "Opened." },
  ],
});

// The client parses the proposal exactly as the server would.
const blocks = parseLorebookApprovalText(proposal.text);
const serverParsed = parseLorebookWriteApprovalText(proposal.text);
assert.deepEqual(
  blocks.map((block) => [block.name, block.content, block.keys]),
  serverParsed.map((update) => [update.name, update.content, update.keys]),
);
assert.equal(blocks.length, 4);

// Classification from the current entries.
const target = resolveApprovalTarget(blocks[0]!, proposal.payload ?? {});
assert.deepEqual(target, { lorebookId: "book", lorebookName: "Benjamin Kurtz", createsLorebook: false });
const classify = (index: number) =>
  classifyApprovalEntry(blocks[index]!, findExistingEntry(blocks[index]!.name, target, existing));
assert.equal(classify(0).action, "created");
const appended = classify(1);
assert.equal(appended.action, "appended");
assert.equal(appended.appendedText, "- Crow is Benjamin's only registered dependent.");
const replaced = classify(2);
assert.equal(replaced.action, "replaced");
assert.equal(classify(3).locked, true, 'a stored "true" lock string still counts as locked');
assert.equal(
  findExistingEntry("benjamin-crow relationship", target, existing)?.id,
  "rel",
  "entry names match case-insensitively, like the server",
);

// The diff pairs a reworded line, keeps a dropped line whole, and counts both.
const rows = diffEntryLines(protocolBefore, protocolAfter);
const stats = diffStats(rows);
assert.deepEqual(stats, { added: 1, removed: 1, changed: 1 });
assert.ok(
  rows.some((row) => row.kind === "removed" && row.text.includes("15:00")),
  "the dropped yard rule shows as removed",
);
const changed = rows.find((row) => row.kind === "changed");
assert.ok(changed && changed.kind === "changed" && changed.segments.some((segment) => segment.type === "added"));

const longBefore = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
const folded = foldDiffRows(diffEntryLines(longBefore, `${longBefore}\nline 12`));
assert.equal(folded[0]!.kind, "fold", "a long unchanged run before a change collapses");
assert.equal(folded.at(-1)!.kind, "added");

// Sending the review back: an edited append keeps the current text, a dropped proposed key is omitted,
// an excluded entry and the locked entry are left out, and the server parses the result as intended.
const reviewed = formatLorebookApprovalText([
  {
    ...blocks[1]!,
    keys: blocks[1]!.keys.filter((key) => key !== "registered dependent"),
    content: composeEntryContent(appended, "- Crow is Benjamin's sole registered dependent."),
  },
  blocks[2]!,
]);
const committed = parseLorebookWriteApprovalText(reviewed);
assert.equal(committed.length, 2);
assert.equal(committed[0]!.name, "Benjamin-Crow Relationship");
assert.equal(
  committed[0]!.content,
  "They share a history.\n\nCrow bullied Benjamin in school.\n\n- Crow is Benjamin's sole registered dependent.",
);
assert.deepEqual(committed[0]!.keys, ["Benjamin and Crow"]);
assert.equal(committed[1]!.content, protocolAfter);
assert.equal(formatLorebookApprovalText(blocks.slice(0, 1)), proposal.text.split("\n\n<!--")[0]);

// Routing mirrors the server: exact book name, naming-scheme alias, then the preferred book.
const routedPayload = {
  preferredTargetLorebookId: "book",
  allowTargetRouting: true,
  writableLorebooks: [
    { id: "book", name: "Benjamin Kurtz" },
    { id: "places", name: "Kurtz Places" },
  ],
  lorebookNamingScheme: { location: "[WorldName] Places", faction: "[WorldName] Factions" },
  worldName: "Kurtz",
};
const block = blocks[0]!;
assert.equal(resolveApprovalTarget({ ...block, targetLorebook: "Kurtz Places" }, routedPayload).lorebookId, "places");
assert.equal(resolveApprovalTarget({ ...block, targetLorebook: "location" }, routedPayload).lorebookId, "places");
assert.deepEqual(resolveApprovalTarget({ ...block, targetLorebook: "faction" }, routedPayload), {
  lorebookId: null,
  lorebookName: "Kurtz Factions",
  createsLorebook: true,
});
assert.equal(resolveApprovalTarget({ ...block, targetLorebook: "Unknown" }, routedPayload).lorebookId, "book");
assert.equal(
  resolveApprovalTarget({ ...block, targetLorebook: "Kurtz Places" }, { ...routedPayload, allowTargetRouting: false })
    .lorebookId,
  "book",
);

console.log("lorebook approval review: ok");
