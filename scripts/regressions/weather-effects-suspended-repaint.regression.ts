// ─────────────────────────────────────────────────────────────
// Weather effects: repaint on resize while ambient rendering is suspended
// ─────────────────────────────────────────────────────────────
// The roleplay surface suspends the weather layer while the mobile composer
// is focused (WeatherEffects `paused`). On Android the software keyboard that
// opens right after also resizes the layout viewport, so a `resize` message
// reaches the worker while it is suspended. Assigning canvas.width/height
// clears the canvas, so the resize handler has to repaint even while
// suspended — otherwise the weather layer stays blank for as long as the
// keyboard is up.
//
// Guards:
//  - worker repaints the frozen scene on `resize` while suspended
//  - that repaint does not restart the animation loop
//  - the main-thread fallback repaints inside its own resize handler
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// ── Recording 2D context stub ──
type Call = { method: string; args: unknown[] };

function createContextStub() {
  const calls: Call[] = [];
  const gradient = { addColorStop() {} };
  const target: Record<string, unknown> = {};
  const context = new Proxy(target, {
    get(_source, property: string) {
      if (property in target) return target[property];
      return (...args: unknown[]) => {
        calls.push({ method: property, args });
        if (property === "createLinearGradient" || property === "createRadialGradient") return gradient;
        return undefined;
      };
    },
    set(_source, property: string, value) {
      target[property] = value;
      return true;
    },
  });
  return { calls, context };
}

function createCanvasStub(context: unknown) {
  return { width: 0, height: 0, getContext: () => context };
}

// ── Worker environment stub (must exist before the module body runs) ──
const posted: unknown[] = [];
const workerSelf = {
  postMessage(message: unknown) {
    posted.push(message);
  },
  onmessage: null as null | ((event: { data: unknown }) => void),
};
(globalThis as Record<string, unknown>).self = workerSelf;

const { resolveWeatherRenderConfig } = await import("../../packages/client/src/lib/weather-renderer.js");
await import("../../packages/client/src/workers/weather-effects.worker.js");

assert.deepEqual(posted, [{ type: "ready" }], "worker must announce readiness on load");
assert.equal(typeof workerSelf.onmessage, "function", "worker must install a message handler");
const send = (data: unknown) => workerSelf.onmessage?.({ data });

// Rain at night: particles, a tint and stars — a scene with plenty to repaint.
const config = resolveWeatherRenderConfig("rain", "night");
assert.ok(config.count > 0, "rain config must carry particles for this regression to mean anything");

const { calls, context } = createContextStub();
const canvas = createCanvasStub(context);

send({ type: "init", canvas, config, showCelestial: true, width: 800, height: 600, scale: 1 });
assert.ok(
  calls.some((call) => call.method === "clearRect"),
  "init must paint the first frame",
);
assert.equal(canvas.width, 800, "init must size the canvas backing store");

// ── Suspend, as the composer focus / keyboard-open path does ──
send({ type: "visibility", hidden: true });
calls.length = 0;
send({ type: "visibility", hidden: true });
assert.equal(calls.length, 0, "a suspended worker must not paint on its own");

// ── The keyboard's viewport resize arrives while suspended ──
send({ type: "resize", width: 800, height: 320, scale: 1 });

assert.equal(canvas.width, 800, "resize must size the canvas backing store");
assert.equal(canvas.height, 320, "resize must size the canvas backing store");
assert.ok(
  calls.some((call) => call.method === "clearRect"),
  "resize while suspended must repaint — canvas.width/height assignment clears the canvas",
);
assert.ok(
  calls.filter((call) => call.method === "fillRect" || call.method === "fill").length > 0,
  "resize while suspended must redraw the scene, not just clear it",
);
const repaintCallCount = calls.length;

// ── The forced repaint must not restart the animation loop ──
await new Promise((resolve) => setTimeout(resolve, 150));
assert.equal(
  calls.length,
  repaintCallCount,
  "a repaint while suspended must stay a single frame — the loop must remain stopped",
);

// ── Resuming repaints and restarts the loop ──
send({ type: "visibility", hidden: false });
await new Promise((resolve) => setTimeout(resolve, 150));
assert.ok(calls.length > repaintCallCount, "resuming must restart the animation loop");

// Stop the worker's frame timer so this regression can exit.
send({ type: "visibility", hidden: true });

// ── Main-thread fallback keeps the same guarantee ──
const fallbackSource = readFileSync(join(repoRoot, "packages/client/src/components/chat/WeatherEffects.tsx"), "utf8");
const resizeBody = /const resize = \(\) => \{([\s\S]*?)\n {4}\};/u.exec(fallbackSource);
assert.ok(resizeBody, "WeatherEffects must keep a `resize` handler in the main-thread fallback");
assert.match(
  resizeBody[1],
  /renderFrame\(0\)/u,
  "the fallback resize handler must repaint the frozen scene — the rAF loop is stopped while paused",
);

console.log("weather-effects suspended-repaint regression passed");
