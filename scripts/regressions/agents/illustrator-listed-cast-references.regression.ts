// regression-layout: source-path the last check reads the generate routes to catch a fork rebase that drops their call to the matcher.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  illustratorReferenceMatchText,
  resolveIllustratorCharacterReferences,
} from "../../../packages/server/src/services/image/illustrator-references.js";

const cards = [
  { id: "doctor", name: "Dr. Veill" },
  { id: "nurse", name: "McKinley" },
  { id: "julian", name: "Julian" },
  { id: "atticus", name: "Atticus" },
];
const charactersStore = {
  list: async () => cards.map(({ id, name }) => ({ id, data: { name, appearance: `${id} appearance` } })),
};
const reply =
  "Dr. Veill watches from the doorway while McKinley clears the plates. Julian and Atticus sit at the table.";
const prompt = "Two young men sit at a long dining table under brass sconces.";
const resolve = (listedCast: string[]) =>
  resolveIllustratorCharacterReferences({
    charactersStore,
    chatCharacters: cards,
    requestedNames: listedCast,
    promptText: illustratorReferenceMatchText(listedCast, prompt, ["", "", "", reply]),
    includeReferenceImages: false,
  });

assert.deepEqual((await resolve(["Julian", "Atticus"])).characterIds, ["julian", "atticus"]);
assert.deepEqual((await resolve(["Atticus"])).characterIds, ["atticus"]);
assert.deepEqual(
  (await resolve([])).characterIds,
  ["doctor", "nurse", "julian", "atticus"],
  "without a listed cast the reply still names the references",
);
assert.equal(illustratorReferenceMatchText(["  ", 3], prompt, ["user", "reply"]), `user\n${prompt}\nreply`);
assert.equal(illustratorReferenceMatchText(["Julian"], prompt, ["user", "reply"]), prompt);

for (const route of ["generate.routes.ts", "generate/retry-agents-route.ts"]) {
  const source = readFileSync(new URL(`../../../packages/server/src/routes/${route}`, import.meta.url), "utf8");
  assert.match(source, /promptText: illustratorReferenceMatchText\(illCharacters, imagePrompt,/, route);
}
console.log("illustrator-listed-cast-references: ok");
