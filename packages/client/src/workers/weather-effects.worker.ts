import {
  advanceSnowParticle,
  AmbientSkyRenderer,
  ambientWindAt,
  clampWeatherTuning,
  createLightningStrike,
  createWeatherParticle,
  DEFAULT_WEATHER_TUNING,
  drawLightningBolt,
  drawLightningFlash,
  drawWeatherParticle,
  effectiveParticleCount,
  fadeWeatherParticlesForConfig,
  WIND_RESPONSE,
  type LightningStrike,
  type WeatherEffectTuning,
  type WeatherParticle,
  type WeatherRenderConfig,
} from "../lib/weather-renderer";

type InitMessage = {
  type: "init";
  canvas: OffscreenCanvas;
  config: WeatherRenderConfig;
  moonPhase: number;
  tuning: WeatherEffectTuning;
  showCelestial: boolean;
  width: number;
  height: number;
  scale: number;
};

type ResizeMessage = Pick<InitMessage, "width" | "height" | "scale"> & { type: "resize" };
type VisibilityMessage = { type: "visibility"; hidden: boolean };
type ConfigMessage = { type: "config"; config: WeatherRenderConfig; moonPhase: number };
type TuningMessage = { type: "tuning"; tuning: WeatherEffectTuning };
type WeatherWorkerMessage = InitMessage | ResizeMessage | VisibilityMessage | ConfigMessage | TuningMessage;

const FRAME_MS = 1000 / 30;
const BASE_FRAME_MS = 1000 / 60;
const FIREFLY_COUNT = 10;

let canvas: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;
let config: WeatherRenderConfig | null = null;
let showCelestial = true;
let width = 1;
let height = 1;
let scale = 1;
let particles: WeatherParticle[] = [];
let hidden = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let previousTime = 0;
let frameCount = 0;
let lightningAlpha = 0;
let nextLightning = Infinity;
let lightningStrike: LightningStrike | null = null;
let boltAlpha = 0;
let tuning: WeatherEffectTuning = DEFAULT_WEATHER_TUNING;
const renderer = new AmbientSkyRenderer();

function populateParticles() {
  if (!config) return;
  particles = [];
  const initialCount = effectiveParticleCount(config, tuning);
  for (let index = 0; index < initialCount; index += 1) {
    particles.push(createWeatherParticle(config.type, width, height, false, tuning));
  }
  if (config.addFireflies) {
    for (let index = 0; index < FIREFLY_COUNT; index += 1) {
      particles.push(createWeatherParticle("firefly", width, height));
    }
  }
}

function resizeSurface(nextWidth: number, nextHeight: number, nextScale: number) {
  if (!canvas || !context) return;
  width = Math.max(1, nextWidth);
  height = Math.max(1, nextHeight);
  scale = Math.max(0.1, nextScale);
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  context.setTransform(scale, 0, 0, scale, 0, 0);
  renderer.resize(width, height);
}

/** Adopt a config change mid-flight: crossfade the sky, turn particles over. */
function adoptConfig(nextConfig: WeatherRenderConfig, nextMoonPhase: number) {
  if (!renderer.setConfig(nextConfig, nextMoonPhase)) {
    config = nextConfig;
    return;
  }
  config = nextConfig;
  fadeWeatherParticlesForConfig(particles, nextConfig);
  if (nextConfig.lightning && nextLightning === Infinity) {
    nextLightning = frameCount + 200 + Math.random() * 400;
  } else if (!nextConfig.lightning) {
    nextLightning = Infinity;
  }
}

