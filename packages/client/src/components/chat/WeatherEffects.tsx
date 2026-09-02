// ──────────────────────────────────────────────
// Chat: Dynamic Weather Effects — ambient particles
// that change based on roleplay weather + time of day
// ──────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from "react";
import { advanceWeatherFrameClock } from "../../lib/weather-frame-clock";
import { useReducedAmbientEffects } from "../../hooks/use-reduced-ambient-effects";
import { useUIStore } from "../../stores/ui.store";
import {
  advanceSnowParticle,
  AmbientSkyRenderer,
  ambientWindAt,
  createLightningStrike,
  createWeatherParticle,
  deriveMoonPhase,
  drawLightningBolt,
  drawLightningFlash,
  clampWeatherTuning,
  drawWeatherParticle,
  effectiveParticleCount,
  fadeWeatherParticlesForConfig,
  resolveWeatherRenderConfig,
  WIND_RESPONSE,
  type LightningStrike,
  type WeatherParticle,
  type WeatherRenderConfig,
} from "../../lib/weather-renderer";

const MAX_CANVAS_DPR = 1;
const MAX_CANVAS_PIXELS = 1920 * 1080;
const BASE_FRAME_MS = 1000 / 60;
const FIREFLY_COUNT = 10;

interface WeatherEffectsProps {
  weather?: string | null;
  timeOfDay?: string | null;
  /** World tracker date text; drives the lunar phase. */
  worldDate?: string | null;
  showCelestial?: boolean;
  /** Freeze ambient rendering while local text generation needs the GPU. */
  paused?: boolean;
}

// ═══════════════════════════════════════════════
// Main component
// ═══════════════════════════════════════════════

