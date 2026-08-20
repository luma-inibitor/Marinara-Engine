// ──────────────────────────────────────────────
// Chat: Dynamic Weather Effects — ambient particles
// that change based on roleplay weather + time of day
// ──────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from "react";
import { advanceWeatherFrameClock } from "../../lib/weather-frame-clock";
import { useReducedAmbientEffects } from "../../hooks/use-reduced-ambient-effects";
import {
  AmbientScene,
  ambientWindAt,
  createLightningStrike,
  createWeatherParticle,
  deriveMoonPhase,
  drawLightningBolt,
  drawLightningFlash,
  drawLuminousMoon,
  drawLuminousSun,
  drawWeatherParticle,
  moonAltitude,
  resolveWeatherRenderConfig,
  sunElevation,
  weatherCelestialX,
  weatherCelestialY,
  WIND_RESPONSE,
  type LightningStrike,
  type WeatherParticle,
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
                config,
                moonPhase,
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
    const scene = new AmbientScene();
    let lightningAlpha = 0; // for lightning flash
    let lightningStrike: LightningStrike | null = null;
    let boltAlpha = 0;
    let nextLightning = config.lightning ? 200 + Math.random() * 400 : Infinity;
    let frameCount = 0;
    let previousFrameTime = 0;
    let accumulatedFrameTime = 0;

    let canvasScale = 1;
    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const pixelBudgetScale = Math.sqrt(MAX_CANVAS_PIXELS / (rect.width * rect.height));
      canvasScale = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR, pixelBudgetScale);
      canvas.width = Math.max(1, Math.round(rect.width * canvasScale));
      canvas.height = Math.max(1, Math.round(rect.height * canvasScale));
      ctx.setTransform(canvasScale, 0, 0, canvasScale, 0, 0);
      scene.resize(rect.width, rect.height);
    };
    resize();
    window.addEventListener("resize", resize);

    // Initialize particles — use CSS pixel dimensions (not canvas resolution)
    particlesRef.current = [];
    const w = canvas.width / canvasScale;
    const h = canvas.height / canvasScale;

    for (let i = 0; i < config.count; i++) {
      particlesRef.current.push(createWeatherParticle(config.type, w, h));
    }
    if (config.addFireflies) {
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

      // Sky wash, star field, meteors, aurora
      scene.drawUnder(ctx, config, frameCount, frameScale);

      // ── Celestial bodies (sun / moon) — dimmed by weather, never hard-hidden ──
      if (shouldDrawCelestial) {
        const bodyRadius = Math.min(cw, ch) * 0.035; // ~3.5% of smallest dimension
        const hour = config.sceneHour >= 0 ? config.sceneHour : 12;

        if (config.celestial === "sun") {
          const sx = weatherCelestialX(hour, cw);
          const sy = weatherCelestialY(hour, ch, false);
          drawLuminousSun(ctx, sx, sy, bodyRadius, sunElevation(hour), frameCount, config.mood.bodyDim);
        } else if (config.celestial === "moon") {
          // Moon position: map 21h→left, 0h→center, 5h→right
          const moonNorm = hour >= 12 ? ((hour - 21 + 24) % 24) / 10 : (hour + 3) / 10;
          const mx = cw * 0.1 + Math.min(1, Math.max(0, moonNorm)) * cw * 0.8;
          const my = weatherCelestialY(hour, ch, true);
          drawLuminousMoon(ctx, mx, my, bodyRadius * 1.28, moonAltitude(hour), moonPhase, config.mood.bodyDim);
        }
      }

      // Cloud deck, weather veil, fog banks, horizon glow
      scene.drawOver(ctx, config, frameCount);

      const wind = ambientWindAt(frameCount) * config.mood.windStrength;
      const particles = particlesRef.current;

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += frameScale;

        // Update position
        p.x += p.vx * frameScale;
        p.y += p.vy * frameScale;

        // Wobble for organic movement
        if (p.type === "snow" || p.type === "leaf" || p.type === "petal" || p.type === "ash") {
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

        drawWeatherParticle(ctx, p);

        // Respawn if off-screen or expired
        const offScreen = p.y > ch + 20 || p.y < -20 || p.x > cw + 20 || p.x < -20;
        if (offScreen || p.life > p.maxLife) {
          particles[i] = createWeatherParticle(p.type, cw, ch, true);
        }
      }

      // Lightning flash (epilepsy-safe: capped alpha, gentle decay, long gap between flashes)
      if (config.lightning) {
        if (frameCount >= nextLightning) {
          lightningAlpha = 0.45 + Math.random() * 0.15; // soft flash, max 0.6
          nextLightning = frameCount + 400 + Math.random() * 800; // next in ~7-20s at 60fps
          lightningStrike = createLightningStrike(cw, ch);
          boltAlpha = 1;
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
      }

      frameRef.current = requestAnimationFrame(tick);
    };

    const ensureFallbackRunning = () => {
      if (!running || document.hidden || pausedRef.current || frameRef.current !== 0) return;
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
  }, [config, moonPhase, shouldDrawCelestial, shouldRender, showCelestial, workerFailed]);

  if (!shouldRender) return null;

  return (
    <canvas
      key={`${weather ?? ""}:${timeOfDay ?? ""}:${worldDate ?? ""}:${showCelestial ? "celestial" : "particles"}:${workerFailed ? "fallback" : "worker"}`}
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 z-0 h-full w-full transform-gpu [contain:strict] [will-change:transform]"
    />
  );
}
