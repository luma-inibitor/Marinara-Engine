import assert from "node:assert/strict";
import {
  ambientWindAt,
  deriveMoonPhase,
  moonAltitude,
  resolveWeatherRenderConfig,
  sampleSkyPalette,
  sunElevation,
} from "../../packages/client/src/lib/weather-renderer.js";

// The ambient sky layer is an overlay above a user-chosen chat background.
// These checks pin the pure decisions that keep it honest: weather moods stay
// alpha-capped, the scene only activates when there is something to draw, and
// the lunar phase derived from free-text dates is stable and in range.

// ── Scene activation ──
// No world state at all → nothing renders (matches the pre-scene behavior).
const empty = resolveWeatherRenderConfig(null, null);
assert.equal(empty.sceneActive, false);
assert.equal(empty.sceneHour, -1);

// A parsed clock time activates the sky even with no weather string.
const nightOnly = resolveWeatherRenderConfig(null, "21:00");
assert.equal(nightOnly.sceneActive, true);
assert.equal(nightOnly.sceneHour, 21);
assert.equal(nightOnly.celestial, "moon");

// A phase keyword with no clock still yields a usable scene hour.
const duskPhrase = resolveWeatherRenderConfig("clear", "dusk");
assert.equal(duskPhrase.sceneHour, 18);
const unparsed = resolveWeatherRenderConfig("clear", "witching hour");
assert.equal(unparsed.celestial, "none");
assert.equal(unparsed.sceneHour, -1);

// Weather alone (no time) can still activate cloud deck / veil passes.
const overcastOnly = resolveWeatherRenderConfig("overcast", null);
assert.equal(overcastOnly.sceneActive, true);
assert.ok(overcastOnly.mood.cloudiness >= 0.9);

// ── Mood table invariants ──
const MOOD_CASES: Array<[string | null, string]> = [
  [null, "empty"],
  ["clear skies", "clear"],
  ["overcast", "overcast"],
  ["heavy rain", "rain"],
  ["thunderstorm", "storm"],
  ["blizzard", "blizzard"],
  ["fog", "fog"],
  ["sandstorm", "sand"],
  ["volcanic ash", "ash"],
  ["cherry blossoms on the wind", "petal"],
  ["aurora borealis", "aurora"],
];
for (const [weather, label] of MOOD_CASES) {
  const { mood } = resolveWeatherRenderConfig(weather, "14:00");
  // Every veil stays a tint: the background must read through.
  if (mood.veil) assert.ok(mood.veil[3] <= 0.3, `${label}: veil alpha ${mood.veil[3]} exceeds 0.3`);
  assert.ok(mood.bodyDim > 0 && mood.bodyDim <= 1, `${label}: bodyDim out of range`);
  assert.ok(mood.cloudiness >= 0 && mood.cloudiness <= 1, `${label}: cloudiness out of range`);
  assert.ok(mood.starIntensity >= 0 && mood.starIntensity <= 1, `${label}: starIntensity out of range`);
  assert.ok(mood.murk >= 0 && mood.murk <= 1, `${label}: murk out of range`);
}

// Storms dim and diffuse the body hardest; clear weather not at all.
assert.equal(resolveWeatherRenderConfig("clear", "noon").mood.bodyDim, 1);
assert.equal(resolveWeatherRenderConfig("clear", "noon").mood.murk, 0);
assert.ok(resolveWeatherRenderConfig("thunderstorm", "noon").mood.bodyDim < 0.5);
assert.ok(resolveWeatherRenderConfig("thunderstorm", "noon").mood.murk >= 0.8);
assert.ok(resolveWeatherRenderConfig("thick fog", "noon").mood.murk > resolveWeatherRenderConfig("light snow", "noon").mood.murk);
// Fog is the only fog-bank weather.
assert.equal(resolveWeatherRenderConfig("thick fog", "noon").mood.fogBanks, true);
assert.equal(resolveWeatherRenderConfig("heavy rain", "noon").mood.fogBanks, false);

// ── Sky palette ──
// Every channel stays a real color at every quarter hour, and midnight wraps.
for (let hour = 0; hour <= 24; hour += 0.25) {
  const palette = sampleSkyPalette(hour);
  for (const channel of [...palette.top, ...palette.mid, ...palette.horizon, ...palette.light]) {
    assert.ok(channel >= 0 && channel <= 255, `palette out of range at hour ${hour}`);
  }
}
const wrapA = sampleSkyPalette(0);
const wrapB = sampleSkyPalette(24);
assert.deepEqual(wrapA.top.map(Math.round), wrapB.top.map(Math.round));

// Elevation sanity: noon peak, midnight trough, dawn/dusk zero crossings.
assert.equal(Math.round(sunElevation(12) * 100), 100);
assert.ok(sunElevation(0) < -0.99);
assert.ok(Math.abs(sunElevation(6)) < 1e-9);
// Moon rides high around midnight and is grounded outside its 21h→5h arc.
assert.ok(moonAltitude(0) > 0.95);
assert.ok(moonAltitude(0.5) > moonAltitude(4));
assert.ok(moonAltitude(21) < 0.01);
assert.ok(moonAltitude(12) <= 0.01);

// ── Moon phase from free-text dates ──
// Campaign day counters progress the moon night over night.
const day1 = deriveMoonPhase("Day 1");
const day8 = deriveMoonPhase("Day 8");
assert.equal(day1, 0);
assert.ok(Math.abs(day8 - 7 / 29.530588) < 1e-9);
// ISO dates give a continuous cycle: +15 days is roughly half a cycle away.
const isoA = deriveMoonPhase("2026-08-01");
const isoB = deriveMoonPhase("2026-08-16");
const separation = Math.abs(isoB - isoA);
assert.ok(Math.abs(Math.min(separation, 1 - separation) - 15 / 29.530588) < 0.02);
// "March 14th" style parses; fantasy calendars fall back to a stable hash.
const march = deriveMoonPhase("March 14th, Year of the Wyrm");
assert.ok(march >= 0 && march < 1);
assert.equal(deriveMoonPhase("3rd of Mirtul"), deriveMoonPhase("3rd of Mirtul"));
assert.equal(deriveMoonPhase(null), deriveMoonPhase(undefined));
// Case and whitespace do not change the phase.
assert.equal(deriveMoonPhase("  Day 12 "), deriveMoonPhase("day 12"));
// Everything stays in [0, 1).
for (const text of [null, "Day 999999", "2026-01-01", "13th", "Winterfest eve", "Day 30"]) {
  const phase = deriveMoonPhase(text);
  assert.ok(phase >= 0 && phase < 1, `phase out of range for ${text}`);
}

// ── Wind field ──
// Bounded (|wind| < 1.01 by construction) and actually varies over time.
let minWind = Infinity;
let maxWind = -Infinity;
for (let frame = 0; frame < 20000; frame += 7) {
  const wind = ambientWindAt(frame);
  minWind = Math.min(minWind, wind);
  maxWind = Math.max(maxWind, wind);
}
assert.ok(maxWind <= 1.01 && minWind >= -1.01);
assert.ok(maxWind - minWind > 1);

console.log("ambient-sky regression: all checks passed");