export function WeatherEffects({
  weather,
  timeOfDay,
  worldDate,
  showCelestial = true,
  paused = false,
}: WeatherEffectsProps) {
  const reduceAmbientEffects = useReducedAmbientEffects();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<WeatherParticle[]>([]);
  const frameRef = useRef<number>(0);
  const workerRef = useRef<Worker | null>(null);
  const pausedRef = useRef(paused);
  const resumeFallbackRef = useRef<(() => void) | null>(null);
  const [workerFailed, setWorkerFailed] = useState(false);
  pausedRef.current = paused;

  useEffect(() => {
    workerRef.current?.postMessage({ type: "visibility", hidden: document.hidden || paused });
    resumeFallbackRef.current?.();
  }, [paused]);

  const config = useMemo(() => {
    return resolveWeatherRenderConfig(weather, timeOfDay);
  }, [weather, timeOfDay]);
  const moonPhase = useMemo(() => deriveMoonPhase(worldDate), [worldDate]);
  const storedTuning = useUIStore((s) => s.weatherTuning);
  const tuning = useMemo(() => clampWeatherTuning(storedTuning), [storedTuning]);
  // The render loops read these through refs so a world-state update flows
  // into the living canvas as a crossfade instead of remounting it.
  const configRef = useRef(config);
  configRef.current = config;
  const moonPhaseRef = useRef(moonPhase);
  moonPhaseRef.current = moonPhase;
  const tuningRef = useRef(tuning);
  tuningRef.current = tuning;

  // Worker path: push config changes as messages; the worker crossfades.
  useEffect(() => {
    workerRef.current?.postMessage({ type: "config", config, moonPhase });
  }, [config, moonPhase]);
  useEffect(() => {
    workerRef.current?.postMessage({ type: "tuning", tuning });
  }, [tuning]);

  // Render when we have particles, celestial bodies, or time-based ambient effects
  const shouldDrawCelestial = showCelestial && config.celestial !== "none";
  const shouldRender =
    !reduceAmbientEffects && (config.count > 0 || config.addFireflies || shouldDrawCelestial || config.sceneActive);

  useEffect(() => {
    if (!shouldRender) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!workerFailed && typeof Worker !== "undefined" && "transferControlToOffscreen" in canvas) {
      let worker: Worker | null = null;
      let resizeObserver: ResizeObserver | null = null;
      let visibilityHandler: (() => void) | null = null;
      let readinessTimer: ReturnType<typeof window.setTimeout> | null = null;

      // Deferring the irreversible transfer also makes this safe under React's
      // development StrictMode effect probe: its first mount is cleaned up
      // before the canvas ownership changes.
      const initializeTimer = window.setTimeout(() => {
        const rect = canvas.parentElement?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return;

        worker = new Worker(new URL("../../workers/weather-effects.worker.ts", import.meta.url), { type: "module" });
        workerRef.current = worker;
        const failWorker = () => setWorkerFailed(true);
        worker.onerror = failWorker;
        worker.onmessage = (event: MessageEvent<{ type?: string }>) => {
          if (event.data.type === "render-error") {
            failWorker();
            return;
          }
          if (event.data.type !== "ready") return;
          if (readinessTimer !== null) window.clearTimeout(readinessTimer);

          const getScale = (width: number, height: number) => {
            const pixelBudgetScale = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
            return Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR, pixelBudgetScale);
          };
          try {
            const offscreen = canvas.transferControlToOffscreen();
            worker?.postMessage(
              {
                type: "init",
                canvas: offscreen,
                config: configRef.current,
                moonPhase: moonPhaseRef.current,
                tuning: tuningRef.current,
                showCelestial,
                width: rect.width,
                height: rect.height,
                scale: getScale(rect.width, rect.height),
              },
              [offscreen],
            );
          } catch {
            failWorker();
            return;
          }

          resizeObserver = new ResizeObserver((entries) => {
            const size = entries[0]?.contentRect;
            if (!size || size.width <= 0 || size.height <= 0) return;
            worker?.postMessage({
              type: "resize",
              width: size.width,
              height: size.height,
              scale: getScale(size.width, size.height),
            });
          });
          if (canvas.parentElement) resizeObserver.observe(canvas.parentElement);

          visibilityHandler = () =>
            worker?.postMessage({ type: "visibility", hidden: document.hidden || pausedRef.current });
          document.addEventListener("visibilitychange", visibilityHandler);
          visibilityHandler();
        };
        readinessTimer = window.setTimeout(failWorker, 3_000);
      }, 0);

      return () => {
        window.clearTimeout(initializeTimer);
        if (readinessTimer !== null) window.clearTimeout(readinessTimer);
        resizeObserver?.disconnect();
        if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
        if (workerRef.current === worker) workerRef.current = null;
        worker?.terminate();
      };
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;
    const renderer = new AmbientSkyRenderer();
    let activeConfig: WeatherRenderConfig = configRef.current;
    renderer.setConfig(activeConfig, moonPhaseRef.current);
    renderer.setTuning(tuningRef.current);
    let lightningAlpha = 0; // for lightning flash
    let lightningStrike: LightningStrike | null = null;
    let boltAlpha = 0;
    let nextLightning = activeConfig.lightning ? 200 + Math.random() * 400 : Infinity;
    let frameCount = 0;
    let previousFrameTime = 0;
    let accumulatedFrameTime = 0;

    let canvasScale = 1;
    let resizePending = false;
    const resize = () => {
      // Resizing clears the canvas and the rAF loop is stopped while paused, so
      // resizing now would leave the layer blank until it resumes. Defer it.
      if (document.hidden || pausedRef.current) {
        resizePending = true;
        return;
      }
      resizePending = false;
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const pixelBudgetScale = Math.sqrt(MAX_CANVAS_PIXELS / (rect.width * rect.height));
      canvasScale = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR, pixelBudgetScale);
      canvas.width = Math.max(1, Math.round(rect.width * canvasScale));
      canvas.height = Math.max(1, Math.round(rect.height * canvasScale));
      ctx.setTransform(canvasScale, 0, 0, canvasScale, 0, 0);
      renderer.resize(rect.width, rect.height);
    };
    resize();
    window.addEventListener("resize", resize);

    // Initialize particles — use CSS pixel dimensions (not canvas resolution)
    particlesRef.current = [];
    const w = canvas.width / canvasScale;
    const h = canvas.height / canvasScale;

    const initialCount = effectiveParticleCount(activeConfig, tuningRef.current);
    for (let i = 0; i < initialCount; i++) {
      particlesRef.current.push(createWeatherParticle(activeConfig.type, w, h, false, tuningRef.current));
    }
    if (activeConfig.addFireflies) {
      for (let i = 0; i < FIREFLY_COUNT; i++) {
        particlesRef.current.push(createWeatherParticle("firefly", w, h));
      }
    }

    const tick = (timestamp: number) => {
      if (!running) return;
      if (document.hidden || pausedRef.current) {
        previousFrameTime = timestamp;
        accumulatedFrameTime = 0;
        frameRef.current = 0;
        return;
      }

      if (previousFrameTime === 0) previousFrameTime = timestamp;
      const elapsed = Math.min(100, timestamp - previousFrameTime);
      previousFrameTime = timestamp;
      const frameStep = advanceWeatherFrameClock(accumulatedFrameTime, elapsed);
      accumulatedFrameTime = frameStep.accumulatedMs;
      if (!frameStep.shouldDraw) {
        frameRef.current = requestAnimationFrame(tick);
        return;
      }
      const frameScale = Math.min(3, Math.max(0.5, frameStep.frameElapsedMs / BASE_FRAME_MS));

      const cw = canvas.width / canvasScale;
      const ch = canvas.height / canvasScale;
      ctx.clearRect(0, 0, cw, ch);
      frameCount += frameScale;

      // Adopt world-state changes without remounting: the renderer crossfades
      // the sky, particles turn over gradually below.
      if (renderer.setConfig(configRef.current, moonPhaseRef.current)) {
        activeConfig = configRef.current;
        fadeWeatherParticlesForConfig(particlesRef.current, activeConfig);
        if (activeConfig.lightning && nextLightning === Infinity) {
          nextLightning = frameCount + 200 + Math.random() * 400;
        } else if (!activeConfig.lightning) {
          nextLightning = Infinity;
        }
      }
      renderer.setTuning(tuningRef.current);
      renderer.advance(frameScale);

      renderer.drawUnder(ctx, frameCount, frameScale);
      renderer.drawBodies(ctx, frameCount, showCelestial);
      renderer.drawOver(ctx, frameCount);

      const tuningNow = tuningRef.current;
      const targetCount = effectiveParticleCount(activeConfig, tuningNow);
      const wind = ambientWindAt(frameCount) * activeConfig.mood.windStrength * tuningNow.wind;
      const particles = particlesRef.current;
      let baseCount = 0;
      for (const p of particles) if (p.type === activeConfig.type) baseCount++;

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += frameScale;

        // Update position
        p.x += p.vx * frameScale;
        p.y += p.vy * frameScale;

        // Wobble for organic movement
        if (p.type === "snow") {
          advanceSnowParticle(p, frameCount, frameScale, wind);
        } else {
          if (p.type === "leaf" || p.type === "petal" || p.type === "ash") {
            p.wobble += 0.02 * frameScale;
            p.x += Math.sin(p.wobble) * 0.5 * frameScale;
          }
          if (p.type === "ember") {
            p.wobble += 0.04 * frameScale;
            p.x += Math.sin(p.wobble) * 0.6 * frameScale;
          }
          if (p.type === "firefly") {
            p.wobble += 0.03 * frameScale;
            p.x += Math.sin(p.wobble) * 0.8 * frameScale;
            p.y += Math.cos(p.wobble * 0.7) * 0.4 * frameScale;
          }
          const windResponse = WIND_RESPONSE[p.type];
          if (windResponse) p.x += wind * windResponse * frameScale;
        }

        drawWeatherParticle(ctx, p);

        // Respawn if off-screen or expired. After a weather change, particles
        // of retired types are removed here instead of respawning, so one
        // weather fades out while the next trickles in.
        const offScreen = p.y > ch + 20 || p.y < -20 || p.x > cw + 20 || p.x < -20;
        if (offScreen || p.life > p.maxLife) {
          if (p.type === activeConfig.type && baseCount <= targetCount) {
            particles[i] = createWeatherParticle(p.type, cw, ch, true, tuningNow);
          } else if (p.type === "firefly" && activeConfig.addFireflies) {
            particles[i] = createWeatherParticle("firefly", cw, ch, true);
          } else {
            particles.splice(i, 1);
            if (p.type === activeConfig.type) baseCount--;
          }
        }
      }

      // Trickle the new weather's particles in rather than seeding them all at once.
      if (baseCount < targetCount) {
        const deficit = Math.min(targetCount - baseCount, Math.ceil(2 * frameScale));
        for (let i = 0; i < deficit; i++) {
          particles.push(createWeatherParticle(activeConfig.type, cw, ch, true, tuningNow));
        }
      }
      if (activeConfig.addFireflies) {
        let fireflies = 0;
        for (const p of particles) if (p.type === "firefly") fireflies++;
        if (fireflies < FIREFLY_COUNT) particles.push(createWeatherParticle("firefly", cw, ch, true));
      }

      // Lightning flash (epilepsy-safe: capped alpha, gentle decay, long gap between flashes)
      if (activeConfig.lightning) {
        if (frameCount >= nextLightning) {
          lightningAlpha = 0.45 + Math.random() * 0.15; // soft flash, max 0.6
          nextLightning = frameCount + 400 + Math.random() * 800; // next in ~7-20s at 60fps
          lightningStrike = createLightningStrike(cw, ch);
          boltAlpha = 1;
        }
      }
      if (lightningAlpha > 0 && lightningStrike) {
        drawLightningFlash(ctx, lightningStrike, lightningAlpha, cw, ch);
        if (boltAlpha > 0) {
          drawLightningBolt(ctx, lightningStrike, boltAlpha);
          boltAlpha -= frameScale / 8;
        }
        lightningAlpha *= Math.pow(0.88, frameScale); // gentle decay
        if (lightningAlpha < 0.01) lightningAlpha = 0;
      }

      frameRef.current = requestAnimationFrame(tick);
    };

    const ensureFallbackRunning = () => {
      if (!running || document.hidden || pausedRef.current || frameRef.current !== 0) return;
      if (resizePending) resize();
      frameRef.current = requestAnimationFrame(tick);
    };
    resumeFallbackRef.current = ensureFallbackRunning;
    const onVisibilityChange = ensureFallbackRunning;
    document.addEventListener("visibilitychange", onVisibilityChange);

    ensureFallbackRunning();

    return () => {
      running = false;
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
      if (resumeFallbackRef.current === ensureFallbackRunning) resumeFallbackRef.current = null;
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // configRef/moonPhaseRef flow config changes into the running loop; only
    // render-target changes rebuild the pipeline.
  }, [shouldRender, showCelestial, workerFailed]);

  if (!shouldRender) return null;

  return (
    <canvas
      key={`${showCelestial ? "celestial" : "particles"}:${workerFailed ? "fallback" : "worker"}`}
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 z-0 h-full w-full transform-gpu [contain:strict] [will-change:transform]"
    />
  );
}
