import assert from "node:assert/strict";
import { sanitizeApiError } from "../../../packages/server/src/services/llm/base-provider.js";
import { runNamedCases } from "../fixtures/named-cases.js";

const providerRaw = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "Schemas contains too many optional parameters (25). Reduce the number of optional parameters (limit: 24).",
  },
});

await runNamedCases([
  {
    name: "an OpenRouter refusal keeps the provider's own message from metadata.raw",
    run: () => {
      const body = JSON.stringify({
        error: { message: "Provider returned error", code: 400, metadata: { raw: providerRaw, provider_name: "Google" } },
      });
      assert.equal(
        sanitizeApiError(body),
        "Provider returned error (Google: Schemas contains too many optional parameters (25). Reduce the number of optional parameters (limit: 24).)",
      );
    },
  },
  {
    name: "a plain-text raw is kept as is",
    run: () => {
      const body = JSON.stringify({ error: { message: "Provider returned error", metadata: { raw: "upstream timed out" } } });
      assert.equal(sanitizeApiError(body), "Provider returned error (upstream timed out)");
    },
  },
  {
    name: "an error without metadata is unchanged",
    run: () => {
      assert.equal(sanitizeApiError(JSON.stringify({ error: { message: "Invalid API key" } })), "Invalid API key");
    },
  },
]);