// No `hidden` check here: scheduleFrame() already refuses to run the loop while
// suspended, so this only ever blocked the two callers that must paint — init,
// and the resize below, whose canvas has just been cleared by its own resize.
function drawFrame(now: number, advanceSimulation = true) {
  if (!context || !config) {
    previousTime = now;
    return;
  }

  const elapsed = previousTime === 0 ? FRAME_MS : Math.min(100, now - previousTime);
  previousTime = now;
  const frameScale = advanceSimulation ? Math.min(3, Math.max(0.5, elapsed / BASE_FRAME_MS)) : 0;
  frameCount += frameScale;
  context.clearRect(0, 0, width, height);

  renderer.advance(frameScale);
  renderer.drawUnder(context, frameCount, frameScale);
  renderer.drawBodies(context, frameCount, showCelestial);
  renderer.drawOver(context, frameCount);

  const targetCount = effectiveParticleCount(config, tuning);
  const wind = ambientWindAt(frameCount) * config.mood.windStrength * tuning.wind;
  let baseCount = 0;
  for (const particle of particles) if (particle.type === config.type) baseCount += 1;

  for (let index = particles.length - 1; index >= 0; index -= 1) {
    const particle = particles[index]!;
    particle.life += frameScale;
    particle.x += particle.vx * frameScale;
    particle.y += particle.vy * frameScale;
    if (particle.type === "snow") {
      advanceSnowParticle(particle, frameCount, frameScale, wind);
    } else {
      if (particle.type === "leaf" || particle.type === "petal" || particle.type === "ash") {
        particle.wobble += 0.02 * frameScale;
        particle.x += Math.sin(particle.wobble) * 0.5 * frameScale;
      } else if (particle.type === "ember") {
        particle.wobble += 0.04 * frameScale;
        particle.x += Math.sin(particle.wobble) * 0.6 * frameScale;
      } else if (particle.type === "firefly") {
        particle.wobble += 0.03 * frameScale;
        particle.x += Math.sin(particle.wobble) * 0.8 * frameScale;
        particle.y += Math.cos(particle.wobble * 0.7) * 0.4 * frameScale;
      }
      const windResponse = WIND_RESPONSE[particle.type];
      if (windResponse) particle.x += wind * windResponse * frameScale;
    }
    drawWeatherParticle(context, particle);
    // Retired weather types fade out and are removed instead of respawning.
    const outside = particle.y > height + 20 || particle.y < -20 || particle.x > width + 20 || particle.x < -20;
    if (outside || particle.life > particle.maxLife) {
      if (particle.type === config.type && baseCount <= targetCount) {
        particles[index] = createWeatherParticle(particle.type, width, height, true, tuning);
      } else if (particle.type === "firefly" && config.addFireflies) {
        particles[index] = createWeatherParticle("firefly", width, height, true);
      } else {
        particles.splice(index, 1);
        if (particle.type === config.type) baseCount -= 1;
      }
    }
  }

  // Trickle the new weather's particles in rather than seeding all at once.
  if (baseCount < targetCount) {
    const deficit = Math.min(targetCount - baseCount, Math.ceil(2 * frameScale));
    for (let index = 0; index < deficit; index += 1) {
      particles.push(createWeatherParticle(config.type, width, height, true, tuning));
    }
  }
  if (config.addFireflies) {
    let fireflies = 0;
    for (const particle of particles) if (particle.type === "firefly") fireflies += 1;
    if (fireflies < FIREFLY_COUNT) particles.push(createWeatherParticle("firefly", width, height, true));
  }

  // Lightning flash (epilepsy-safe: capped alpha, gentle decay, long gap between flashes)
  if (config.lightning && frameCount >= nextLightning) {
    lightningAlpha = 0.45 + Math.random() * 0.15;
    nextLightning = frameCount + 400 + Math.random() * 800;
    lightningStrike = createLightningStrike(width, height);
    boltAlpha = 1;
  }
  if (lightningAlpha > 0 && lightningStrike) {
    drawLightningFlash(context, lightningStrike, lightningAlpha, width, height);
    if (boltAlpha > 0) {
      drawLightningBolt(context, lightningStrike, boltAlpha);
      boltAlpha -= frameScale / 8;
    }
    lightningAlpha *= Math.pow(0.88, frameScale);
    if (lightningAlpha < 0.01) lightningAlpha = 0;
  }
}

function scheduleFrame() {
  if (hidden || timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    if (hidden) return;
    try {
      drawFrame(performance.now());
      scheduleFrame();
    } catch {
      timer = null;
      self.postMessage({ type: "render-error" });
    }
  }, FRAME_MS);
}

function setSuspended(suspended: boolean) {
  hidden = suspended;
  previousTime = performance.now();
  if (hidden) {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    return;
  }
  scheduleFrame();
}

self.onmessage = (event: MessageEvent<WeatherWorkerMessage>) => {
  const message = event.data;
  if (message.type === "init") {
    canvas = message.canvas;
    context = canvas.getContext("2d");
    config = message.config;
    tuning = clampWeatherTuning(message.tuning);
    renderer.setConfig(message.config, message.moonPhase);
    renderer.setTuning(tuning);
    showCelestial = message.showCelestial;
    nextLightning = config.lightning ? 200 + Math.random() * 400 : Infinity;
    lightningStrike = null;
    boltAlpha = 0;
    resizeSurface(message.width, message.height, message.scale);
    populateParticles();
    drawFrame(performance.now());
    if (timer === null) scheduleFrame();
  } else if (message.type === "config") {
    // World-state update: crossfade in place — never a teardown.
    adoptConfig(message.config, message.moonPhase);
  } else if (message.type === "tuning") {
    tuning = clampWeatherTuning(message.tuning);
    renderer.setTuning(tuning);
  } else if (message.type === "resize") {
    resizeSurface(message.width, message.height, message.scale);
    // Resizing a canvas clears it. Repaint in the same worker task so the
    // browser never presents a blank weather layer between sidebar layouts.
    drawFrame(performance.now(), false);
  } else {
    setSuspended(message.hidden);
  }
};

self.postMessage({ type: "ready" });
