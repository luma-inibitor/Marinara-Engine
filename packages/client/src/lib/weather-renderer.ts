// ── Particle types ──
export interface WeatherParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  opacity: number;
  type:
    | "rain"
    | "snow"
    | "leaf"
    | "firefly"
    | "star"
    | "fog"
    | "dust"
    | "petal"
    | "ember"
    | "ash"
    | "sand"
    | "hail"
    | "aurora";
  wobble: number;
  life: number;
  maxLife: number;
  /** Pre-computed fill colour (ash, sand) to avoid Math.random() in draw */
  color: string;
  /** Snow depth 0..1 — distance to camera; near flakes are bigger and faster. */
  depth?: number;
  /** Snow flutter: second oscillator phase, amplitude, and rate. */
  flutterPhase?: number;
  flutterAmp?: number;
  flutterRate?: number;
}

type WeatherCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface WeatherRenderConfig {
  type: WeatherParticle["type"];
  count: number;
  overlay: string;
  lightning: boolean;
  tint: string;
  addFireflies: boolean;
  addStars: boolean;
  celestial: CelestialBody;
  hour: number;
  sunRays: boolean;
  sunsetGlow: boolean;
  isClearSky: boolean;
  /** Weather-family mood driving the ambient scene layers. */
  mood: WeatherSceneMood;
  /** Effective hour for scene passes; -1 when the time string gave nothing. */
  sceneHour: number;
  /** True when any ambient scene pass has something to draw. */
  sceneActive: boolean;
}

// ── Map weather string → effect config ──
function parseWeather(weather?: string | null): {
  type: WeatherParticle["type"];
  count: number;
  overlay: string;
  lightning: boolean;
} {
  if (!weather) return { type: "dust", count: 0, overlay: "", lightning: false };

  const w = weather.toLowerCase();

  // Thunderstorm / lightning
  if (w.includes("thunder") || w.includes("lightning")) {
    return { type: "rain", count: 120, overlay: "rgba(50,80,120,0.10)", lightning: true };
  }
  if (w.includes("hail")) {
    return { type: "hail", count: 40, overlay: "rgba(180,200,230,0.06)", lightning: false };
  }
  if (w.includes("blizzard")) {
    return { type: "snow", count: 90, overlay: "rgba(200,220,255,0.10)", lightning: false };
  }
  if (w.includes("snow") || w.includes("sleet")) {
    const isHeavy = w.includes("heavy");
    return { type: "snow", count: isHeavy ? 75 : 35, overlay: "rgba(200,220,255,0.06)", lightning: false };
  }
  if (w.includes("frost") || w.includes("cold") || w.includes("freez")) {
    return { type: "snow", count: 12, overlay: "rgba(180,210,240,0.06)", lightning: false };
  }
  if (w.includes("fog") || w.includes("mist") || w.includes("haze")) {
    return { type: "fog", count: 12, overlay: "rgba(180,180,200,0.12)", lightning: false };
  }
  if (w.includes("sand") || w.includes("dust storm") || w.includes("sirocco")) {
    return { type: "sand", count: 65, overlay: "rgba(180,150,100,0.12)", lightning: false };
  }
  if (w.includes("ash") || w.includes("volcanic") || w.includes("smoke")) {
    return { type: "ash", count: 30, overlay: "rgba(80,60,60,0.10)", lightning: false };
  }
  if (w.includes("ember") || w.includes("fire") || w.includes("inferno")) {
    return { type: "ember", count: 24, overlay: "rgba(120,40,10,0.08)", lightning: false };
  }
  if (w.includes("wind") || w.includes("breez") || w.includes("gust")) {
    return { type: "leaf", count: 18, overlay: "", lightning: false };
  }
  if (w.includes("cherry") || w.includes("blossom") || w.includes("petal")) {
    return { type: "petal", count: 22, overlay: "rgba(255,180,200,0.04)", lightning: false };
  }
  if (w.includes("aurora") || w.includes("northern light") || w.includes("polar light")) {
    return { type: "aurora", count: 6, overlay: "rgba(20,60,40,0.08)", lightning: false };
  }
  if (w.includes("rain") || w.includes("storm") || w.includes("downpour")) {
    const isHeavy = w.includes("heavy") || w.includes("storm") || w.includes("downpour");
    return {
      type: "rain",
      count: isHeavy ? 120 : 55,
      overlay: "rgba(50,80,120,0.08)",
      lightning: isHeavy && w.includes("storm"),
    };
  }
  if (w.includes("clear") || w.includes("sunny") || w.includes("bright")) {
    return { type: "dust", count: 8, overlay: "", lightning: false };
  }
  if (w.includes("cloud") || w.includes("overcast") || w.includes("grey") || w.includes("gray")) {
    return { type: "dust", count: 6, overlay: "rgba(100,100,120,0.05)", lightning: false };
  }

  return { type: "dust", count: 8, overlay: "", lightning: false };
}

// ── Map time of day → tint + fireflies ──
type CelestialBody = "sun" | "moon" | "none";

function parseTime(
  timeOfDay?: string | null,
  baseType?: WeatherParticle["type"],
): {
  tint: string;
  addFireflies: boolean;
  addStars: boolean;
  celestial: CelestialBody;
  hour: number; // 0-24, -1 if unknown
  sunRays: boolean;
  sunsetGlow: boolean;
  isClearSky: boolean; // derived later; default false here
} {
  const base = {
    tint: "",
    addFireflies: false,
    addStars: false,
    celestial: "none" as CelestialBody,
    hour: -1,
    sunRays: false,
    sunsetGlow: false,
    isClearSky: false,
  };

  if (!timeOfDay) return base;

  const t = timeOfDay.toLowerCase();

  // Try to extract a numeric hour from the time string ("14:30", "2 PM", "1400", etc.)
  const hour = extractHour(t);
  base.hour = hour;

  if (t.includes("night") || t.includes("midnight")) {
    return {
      ...base,
      tint: "rgba(10,10,40,0.15)",
      addFireflies: baseType !== "rain" && baseType !== "snow",
      addStars: baseType !== "fog" && baseType !== "snow",
      celestial: "moon",
      hour: hour >= 0 ? hour : 0,
    };
  }
  if (t.includes("dusk") || t.includes("sunset") || t.includes("twilight") || t.includes("evening")) {
    return {
      ...base,
      tint: "rgba(80,30,20,0.10)",
      addFireflies: baseType !== "rain",
      addStars: false,
      celestial: "sun",
      hour: hour >= 0 ? hour : 18,
      sunsetGlow: true,
    };
  }
  if (t.includes("dawn") || t.includes("sunrise") || t.includes("morning")) {
    return {
      ...base,
      tint: "rgba(120,80,40,0.06)",
      celestial: "sun",
      hour: hour >= 0 ? hour : 7,
      sunRays: true,
    };
  }

  // Numeric hour fallback — determine time period from hour
  if (hour >= 0) {
    if (hour >= 21 || hour < 5) {
      return {
        ...base,
        tint: "rgba(10,10,40,0.15)",
        addFireflies: baseType !== "rain" && baseType !== "snow",
        addStars: baseType !== "fog" && baseType !== "snow",
        celestial: "moon",
      };
    }
    if (hour >= 17 && hour < 21) {
      return {
        ...base,
        tint: "rgba(80,30,20,0.10)",
        addFireflies: baseType !== "rain",
        celestial: "sun",
        sunsetGlow: hour >= 17,
      };
    }
    if (hour >= 5 && hour < 9) {
      return {
        ...base,
        tint: "rgba(120,80,40,0.06)",
        celestial: "sun",
        sunRays: true,
      };
    }
    // Daytime (9-17)
    return {
      ...base,
      celestial: "sun",
      sunRays: true,
    };
  }

  // If it just says "afternoon", "day", "noon", etc.
  if (t.includes("noon") || t.includes("midday") || t.includes("afternoon") || t.includes("day")) {
    return {
      ...base,
      celestial: "sun",
      hour: t.includes("afternoon") ? 15 : 12,
      sunRays: true,
    };
  }

  return base;
}

/** Try to extract an hour (0-23) from a time string. Returns -1 if not found. */
function extractHour(t: string): number {
  // "14:30", "2:00 PM", "14h30", "1400"
  const match24 = t.match(/\b(\d{1,2})[:.h](\d{2})\b/);
  if (match24) {
    let h = parseInt(match24[1]!, 10);
    if (t.includes("pm") && h < 12) h += 12;
    if (t.includes("am") && h === 12) h = 0;
    if (h >= 0 && h < 24) return h;
  }
  // "2 PM", "11 AM"
  const matchAmPm = t.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (matchAmPm) {
    let h = parseInt(matchAmPm[1]!, 10);
    if (matchAmPm[2] === "pm" && h < 12) h += 12;
    if (matchAmPm[2] === "am" && h === 12) h = 0;
    if (h >= 0 && h < 24) return h;
  }
  // Military "1400", "0800"
  const matchMil = t.match(/\b(\d{4})\s*(?:hours?|hrs?)?\b/);
  if (matchMil) {
    const h = parseInt(matchMil[1]!.slice(0, 2), 10);
    if (h >= 0 && h < 24) return h;
  }
  return -1;
}

export function resolveWeatherRenderConfig(weather?: string | null, timeOfDay?: string | null): WeatherRenderConfig {
  const weatherConfig = parseWeather(weather);
  const timeConfig = parseTime(timeOfDay, weatherConfig.type);
  const isClearSky =
    !weather ||
    /clear|sunny|bright/i.test(weather) ||
    !/(rain|storm|snow|blizzard|fog|mist|haze|hail|sand|ash|smoke|overcast|cloud|grey|gray)/i.test(weather);
  const mood = deriveWeatherMood(weather, weatherConfig.type, weatherConfig.lightning);
  const sceneHour =
    timeConfig.hour >= 0
      ? timeConfig.hour
      : timeConfig.celestial === "moon"
        ? 0
        : timeConfig.celestial === "sun"
          ? 12
          : -1;
  const sceneActive = sceneHour >= 0 || mood.cloudiness > 0.12 || mood.veil !== null;
  return { ...weatherConfig, ...timeConfig, isClearSky, mood, sceneHour, sceneActive };
}

// ── Create particle ──
export function createWeatherParticle(
  type: WeatherParticle["type"],
  w: number,
  h: number,
  fromTop = false,
): WeatherParticle {
  const base: WeatherParticle = {
    x: Math.random() * w,
    y: fromTop ? -10 : Math.random() * h,
    vx: 0,
    vy: 0,
    size: 2,
    opacity: 0.5,
    type,
    wobble: Math.random() * Math.PI * 2,
    life: 0,
    maxLife: 600 + Math.random() * 400,
    color: "",
  };

  switch (type) {
    case "rain":
      base.vy = 8 + Math.random() * 6;
      base.vx = -1 + Math.random() * -2;
      base.size = 1.5;
      base.opacity = 0.3 + Math.random() * 0.2;
      base.maxLife = 200;
      break;
    case "snow": {
      // Depth-layered: z is distance-to-camera, biased toward far. Near
      // flakes are bigger, faster, and softer; far flakes small and dense.
      const z = Math.pow(Math.random(), 1.6) * 0.85 + 0.15;
      base.depth = z;
      base.vy = (0.55 + z * 1.55) * (0.85 + Math.random() * 0.3);
      base.vx = 0;
      base.size = (0.9 + z * z * 3) * 1.1;
      base.opacity = (0.55 + Math.random() * 0.45) * (0.38 + 0.55 * z);
      base.flutterPhase = Math.random() * Math.PI * 2;
      base.flutterAmp = (0.5 + z * 1.2) * (0.6 + Math.random() * 0.8) * 0.5;
      base.flutterRate = 0.55 + Math.random() * 1.1;
      base.maxLife = 800;
      break;
    }
    case "leaf":
      base.vy = 0.8 + Math.random() * 1;
      base.vx = 1.5 + Math.random() * 2;
      base.size = 4 + Math.random() * 3;
      base.opacity = 0.5 + Math.random() * 0.3;
      base.maxLife = 500;
      break;
    case "petal":
      base.vy = 0.4 + Math.random() * 0.8;
      base.vx = 0.5 + Math.random() * 1;
      base.size = 3 + Math.random() * 3;
      base.opacity = 0.4 + Math.random() * 0.3;
      base.maxLife = 600;
      break;
    case "firefly":
      base.vy = -0.2 + Math.random() * 0.4;
      base.vx = -0.3 + Math.random() * 0.6;
      base.size = 2 + Math.random() * 2;
      base.opacity = 0;
      base.maxLife = 300 + Math.random() * 300;
      break;
    case "star":
      base.vy = 0;
      base.vx = 0;
      base.size = 1 + Math.random() * 1.5;
      base.opacity = 0;
      base.maxLife = 400 + Math.random() * 400;
      base.y = Math.random() * h * 0.4; // upper portion
      break;
    case "fog":
      base.vy = 0;
      base.vx = 0.2 + Math.random() * 0.4;
      base.size = 60 + Math.random() * 80;
      base.opacity = 0.03 + Math.random() * 0.04;
      base.maxLife = 1000;
      break;
    case "dust":
      base.vy = -0.1 + Math.random() * 0.2;
      base.vx = -0.1 + Math.random() * 0.2;
      base.size = 1 + Math.random() * 2;
      base.opacity = 0.15 + Math.random() * 0.15;
      base.maxLife = 600 + Math.random() * 400;
      break;
    case "ember":
      base.vy = -1.5 + Math.random() * -1.5;
      base.vx = -0.5 + Math.random() * 1;
      base.size = 2 + Math.random() * 2;
      base.opacity = 0.6 + Math.random() * 0.3;
      base.maxLife = 300 + Math.random() * 200;
      base.y = h + 10; // rise from bottom
      break;
    case "ash":
      base.vy = 0.3 + Math.random() * 0.6;
      base.vx = -0.4 + Math.random() * 0.8;
      base.size = 2 + Math.random() * 3;
      base.opacity = 0.2 + Math.random() * 0.2;
      base.maxLife = 700 + Math.random() * 300;
      base.color = `rgba(${(100 + Math.random() * 40) | 0},${(90 + Math.random() * 30) | 0},${(90 + Math.random() * 30) | 0},0.6)`;
      break;
    case "sand":
      base.vy = 0.5 + Math.random() * 1;
      base.vx = 4 + Math.random() * 4;
      base.size = 1 + Math.random() * 2;
      base.opacity = 0.3 + Math.random() * 0.3;
      base.maxLife = 250 + Math.random() * 150;
      base.x = -10; // enter from left
      base.color = `rgba(${(200 + Math.random() * 30) | 0},${(170 + Math.random() * 30) | 0},${(110 + Math.random() * 20) | 0},0.7)`;
      break;
    case "hail":
      base.vy = 10 + Math.random() * 6;
      base.vx = -1 + Math.random() * -1;
      base.size = 2 + Math.random() * 3;
      base.opacity = 0.4 + Math.random() * 0.3;
      base.maxLife = 150;
      break;
    case "aurora":
      base.vy = 0;
      base.vx = 0.1 + Math.random() * 0.2;
      base.size = 80 + Math.random() * 120;
      base.opacity = 0.04 + Math.random() * 0.03;
      base.maxLife = 1200 + Math.random() * 600;
      base.y = Math.random() * h * 0.35; // upper sky
      break;
  }

  return base;
}

// ── Draw helpers ──
export function drawWeatherParticle(ctx: WeatherCanvasContext, p: WeatherParticle) {
  const fadeIn = Math.min(p.life / 60, 1);
  const fadeOut = Math.max(1 - p.life / p.maxLife, 0);
  const alpha = p.opacity * fadeIn * fadeOut;
  if (alpha <= 0) return;

  ctx.globalAlpha = alpha;

  switch (p.type) {
    case "rain": {
      ctx.strokeStyle = "rgba(206,222,244,0.85)";
      ctx.lineWidth = p.size;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + p.vx * 2, p.y + p.vy * 2);
      ctx.stroke();
      break;
    }
    case "snow": {
      // Faint dark rim defines flakes over light backgrounds and vanishes
      // over dark ones; the two-step fill fakes a soft sprite edge.
      ctx.strokeStyle = "rgba(74,84,100,0.3)";
      ctx.lineWidth = p.size * 0.35;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 0.95, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 0.66, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "leaf": {
      ctx.fillStyle = `hsl(${100 + Math.sin(p.wobble) * 30}, 60%, 45%)`;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.wobble);
      ctx.beginPath();
      ctx.ellipse(0, 0, p.size, p.size * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
    case "petal": {
      ctx.fillStyle = `hsl(${340 + Math.sin(p.wobble) * 15}, 80%, 80%)`;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.wobble);
      ctx.beginPath();
      ctx.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
    case "firefly": {
      const pulse = Math.sin(p.life * 0.05) * 0.5 + 0.5;
      ctx.globalAlpha = alpha * 0.28 * pulse;
      ctx.fillStyle = "rgba(180,255,80,0.7)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha * (0.65 + pulse * 0.35);
      ctx.fillStyle = "rgba(220,255,130,0.95)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "star": {
      const twinkle = Math.sin(p.life * 0.04 + p.wobble) * 0.5 + 0.5;
      ctx.fillStyle = `rgba(255,255,240,${twinkle * 0.7})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      // cross sparkle
      ctx.strokeStyle = `rgba(255,255,240,${twinkle * 0.3})`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(p.x - p.size * 2, p.y);
      ctx.lineTo(p.x + p.size * 2, p.y);
      ctx.moveTo(p.x, p.y - p.size * 2);
      ctx.lineTo(p.x, p.y + p.size * 2);
      ctx.stroke();
      break;
    }
    case "fog": {
      ctx.globalAlpha = alpha * 0.7;
      ctx.fillStyle = "rgba(200,200,220,0.08)";
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.size * 1.5, p.size * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "dust": {
      ctx.fillStyle = "rgba(255,240,220,0.6)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "ember": {
      const emberPulse = Math.sin(p.life * 0.08) * 0.3 + 0.7;
      ctx.globalAlpha = alpha * 0.32 * emberPulse;
      ctx.fillStyle = "rgba(255,80,20,0.7)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha * emberPulse;
      ctx.fillStyle = "rgba(255,205,70,0.92)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "ash": {
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.wobble);
      ctx.beginPath();
      ctx.ellipse(0, 0, p.size, p.size * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
    case "sand": {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "hail": {
      ctx.fillStyle = "rgba(230,240,255,0.85)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "aurora": {
      // Tall vertical ribbon of colour that sways gently
      const hue = (p.wobble * 60 + p.life * 0.3) % 360;
      const auroraGrad = ctx.createLinearGradient(p.x, p.y - p.size, p.x, p.y + p.size);
      auroraGrad.addColorStop(0, `hsla(${hue},80%,60%,0)`);
      auroraGrad.addColorStop(0.3, `hsla(${hue},80%,60%,0.08)`);
      auroraGrad.addColorStop(0.5, `hsla(${(hue + 40) % 360},70%,55%,0.12)`);
      auroraGrad.addColorStop(0.7, `hsla(${(hue + 80) % 360},80%,60%,0.08)`);
      auroraGrad.addColorStop(1, `hsla(${(hue + 80) % 360},80%,60%,0)`);
      ctx.fillStyle = auroraGrad;
      ctx.beginPath();
      const ribbonW = p.size * 0.6;
      const sway = Math.sin(p.life * 0.008 + p.wobble) * 30;
      ctx.moveTo(p.x + sway - ribbonW, p.y - p.size);
      ctx.quadraticCurveTo(p.x + sway * 0.5, p.y, p.x + sway + ribbonW, p.y + p.size);
      ctx.lineTo(p.x + sway - ribbonW, p.y + p.size);
      ctx.quadraticCurveTo(p.x + sway * 0.5, p.y, p.x + sway + ribbonW, p.y - p.size);
      ctx.closePath();
      ctx.fill();
      break;
    }
  }

  ctx.globalAlpha = 1;
}

// ── Celestial arc helpers ──

/** Get sun/moon X position based on hour. Maps 6:00→left edge, 12:00→center, 18:00→right edge. */
export function weatherCelestialX(hour: number, w: number): number {
  // Sun arc: 6h = 0%, 12h = 50%, 18h = 100% of width
  const t = Math.max(0, Math.min(1, (hour - 6) / 12));
  return w * 0.08 + t * w * 0.84; // 8%-92% of width
}

/** Get sun Y position — arc from bottom-ish up to top and back down. */
export function weatherCelestialY(hour: number, h: number, isMoon: boolean): number {
  if (isMoon) {
    // Moon arc: highest at midnight (hour 0/24), lower at 21h and 5h
    const t = hour >= 12 ? (hour - 21) / 7 : (hour + 3) / 7;
    const arc = Math.sin(Math.max(0, Math.min(1, t)) * Math.PI);
    return h * 0.05 + (1 - arc) * h * 0.2;
  }
  // Sun: lowest at 6h/18h, highest at noon
  const t = Math.max(0, Math.min(1, (hour - 6) / 12));
  const arc = Math.sin(t * Math.PI); // 0 at edges, 1 at noon
  return h * 0.05 + (1 - arc) * h * 0.25; // 5%-30% from top
}

// ── Ambient scene ──
// Keyframed sky wash, weather moods, seeded night scenery, and the luminous
// celestial bodies. Shared by the main-thread fallback in WeatherEffects.tsx
// and weather-effects.worker.ts, so nothing below may assume a window exists:
// scratch canvases come from createScratchCanvas().

type RGB = [number, number, number];

const TAU = Math.PI * 2;
const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);
const lerpValue = (from: number, to: number, t: number) => from + (to - from) * t;
const lerpRGB = (from: RGB, to: RGB, t: number): RGB => [
  lerpValue(from[0], to[0], t),
  lerpValue(from[1], to[1], t),
  lerpValue(from[2], to[2], t),
];
const rgb = (color: RGB, alpha: number) => `rgba(${color[0] | 0},${color[1] | 0},${color[2] | 0},${alpha})`;
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Deterministic PRNG so seeded scenery is identical across resizes and render paths. */
function mulberry32(seed: number) {
  return function next() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type ScratchCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Canvas filters are a runtime capability, not a type-level one. */
function supportsCanvasFilter(ctx: WeatherCanvasContext): boolean {
  return typeof (ctx as CanvasRenderingContext2D).filter === "string";
}

function createScratchCanvas(width: number, height: number): ScratchCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function scratchContext(canvas: ScratchCanvas): WeatherCanvasContext | null {
  return canvas.getContext("2d") as WeatherCanvasContext | null;
}

// ── Sky palette: hour keyframes for top / mid / horizon plus the ambient light
//    color that tints clouds, fog, and particles. Alpha is applied at draw time
//    so the wash stays a tint over the user's background, never a paint-over. ──
const SKY_KEYFRAMES: ReadonlyArray<readonly [number, RGB, RGB, RGB, RGB]> = [
  [0.0, [2, 8, 30], [5, 19, 60], [9, 32, 84], [112, 148, 224]],
  [4.6, [3, 11, 40], [8, 24, 74], [16, 40, 98], [118, 152, 226]],
  [5.6, [12, 26, 76], [34, 48, 114], [124, 74, 95], [217, 160, 143]],
  [6.4, [38, 64, 110], [111, 99, 146], [255, 157, 111], [255, 192, 154]],
  [7.5, [58, 106, 168], [127, 165, 207], [255, 217, 168], [255, 228, 189]],
  [9.5, [59, 121, 194], [141, 184, 224], [216, 236, 244], [255, 243, 221]],
  [12.5, [47, 108, 191], [127, 176, 221], [201, 228, 239], [255, 248, 234]],
  [15.5, [54, 111, 184], [133, 174, 214], [214, 230, 232], [255, 240, 210]],
  [17.3, [64, 99, 159], [143, 135, 174], [255, 192, 122], [255, 217, 160]],
  [18.3, [59, 63, 119], [129, 93, 132], [255, 143, 94], [255, 178, 126]],
  [19.2, [22, 30, 94], [54, 56, 128], [184, 100, 110], [214, 152, 148]],
  [20.2, [6, 16, 54], [15, 34, 94], [32, 56, 128], [138, 160, 232]],
  [24.0, [2, 8, 30], [5, 19, 60], [9, 32, 84], [112, 148, 224]],
];

export interface SkyPalette {
  top: RGB;
  mid: RGB;
  horizon: RGB;
  light: RGB;
}

export function sampleSkyPalette(hour: number): SkyPalette {
  const t = ((hour % 24) + 24) % 24;
  let index = 0;
  while (SKY_KEYFRAMES[index + 1]![0] < t) index += 1;
  const from = SKY_KEYFRAMES[index]!;
  const to = SKY_KEYFRAMES[index + 1]!;
  const f = smoothstep((t - from[0]) / (to[0] - from[0]));
  return {
    top: lerpRGB(from[1], to[1], f),
    mid: lerpRGB(from[2], to[2], f),
    horizon: lerpRGB(from[3], to[3], f),
    light: lerpRGB(from[4], to[4], f),
  };
}

/** Signed sun elevation, −1..1: negative at night, 1 at noon. */
export function sunElevation(hour: number): number {
  return Math.sin(((hour - 6) / 12) * Math.PI);
}

/** Moon altitude 0..1 along its 21h→5h arc, peaking at midnight. */
export function moonAltitude(hour: number): number {
  const t = hour >= 12 ? (hour - 21) / 7 : (hour + 3) / 7;
  return Math.sin(clamp01(t) * Math.PI);
}

// ── Weather mood: how a weather family dims bodies, occludes stars, drives the
//    cloud deck and wind, and which translucent veil sets the tone. ──
export interface WeatherSceneMood {
  cloudiness: number;
  /** How stormy-dark the cloud deck renders, 0..1. */
  shade: number;
  windStrength: number;
  starIntensity: number;
  /** Full-frame translucent wash, or null for none. Alpha stays ≤ 0.3. */
  veil: [number, number, number, number] | null;
  /** Overcast diffusion 0..1: desaturates and softens the celestial bodies. */
  murk: number;
  fogBanks: boolean;
  /** Celestial body strength: 1 in the clear, dimmed toward 0 under weather. */
  bodyDim: number;
}

const CLEAR_MOOD: WeatherSceneMood = {
  cloudiness: 0.1,
  shade: 0.05,
  windStrength: 0.16,
  starIntensity: 1,
  veil: null,
  murk: 0,
  fogBanks: false,
  bodyDim: 1,
};

function deriveWeatherMood(
  weather: string | null | undefined,
  type: WeatherParticle["type"],
  lightning: boolean,
): WeatherSceneMood {
  if (!weather) return CLEAR_MOOD;
  if (lightning) {
    return {
      cloudiness: 1,
      shade: 0.58,
      windStrength: 1,
      starIntensity: 0.05,
      veil: [34, 40, 52, 0.3],
      murk: 0.85,
      fogBanks: false,
      bodyDim: 0.42,
    };
  }
  switch (type) {
    case "rain":
      return {
        cloudiness: 0.9,
        shade: 0.42,
        windStrength: 0.55,
        starIntensity: 0.1,
        veil: [66, 76, 90, 0.2],
        murk: 0.68,
        fogBanks: false,
        bodyDim: 0.52,
      };
    case "hail":
    case "snow":
      return {
        cloudiness: 0.72,
        shade: 0.16,
        windStrength: 0.34,
        starIntensity: 0.15,
        veil: [210, 218, 228, 0.12],
        murk: 0.55,
        fogBanks: false,
        bodyDim: 0.6,
      };
    case "fog":
      return {
        cloudiness: 0.3,
        shade: 0.18,
        windStrength: 0.1,
        starIntensity: 0.12,
        veil: [224, 228, 236, 0.22],
        murk: 0.75,
        fogBanks: true,
        bodyDim: 0.52,
      };
    case "sand":
      return {
        cloudiness: 0.55,
        shade: 0.34,
        windStrength: 0.9,
        starIntensity: 0.05,
        veil: [180, 150, 100, 0.16],
        murk: 0.8,
        fogBanks: false,
        bodyDim: 0.5,
      };
    case "ash":
      return {
        cloudiness: 0.5,
        shade: 0.4,
        windStrength: 0.3,
        starIntensity: 0.1,
        veil: [80, 66, 66, 0.16],
        murk: 0.7,
        fogBanks: false,
        bodyDim: 0.5,
      };
    case "ember":
      return {
        ...CLEAR_MOOD,
        windStrength: 0.3,
        starIntensity: 0.6,
        veil: [120, 40, 10, 0.06],
        murk: 0.15,
        bodyDim: 0.8,
      };
    case "leaf":
      return { ...CLEAR_MOOD, windStrength: 0.85 };
    case "petal":
      return { ...CLEAR_MOOD, windStrength: 0.4 };
    default:
      break;
  }
  const normalized = weather.toLowerCase();
  if (normalized.includes("overcast")) {
    return {
      cloudiness: 1,
      shade: 0.14,
      windStrength: 0.3,
      starIntensity: 0.2,
      veil: [118, 126, 140, 0.14],
      murk: 0.5,
      fogBanks: false,
      bodyDim: 0.7,
    };
  }
  if (/(cloud|grey|gray)/.test(normalized)) {
    return {
      cloudiness: 0.8,
      shade: 0.14,
      windStrength: 0.3,
      starIntensity: 0.3,
      veil: [118, 126, 140, 0.1],
      murk: 0.4,
      fogBanks: false,
      bodyDim: 0.7,
    };
  }
  return CLEAR_MOOD;
}

// ── Moon phase from the tracker's free-text date ──
const SYNODIC_MONTH = 29.530588;
const DEFAULT_MOON_PHASE = 0.22;
const MONTH_STEMS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function wrapPhase(days: number): number {
  return (((days % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH) / SYNODIC_MONTH;
}

/**
 * Derive a lunar phase (0 new → 0.5 full → 1 new) from the world tracker's
 * free-text date. Campaign day counters and calendar dates progress the moon
 * night over night; anything unparseable gets a stable per-string phase so the
 * moon never jumps while the date text is unchanged.
 */
export function deriveMoonPhase(dateText?: string | null): number {
  const text = dateText?.trim().toLowerCase() ?? "";
  if (!text) return DEFAULT_MOON_PHASE;
  const dayCounter = text.match(/\bday\s+(\d{1,6})\b/);
  if (dayCounter) return wrapPhase(parseInt(dayCounter[1]!, 10) - 1);
  const iso = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    return wrapPhase(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) / 86_400_000);
  }
  const dayOfMonth = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (dayOfMonth) {
    const monthIndex = MONTH_STEMS.findIndex((stem) => text.includes(stem));
    return wrapPhase((monthIndex >= 0 ? monthIndex * 30.44 : 0) + parseInt(dayOfMonth[1]!, 10));
  }
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return (((hash % 1000) + 1000) % 1000) / 1000;
}

// ── Wind: one shared low-frequency field so drifting particles surge and lull
//    together instead of falling at a constant rate. ──
export function ambientWindAt(frame: number): number {
  return 0.58 * Math.sin(frame * 0.0031) + 0.29 * Math.sin(frame * 0.0087 + 1.7) + 0.14 * Math.sin(frame * 0.019 + 4.1);
}

/**
 * Snow motion: a slow gust field sampled by position plus two incommensurate
 * per-flake flutter oscillators, all scaled by depth. Replaces the generic
 * wobble/wind handling for snow in both render loops.
 */
export function advanceSnowParticle(particle: WeatherParticle, frame: number, frameScale: number, wind: number) {
  const depth = particle.depth ?? 0.6;
  const rate = particle.flutterRate ?? 1;
  const amp = particle.flutterAmp ?? 0.8;
  const phase2 = particle.flutterPhase ?? 0;
  const gust =
    wind *
    (0.7 + 0.6 * Math.sin(frame * 0.011 + particle.y * 0.0035) + 0.3 * Math.sin(frame * 0.023 + particle.x * 0.002));
  const flutter =
    Math.sin(particle.wobble + frame * 0.055 * rate) * amp + Math.sin(phase2 + frame * 0.021 * rate) * amp * 0.5;
  particle.x += (flutter * depth + gust * 2.4 * depth) * frameScale;
  particle.y += particle.vy * 0.12 * Math.sin(phase2 + frame * 0.03) * frameScale;
}

/**
 * Start a graceful particle turnover after a weather change: particles whose
 * type no longer matches get a bounded remaining life so they fade out and
 * are not respawned, instead of being wiped in one frame.
 */
export function fadeWeatherParticlesForConfig(particles: WeatherParticle[], config: WeatherRenderConfig) {
  for (const particle of particles) {
    if (particle.type === "firefly") {
      if (!config.addFireflies) particle.maxLife = Math.min(particle.maxLife, particle.life + 120);
      continue;
    }
    if (particle.type !== config.type) {
      particle.maxLife = Math.min(particle.maxLife, particle.life + 240);
    }
  }
}

export const WIND_RESPONSE: Partial<Record<WeatherParticle["type"], number>> = {
  snow: 2.2,
  leaf: 2.6,
  petal: 2.4,
  ash: 1.8,
  ember: 1.4,
  sand: 1.2,
  dust: 1,
  fog: 0.7,
  rain: 0.5,
  hail: 0.3,
};

// ── Luminous celestial bodies ──
// Opaque core wearing an alpha-composited glow: additive light vanishes over a
// light chat background, an alpha veil tints it, and the solid core means the
// body never dissolves regardless of what the user put behind the chat.

/** A soft anisotropic glow: a radial gradient stretched along one axis. */
function softLozenge(
  ctx: WeatherCanvasContext,
  x: number,
  y: number,
  length: number,
  width: number,
  color: RGB,
  alpha: number,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(length, width);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, rgb(color, alpha));
  gradient.addColorStop(0.35, rgb(color, alpha * 0.4));
  gradient.addColorStop(0.7, rgb(color, alpha * 0.1));
  gradient.addColorStop(1, rgb(color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Desaturate toward a slightly lifted neutral by `amount` — overcast diffusion. */
function desaturate(color: RGB, amount: number): RGB {
  if (amount <= 0) return color;
  const luma = color[0] * 0.32 + color[1] * 0.52 + color[2] * 0.16;
  const neutral: RGB = [Math.min(255, luma + 14), Math.min(255, luma + 14), Math.min(255, luma + 14)];
  return lerpRGB(color, neutral, amount);
}

export function drawLuminousSun(
  ctx: WeatherCanvasContext,
  x: number,
  y: number,
  radius: number,
  elevation: number,
  frame: number,
  dim: number,
  murk = 0,
  rayDamp = 0,
) {
  if (dim <= 0.02) return;
  const t = clamp01(1 - Math.max(0, elevation) * 2.2);
  // murk turns the colored lamp into a pale patch behind the weather.
  const core = desaturate(lerpRGB([255, 252, 242], [255, 216, 150], Math.min(1, t * 1.15)), murk);
  const mid = desaturate(lerpRGB([255, 236, 186], [255, 146, 70], t), murk);
  const edge = desaturate(lerpRGB([255, 200, 116], [240, 92, 40], t), murk);
  const breathe = 0.93 + Math.sin(frame * 0.005) * 0.07;
  const k = dim * breathe;
  ctx.save();

  const veilAlpha = 0.26 * k * (1 - murk * 0.85);
  if (veilAlpha > 0.004) {
    const veil = ctx.createRadialGradient(x, y, radius * 0.6, x, y, radius * 8);
    veil.addColorStop(0, rgb(edge, veilAlpha));
    veil.addColorStop(0.12, rgb(edge, veilAlpha * 0.54));
    veil.addColorStop(0.35, rgb(edge, veilAlpha * 0.19));
    veil.addColorStop(0.7, rgb(edge, veilAlpha * 0.054));
    veil.addColorStop(1, rgb(edge, 0));
    ctx.fillStyle = veil;
    ctx.beginPath();
    ctx.arc(x, y, radius * 8, 0, TAU);
    ctx.fill();
  }

  const bloomAlpha = k * (1 - murk * 0.35);
  const bloomRadius = radius * (2.7 + murk * 0.9);
  const bloom = ctx.createRadialGradient(x, y, 0, x, y, bloomRadius);
  bloom.addColorStop(0, rgb(core, 0.8 * bloomAlpha));
  bloom.addColorStop(0.36, rgb(mid, 0.3 * bloomAlpha));
  bloom.addColorStop(0.7, rgb(mid, 0.085 * bloomAlpha));
  bloom.addColorStop(1, rgb(mid, 0));
  ctx.fillStyle = bloom;
  ctx.beginPath();
  ctx.arc(x, y, bloomRadius, 0, TAU);
  ctx.fill();

  // The anamorphic streak yields to god rays and disappears into murk.
  const streakGate = Math.max(0, 1 - murk * 1.8) * Math.max(0, 1 - rayDamp * 1.35);
  if (streakGate > 0.02) {
    softLozenge(ctx, x, y, radius * 7.2, radius * 0.4, core, 0.16 * k * streakGate);
    softLozenge(ctx, x, y, radius * 0.38, radius * 4.2, core, 0.085 * k * streakGate);
  }

  // Refraction flattening only in the last 12% of altitude — a round sun
  // everywhere the eye would call an oval a bug.
  const flattening = clamp01((0.12 - elevation) / 0.12);
  const discAlpha = dim * (1 - murk * 0.25);
  const edgeSoft = lerpValue(0.88, 0.62, murk);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, 1 - 0.08 * flattening * flattening);
  ctx.translate(-x, -y);
  const disc = ctx.createRadialGradient(x, y, 0, x, y, radius);
  disc.addColorStop(0, rgb(core, discAlpha));
  disc.addColorStop(0.6, rgb(core, discAlpha));
  disc.addColorStop(edgeSoft, rgb(mid, 0.98 * discAlpha));
  disc.addColorStop(lerpValue(0.965, 0.86, murk), rgb(edge, 0.9 * discAlpha * (1 - murk * 0.4)));
  disc.addColorStop(1, rgb(edge, 0));
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();
  ctx.restore();

  const fringeAlpha = 0.26 * k * (1 - murk);
  if (fringeAlpha > 0.004) {
    const fringe = ctx.createRadialGradient(x, y, radius * 0.97, x, y, radius * 1.24);
    fringe.addColorStop(0, rgb(edge, fringeAlpha));
    fringe.addColorStop(1, rgb(edge, 0));
    ctx.fillStyle = fringe;
    ctx.beginPath();
    ctx.arc(x, y, radius * 1.24, 0, TAU);
    ctx.fill();
  }

  ctx.restore();
}

/** Lunar maria as soft merging patches, in units of the moon radius. */
const LUNAR_MARIA: ReadonlyArray<{ x: number; y: number; r: number; squash: number; alpha: number }> = [
  { x: -0.28, y: -0.36, r: 0.42, squash: 0.72, alpha: 0.22 },
  { x: 0.08, y: -0.46, r: 0.3, squash: 0.88, alpha: 0.15 },
  { x: -0.47, y: 0.04, r: 0.36, squash: 1.3, alpha: 0.19 },
  { x: -0.05, y: 0.02, r: 0.48, squash: 0.86, alpha: 0.16 },
  { x: 0.32, y: 0.33, r: 0.26, squash: 1.05, alpha: 0.11 },
  { x: -0.14, y: 0.5, r: 0.28, squash: 0.78, alpha: 0.09 },
];

export function drawLuminousMoon(
  ctx: WeatherCanvasContext,
  x: number,
  y: number,
  radius: number,
  altitude: number,
  phase: number,
  dim: number,
  murk = 0,
) {
  if (dim <= 0.02) return;
  const t = clamp01(1 - altitude * 1.8);
  const lit = desaturate(lerpRGB([238, 244, 255], [251, 219, 170], t), murk);
  const litLow = desaturate(lerpRGB([194, 208, 240], [230, 164, 108], t), murk);
  const halo = desaturate(lerpRGB([172, 198, 252], [246, 186, 124], t), murk);
  const sheer = 1 - murk * 0.3;

  const angle = phase * TAU;
  const illum = (1 - Math.cos(angle)) / 2;
  const terminatorX = radius * Math.cos(angle);
  const waxing = phase < 0.5;
  const side = waxing ? 1 : -1;

  let litPath: Path2D | null = null;
  if (illum > 0.015) {
    litPath = new Path2D();
    if (waxing) {
      litPath.arc(x, y, radius, -Math.PI / 2, Math.PI / 2, false);
      litPath.ellipse(x, y, Math.abs(terminatorX), radius, 0, Math.PI / 2, -Math.PI / 2, terminatorX > 0);
    } else {
      litPath.arc(x, y, radius, Math.PI / 2, -Math.PI / 2, false);
      litPath.ellipse(x, y, Math.abs(terminatorX), radius, 0, -Math.PI / 2, Math.PI / 2, terminatorX > 0);
    }
    litPath.closePath();
  }

  ctx.save();

  // Body first — the halo is atmosphere in front of the moon, so it goes on
  // top afterwards. Glow-behind lets the dark limb occlude its own halo and
  // reads as a grey balloon.
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.clip();
  const earthshine = ctx.createRadialGradient(x - radius * 0.25, y - radius * 0.25, 0, x, y, radius);
  earthshine.addColorStop(0, rgb(lerpRGB([58, 68, 98], [82, 68, 80], t), 0.14 * dim * sheer));
  earthshine.addColorStop(1, rgb([34, 40, 62], 0.09 * dim * sheer));
  ctx.fillStyle = earthshine;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  if (litPath) {
    // Near full there is no terminator on the visible face — lift the floor so
    // the far limb doesn't fall back to earthshine as a phantom dark crescent.
    const floorAlpha = 0.06 + 0.92 * clamp01((illum - 0.55) / 0.4);
    const terminator = ctx.createLinearGradient(x + side * terminatorX, y, x + side * radius, y);
    terminator.addColorStop(0, rgb(litLow, floorAlpha * dim * sheer));
    terminator.addColorStop(0.09, rgb(litLow, Math.max(0.5, floorAlpha) * dim * sheer));
    terminator.addColorStop(0.3, rgb(lit, 0.94 * dim * sheer));
    terminator.addColorStop(1, rgb(lit, dim * sheer));
    ctx.fillStyle = terminator;
    ctx.fill(litPath);
    ctx.save();
    ctx.clip(litPath);
    // Surface detail dissolves first as the weather thickens.
    const mariaGate = Math.max(0, 1 - murk * 2);
    for (const sea of LUNAR_MARIA) {
      ctx.save();
      ctx.translate(x + sea.x * radius, y + sea.y * radius);
      ctx.scale(1, sea.squash);
      const patch = ctx.createRadialGradient(0, 0, 0, 0, 0, sea.r * radius);
      patch.addColorStop(0, `rgba(48,56,80,${sea.alpha * 0.85 * dim * mariaGate})`);
      patch.addColorStop(0.55, `rgba(48,56,80,${sea.alpha * 0.53 * dim * mariaGate})`);
      patch.addColorStop(1, "rgba(48,56,80,0)");
      ctx.fillStyle = patch;
      ctx.beginPath();
      ctx.arc(0, 0, sea.r * radius, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }
  const limb = ctx.createRadialGradient(x, y, radius * 0.62, x, y, radius);
  limb.addColorStop(0, "rgba(20,26,44,0)");
  limb.addColorStop(1, `rgba(20,26,44,${0.26 * dim})`);
  ctx.fillStyle = limb;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  ctx.restore();

  // Glow rides the lit limb, over the disc.
  const glowX = x + side * radius * 0.42 * (1 - illum);
  const veilAlpha = (0.09 + 0.24 * illum) * dim * (1 - murk * 0.55);
  const veilRadius = radius * (5 + murk * 1.4);
  const veil = ctx.createRadialGradient(glowX, y, radius * 0.7, glowX, y, veilRadius);
  veil.addColorStop(0, rgb(halo, veilAlpha));
  veil.addColorStop(0.25, rgb(halo, veilAlpha * 0.35));
  veil.addColorStop(0.6, rgb(halo, veilAlpha * 0.09));
  veil.addColorStop(1, rgb(halo, 0));
  ctx.fillStyle = veil;
  ctx.beginPath();
  ctx.arc(glowX, y, veilRadius, 0, TAU);
  ctx.fill();

  const bloom = ctx.createRadialGradient(glowX, y, 0, glowX, y, radius * 2.1);
  bloom.addColorStop(0, rgb(lit, (0.2 + 0.22 * illum) * dim));
  bloom.addColorStop(0.45, rgb(halo, (0.08 + 0.08 * illum) * dim));
  bloom.addColorStop(1, rgb(halo, 0));
  ctx.fillStyle = bloom;
  ctx.beginPath();
  ctx.arc(glowX, y, radius * 2.1, 0, TAU);
  ctx.fill();

  if (illum > 0.12 && murk < 0.5)
    softLozenge(ctx, glowX, y, radius * 4, radius * 0.26, lit, (0.07 + 0.07 * illum) * dim * (1 - murk * 2));

  ctx.restore();
}

// ── Lightning: a directional strike instead of an even full-frame wash.
//    The alpha ceiling, decay, and cadence are a safety property (epilepsy-
//    safe) owned by the callers — these helpers only draw. ──
export interface LightningStrike {
  x: number;
  y: number;
  points: Array<[number, number]>;
}

export function createLightningStrike(width: number, height: number): LightningStrike {
  const x = width * (0.15 + Math.random() * 0.7);
  const y = height * (0.06 + Math.random() * 0.2);
  let points: Array<[number, number]> = [
    [x, 0],
    [x + (Math.random() - 0.5) * width * 0.2, height * (0.55 + Math.random() * 0.25)],
  ];
  for (let pass = 0; pass < 5; pass += 1) {
    const out: Array<[number, number]> = [points[0]!];
    for (let index = 1; index < points.length; index += 1) {
      const [ax, ay] = points[index - 1]!;
      const [bx, by] = points[index]!;
      out.push([(ax + bx) / 2 + (Math.random() - 0.5) * (by - ay) * 0.5, (ay + by) / 2 + (Math.random() - 0.5) * 18]);
      out.push(points[index]!);
    }
    points = out;
  }
  return { x, y, points };
}

export function drawLightningFlash(
  ctx: WeatherCanvasContext,
  strike: LightningStrike,
  alpha: number,
  width: number,
  height: number,
) {
  const flash = ctx.createRadialGradient(strike.x, strike.y, 0, strike.x, strike.y, Math.max(width, height) * 0.9);
  flash.addColorStop(0, `rgba(225,232,255,${alpha})`);
  flash.addColorStop(1, "rgba(225,232,255,0)");
  ctx.fillStyle = flash;
  ctx.fillRect(0, 0, width, height);
}

export function drawLightningBolt(ctx: WeatherCanvasContext, strike: LightningStrike, alpha: number) {
  ctx.save();
  ctx.strokeStyle = `rgba(235,240,255,${0.8 * alpha})`;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(190,205,255,0.9)";
  ctx.shadowBlur = 14;
  ctx.beginPath();
  for (let index = 0; index < strike.points.length; index += 1) {
    const [px, py] = strike.points[index]!;
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.restore();
}

// ── AmbientScene: the seeded scenery layers around tint, bodies, and particles.
//    drawUnder() goes right after clearRect; drawOver() right after the body. ──

interface CloudPuff {
  x: number;
  y: number;
  size: number;
  lobes: Array<{ dx: number; dy: number; scale: number }>;
}

interface CloudLayer {
  puffs: CloudPuff[];
  speed: number;
  scale: number;
}

interface Twinkler {
  x: number;
  y: number;
  r: number;
  phase: number;
  rate: number;
}

interface Meteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

export class AmbientScene {
  private width = 0;
  private height = 0;
  private starCanvas: ScratchCanvas | null = null;
  private twinklers: Twinkler[] = [];
  private meteor: Meteor | null = null;
  private framesToMeteor = 900;
  private blobSprite: ScratchCanvas | null = null;
  private tintCanvas: ScratchCanvas | null = null;
  private tintKey = "";
  private tintCanvasHi: ScratchCanvas | null = null;
  private tintKeyHi = "";
  private auroraCanvas: ScratchCanvas | null = null;
  private rayCanvas: ScratchCanvas | null = null;
  private rayCanvasSoft: ScratchCanvas | null = null;
  private readonly cloudLayers: CloudLayer[];

  constructor() {
    const random = mulberry32(6021);
    const layers: CloudLayer[] = [];
    for (let layer = 0; layer < 3; layer += 1) {
      const puffs: CloudPuff[] = [];
      for (let index = 0; index < 7; index += 1) {
        const lobes: CloudPuff["lobes"] = [];
        const lobeCount = 4 + ((random() * 3) | 0);
        for (let lobe = 0; lobe < lobeCount; lobe += 1) {
          lobes.push({ dx: (random() - 0.5) * 2.4, dy: (random() - 0.5) * 0.6, scale: 0.55 + random() * 0.75 });
        }
        puffs.push({ x: random(), y: 0.08 + random() * 0.34 + layer * 0.08, size: 0.1 + random() * 0.1, lobes });
      }
      layers.push({ puffs, speed: 0.0044 - 0.0013 * layer, scale: 1 - 0.22 * layer });
    }
    this.cloudLayers = layers;
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.buildStars();
    this.auroraCanvas = createScratchCanvas(Math.ceil(this.width / 8), Math.ceil(this.height / 2));
    // Low-res god-ray buffers: soft edges come free with the upscale.
    this.rayCanvas = createScratchCanvas(Math.ceil(this.width / 6), Math.ceil(this.height / 6));
    this.rayCanvasSoft = createScratchCanvas(Math.ceil(this.width / 6), Math.ceil(this.height / 6));
    if (!this.blobSprite) this.buildBlobSprite();
  }

  private buildBlobSprite() {
    const size = 200;
    const sprite = createScratchCanvas(size, size);
    const ctx = scratchContext(sprite);
    if (!ctx) return;
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,0.9)");
    gradient.addColorStop(0.45, "rgba(255,255,255,0.42)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    this.blobSprite = sprite;
    this.tintCanvas = createScratchCanvas(size, size);
    this.tintKey = "";
    this.tintCanvasHi = createScratchCanvas(size, size);
    this.tintKeyHi = "";
  }

  private tintedBlobInto(
    target: ScratchCanvas | null,
    currentKey: string,
    color: RGB,
  ): { canvas: ScratchCanvas; key: string } | null {
    if (!this.blobSprite || !target) return null;
    const key = `${color[0] | 0},${color[1] | 0},${color[2] | 0}`;
    if (key !== currentKey) {
      const ctx = scratchContext(target);
      if (!ctx) return null;
      ctx.clearRect(0, 0, 200, 200);
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(this.blobSprite, 0, 0);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = rgb(color, 1);
      ctx.fillRect(0, 0, 200, 200);
      ctx.globalCompositeOperation = "source-over";
    }
    return { canvas: target, key };
  }

  private buildStars() {
    const random = mulberry32(1379);
    const { width, height } = this;
    const canvas = createScratchCanvas(width, height);
    const ctx = scratchContext(canvas);
    if (!ctx) {
      this.starCanvas = null;
      return;
    }
    ctx.save();
    ctx.translate(width * 0.5, height * 0.38);
    ctx.rotate(-0.5);
    const band = ctx.createLinearGradient(0, -height * 0.3, 0, height * 0.3);
    band.addColorStop(0, "rgba(150,170,225,0)");
    band.addColorStop(0.5, "rgba(168,186,235,0.08)");
    band.addColorStop(1, "rgba(150,170,225,0)");
    ctx.fillStyle = band;
    ctx.fillRect(-width, -height * 0.3, width * 2, height * 0.6);
    ctx.restore();
    for (let index = 0; index < 240; index += 1) {
      const x = random() * width;
      const y = Math.pow(random(), 1.2) * height * 0.92;
      const r = random() * 1.1 + 0.25;
      const alpha = 0.25 + random() * 0.6;
      const warm = random() < 0.18;
      ctx.fillStyle = warm ? `rgba(255,222,190,${alpha})` : `rgba(222,232,255,${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
    this.starCanvas = canvas;
    this.twinklers = [];
    for (let index = 0; index < 22; index += 1) {
      this.twinklers.push({
        x: random() * width,
        y: Math.pow(random(), 1.25) * height * 0.85,
        r: 0.9 + random() * 1.3,
        phase: random() * TAU,
        rate: 0.5 + random(),
      });
    }
  }

  private tintedBlob(color: RGB): ScratchCanvas | null {
    const result = this.tintedBlobInto(this.tintCanvas, this.tintKey, color);
    if (!result) return null;
    this.tintKey = result.key;
    return result.canvas;
  }

  private tintedBlobHighlight(color: RGB): ScratchCanvas | null {
    const result = this.tintedBlobInto(this.tintCanvasHi, this.tintKeyHi, color);
    if (!result) return null;
    this.tintKeyHi = result.key;
    return result.canvas;
  }

  private starAlpha(config: WeatherRenderConfig): number {
    if (config.sceneHour < 0) return 0;
    return clamp01((-sunElevation(config.sceneHour) - 0.02) / 0.28) * config.mood.starIntensity;
  }

  /** Sky wash, grades, star field, meteors, and aurora — right after clearRect. */
  drawUnder(ctx: WeatherCanvasContext, config: WeatherRenderConfig, frame: number, frameScale: number, opacity = 1) {
    const { width, height } = this;
    const hour = config.sceneHour;
    if (hour < 0 || opacity <= 0.004) return;
    const palette = sampleSkyPalette(hour);
    const elevation = sunElevation(hour);
    const nightness = clamp01((1 - elevation) / 2);
    const alphaTop = (0.14 + 0.3 * nightness) * opacity;
    const wash = ctx.createLinearGradient(0, 0, 0, height);
    wash.addColorStop(0, rgb(palette.top, alphaTop));
    wash.addColorStop(0.55, rgb(palette.mid, alphaTop * 0.8));
    wash.addColorStop(1, rgb(palette.horizon, alphaTop * 0.55));
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, width, height);

    // Moonlight grade — a cool cast that deepens with true night.
    const coolAlpha = clamp01((-elevation - 0.05) / 0.5) * 0.15 * opacity;
    if (coolAlpha > 0.004) {
      ctx.fillStyle = rgb([46, 82, 200], coolAlpha);
      ctx.fillRect(0, 0, width, height);
    }
    // Day lift — soft top-light while the sun is up, so day reads as day
    // over dark chat backgrounds. Alpha-capped low.
    const dayAlpha = clamp01(elevation) * 0.09 * (1 - config.mood.murk * 0.45) * opacity;
    if (dayAlpha > 0.004) {
      const lift = ctx.createLinearGradient(0, 0, 0, height * 0.7);
      lift.addColorStop(0, rgb(lerpRGB(palette.light, [255, 255, 255], 0.4), dayAlpha));
      lift.addColorStop(1, rgb(palette.light, 0));
      ctx.fillStyle = lift;
      ctx.fillRect(0, 0, width, height * 0.7);
    }

    const stars = this.starAlpha(config) * opacity;
    if (stars > 0.01 && this.starCanvas) {
      ctx.globalAlpha = stars;
      ctx.drawImage(this.starCanvas, 0, 0);
      ctx.globalAlpha = 1;
      for (const star of this.twinklers) {
        const alpha = stars * (0.35 + 0.65 * Math.abs(Math.sin(star.phase + frame * 0.04 * star.rate)));
        ctx.fillStyle = `rgba(230,238,255,${alpha})`;
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.r, 0, TAU);
        ctx.fill();
      }
      if (frameScale > 0 && !config.lightning) this.stepMeteor(ctx, frameScale, stars);
    }
    if (config.type === "aurora" && stars > 0.02) this.drawAurora(ctx, frame, stars);
  }

  /**
   * Crepuscular god rays from the sun: drawn into a low-res buffer (soft
   * edges for free), optionally blurred, blitted additively. The one
   * scene-level additive pass besides aurora — additive is acceptable here
   * because rays only exist when the sun is up and the scene already bright.
   */
  drawGodRays(
    ctx: WeatherCanvasContext,
    config: WeatherRenderConfig,
    frame: number,
    sunX: number,
    sunY: number,
    strength: number,
  ) {
    if (strength <= 0.012 || !this.rayCanvas || !this.rayCanvasSoft) return;
    const { width, height } = this;
    const rayCtx = scratchContext(this.rayCanvas);
    const softCtx = scratchContext(this.rayCanvasSoft);
    if (!rayCtx || !softCtx) return;
    const rw = this.rayCanvas.width;
    const rh = this.rayCanvas.height;
    const scale = rw / width;
    rayCtx.clearRect(0, 0, rw, rh);
    const rsx = sunX * scale;
    const rsy = sunY * scale;
    const maxRadius = Math.hypot(rw, rh) * 1.15;
    const hour = config.sceneHour >= 0 ? config.sceneHour : 12;
    const warmth = clamp01(1 - sunElevation(hour) * 2);
    const rayColor = lerpRGB([255, 246, 222], [255, 178, 118], warmth);
    const gradient = rayCtx.createRadialGradient(rsx, rsy, rw * 0.012, rsx, rsy, maxRadius);
    gradient.addColorStop(0, rgb(rayColor, 0.4));
    gradient.addColorStop(0.1, rgb(rayColor, 0.2));
    gradient.addColorStop(0.28, rgb(rayColor, 0.075));
    gradient.addColorStop(0.52, rgb(rayColor, 0.02));
    gradient.addColorStop(0.8, rgb(rayColor, 0));
    gradient.addColorStop(1, rgb(rayColor, 0));
    rayCtx.fillStyle = gradient;
    const baseAngle = frame * 0.0006;
    for (let index = 0; index < 9; index += 1) {
      const angle = baseAngle + index * (TAU / 9) + Math.sin(frame * 0.003 + index * 2.4) * 0.07;
      const halfWidth = 0.018 + 0.04 * (0.5 + 0.5 * Math.sin(index * 3.1 + 1));
      // Uneven: some shafts sit near zero, a few carry the moment.
      const pulse = Math.max(0, -0.25 + 1.25 * Math.abs(Math.sin(frame * 0.005 + index * 1.71)));
      if (pulse < 0.03) continue;
      rayCtx.globalAlpha = pulse;
      rayCtx.beginPath();
      rayCtx.moveTo(rsx, rsy);
      rayCtx.lineTo(rsx + Math.cos(angle - halfWidth) * maxRadius, rsy + Math.sin(angle - halfWidth) * maxRadius);
      rayCtx.lineTo(rsx + Math.cos(angle + halfWidth) * maxRadius, rsy + Math.sin(angle + halfWidth) * maxRadius);
      rayCtx.closePath();
      rayCtx.fill();
    }
    rayCtx.globalAlpha = 1;
    softCtx.clearRect(0, 0, rw, rh);
    if (supportsCanvasFilter(softCtx)) {
      softCtx.filter = "blur(2.5px)";
      softCtx.drawImage(this.rayCanvas, 0, 0);
      softCtx.filter = "none";
    } else {
      softCtx.drawImage(this.rayCanvas, 0, 0);
    }
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = strength * 0.3;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.rayCanvasSoft, 0, 0, width, height);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private stepMeteor(ctx: WeatherCanvasContext, frameScale: number, starAlpha: number) {
    if (!this.meteor) {
      this.framesToMeteor -= frameScale;
      if (this.framesToMeteor <= 0 && starAlpha > 0.6) {
        this.meteor = {
          x: this.width * (0.15 + Math.random() * 0.7),
          y: this.height * (0.05 + Math.random() * 0.25),
          vx: (Math.random() < 0.5 ? -1 : 1) * (9 + Math.random() * 5),
          vy: 4 + Math.random() * 3,
          life: 1,
        };
        this.framesToMeteor = 550 + Math.random() * 850;
      }
      return;
    }
    const meteor = this.meteor;
    meteor.life -= frameScale / 42;
    meteor.x += meteor.vx * frameScale;
    meteor.y += meteor.vy * frameScale;
    if (meteor.life <= 0) {
      this.meteor = null;
      return;
    }
    const trail = ctx.createLinearGradient(meteor.x, meteor.y, meteor.x - meteor.vx * 8, meteor.y - meteor.vy * 8);
    trail.addColorStop(0, `rgba(255,255,255,${0.9 * meteor.life * starAlpha})`);
    trail.addColorStop(1, "rgba(255,255,255,0)");
    ctx.strokeStyle = trail;
    ctx.lineWidth = 1.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(meteor.x, meteor.y);
    ctx.lineTo(meteor.x - meteor.vx * 8, meteor.y - meteor.vy * 8);
    ctx.stroke();
  }

  /** Aurora curtains rendered low-res and blitted stretched, as silk. */
  private drawAurora(ctx: WeatherCanvasContext, frame: number, starAlpha: number) {
    if (!this.auroraCanvas) return;
    const auroraCtx = scratchContext(this.auroraCanvas);
    if (!auroraCtx) return;
    const { width, height } = this;
    const GREEN: RGB = [70, 235, 165];
    const TEAL: RGB = [80, 200, 235];
    const VIOLET: RGB = [172, 110, 240];
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const backdrop = ctx.createLinearGradient(0, height * 0.03, 0, height * 0.55);
    backdrop.addColorStop(0, rgb(VIOLET, 0.035 * starAlpha));
    backdrop.addColorStop(0.6, rgb(GREEN, 0.05 * starAlpha));
    backdrop.addColorStop(1, rgb(GREEN, 0));
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, height * 0.03, width, height * 0.52);

    const auroraWidth = this.auroraCanvas.width;
    const auroraHeight = this.auroraCanvas.height;
    const yScale = auroraHeight / height;
    auroraCtx.clearRect(0, 0, auroraWidth, auroraHeight);
    for (let band = 0; band < 2; band += 1) {
      const sway = band ? 1.6 : 1;
      const offset = band * 2.7;
      for (let column = 0; column < auroraWidth; column += 1) {
        const x = column * 8;
        const hem =
          (height * (0.36 + band * 0.1) +
            Math.sin(x * 0.0011 + frame * 0.011 * sway + offset) * height * 0.085 +
            Math.sin(x * 0.0034 - frame * 0.006 + offset * 1.7) * height * 0.038) *
          yScale;
        const length =
          height * (0.3 + band * 0.07) * (0.55 + 0.45 * Math.sin(x * 0.0021 + frame * 0.008 + offset)) * yScale;
        const shimmer =
          0.42 +
          0.42 * Math.sin(x * 0.012 + frame * 0.05 + offset * 3) +
          0.26 * Math.sin(x * 0.031 - frame * 0.032 + offset);
        const alpha = Math.max(0, shimmer) * (band ? 0.26 : 0.42) * starAlpha;
        if (alpha < 0.004) continue;
        const hue = 0.5 + 0.5 * Math.sin(x * 0.0016 + frame * 0.004 + offset);
        const low = lerpRGB(GREEN, TEAL, hue);
        const high = lerpRGB(low, VIOLET, 0.75);
        const curtain = auroraCtx.createLinearGradient(0, hem - length, 0, hem);
        curtain.addColorStop(0, rgb(high, 0));
        curtain.addColorStop(0.45, rgb(high, alpha * 0.38));
        curtain.addColorStop(0.88, rgb(low, alpha));
        curtain.addColorStop(1, rgb(low, alpha * 0.5));
        auroraCtx.fillStyle = curtain;
        auroraCtx.fillRect(column, hem - length, 1, length);
      }
    }
    ctx.drawImage(this.auroraCanvas, 0, 0, width, height);
    ctx.restore();
  }

  /** Cloud deck, weather veil, fog banks, and horizon glow — after the body. */
  drawOver(ctx: WeatherCanvasContext, config: WeatherRenderConfig, frame: number, opacity = 1) {
    const { width, height } = this;
    if (opacity <= 0.004) return;
    const mood = config.mood;
    const hour = config.sceneHour;
    const palette = hour >= 0 ? sampleSkyPalette(hour) : null;

    if (mood.cloudiness > 0.02) {
      const night = palette ? clamp01(this.starAlpha(config) * 1.2) : 0;
      let cloudColor: RGB = palette
        ? lerpRGB(lerpRGB([250, 250, 252], palette.light, 0.5), lerpRGB(palette.mid, [8, 10, 20], 0.3), night)
        : [150, 155, 168];
      cloudColor = lerpRGB(cloudColor, [42, 48, 60], mood.shade);
      const sprite = this.tintedBlob(cloudColor);
      // Lit upper rim — keeps shaded storm/rain cover legible on dark grounds.
      const highlightColor = lerpRGB(
        cloudColor,
        lerpRGB([255, 255, 255], palette ? palette.light : [235, 238, 245], 0.35),
        0.55,
      );
      const spriteHi = this.tintedBlobHighlight(highlightColor);
      if (sprite) {
        const drift = 0.4 + mood.windStrength * 0.6;
        for (let index = 0; index < this.cloudLayers.length; index += 1) {
          const layer = this.cloudLayers[index]!;
          const alpha = mood.cloudiness * (0.2 - index * 0.045) * (1 + mood.shade * 0.9) * (1 - 0.45 * night) * opacity;
          if (alpha <= 0.004) continue;
          for (const puff of layer.puffs) {
            const px = (((puff.x + frame * layer.speed * drift) % 1.3) - 0.15) * width;
            for (const lobe of puff.lobes) {
              const size = puff.size * lobe.scale * width * layer.scale;
              const bx = px + lobe.dx * puff.size * width * 0.5 - size / 2;
              const by = puff.y * height * 0.62 + lobe.dy * puff.size * width * 0.5 - size * 0.3;
              ctx.globalAlpha = alpha;
              ctx.drawImage(sprite, bx, by, size, size * 0.6);
              if (spriteHi) {
                ctx.globalAlpha = alpha * 0.5;
                ctx.drawImage(spriteHi, bx + size * 0.02, by - size * 0.05, size * 0.96, size * 0.52);
              }
            }
          }
          ctx.globalAlpha = 1;
        }
      }
    }

    if (mood.veil) {
      const [r, g, b, a] = mood.veil;
      ctx.fillStyle = `rgba(${r},${g},${b},${a * opacity})`;
      ctx.fillRect(0, 0, width, height);
    }

    if (mood.fogBanks) {
      const fogColor = palette ? lerpRGB(palette.light, [236, 239, 244], 0.55) : ([232, 235, 241] as RGB);
      for (let index = 0; index < 4; index += 1) {
        const y = height * (0.45 + index * 0.16) + Math.sin(frame * 0.008 + index * 2.1) * 10;
        const thickness = height * (0.09 + index * 0.02);
        const bank = ctx.createLinearGradient(0, y - thickness, 0, y + thickness);
        bank.addColorStop(0, rgb(fogColor, 0));
        bank.addColorStop(0.5, rgb(fogColor, (0.13 + 0.03 * index) * opacity));
        bank.addColorStop(1, rgb(fogColor, 0));
        ctx.fillStyle = bank;
        ctx.fillRect(0, y - thickness, width, thickness * 2);
      }
    }

    if (palette && hour >= 0 && mood.shade < 0.5) {
      const near = 1 - Math.min(1, Math.abs(sunElevation(hour)) * 2.4);
      if (near > 0.01) {
        const glow = ctx.createLinearGradient(0, height * 0.62, 0, height);
        glow.addColorStop(0, rgb(palette.horizon, 0));
        glow.addColorStop(1, rgb(lerpRGB(palette.horizon, palette.light, 0.5), 0.18 * near * opacity));
        ctx.fillStyle = glow;
        ctx.fillRect(0, height * 0.62, width, height * 0.38);
      }
    }
  }
}

// ── AmbientSkyRenderer: the shared frame director for both render paths.
//    Owns the scene, the celestial bodies (with murk diffusion and god rays),
//    and a config crossfade so a world-tracker update never snaps or remounts:
//    the old sky fades out while the new one fades in over ~2.5 s. ──
const CONFIG_BLEND_FRAMES = 75;

export class AmbientSkyRenderer {
  readonly scene = new AmbientScene();
  private active: WeatherRenderConfig | null = null;
  private previous: WeatherRenderConfig | null = null;
  private blend = 1;
  private moonPhase = DEFAULT_MOON_PHASE;
  private moonScratch: ScratchCanvas | null = null;
  private width = 1;
  private height = 1;

  get config(): WeatherRenderConfig | null {
    return this.active;
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.scene.resize(width, height);
    // Offscreen for the moon so it can be blitted through a blur when murky.
    const side = Math.ceil(Math.min(this.width, this.height) * 0.035 * 1.28 * 12) + 8;
    this.moonScratch = createScratchCanvas(side, side);
  }

  /**
   * Adopt a new config. Returns true when it changed — the caller then starts
   * its own particle turnover (fadeWeatherParticlesForConfig) and lightning
   * rearm; the sky crossfade is handled here.
   */
  setConfig(config: WeatherRenderConfig, moonPhase: number): boolean {
    this.moonPhase = moonPhase;
    if (config === this.active) return false;
    if (this.active) {
      this.previous = this.active;
      this.blend = 0;
    }
    this.active = config;
    return true;
  }

  advance(frameScale: number) {
    if (this.blend >= 1) return;
    this.blend = Math.min(1, this.blend + frameScale / CONFIG_BLEND_FRAMES);
    if (this.blend >= 1) this.previous = null;
  }

  private layers(): Array<[WeatherRenderConfig, number]> {
    if (!this.active) return [];
    if (!this.previous || this.blend >= 1) return [[this.active, 1]];
    const t = smoothstep(this.blend);
    return [
      [this.previous, 1 - t],
      [this.active, t],
    ];
  }

  drawUnder(ctx: WeatherCanvasContext, frame: number, frameScale: number) {
    const layers = this.layers();
    for (let index = 0; index < layers.length; index += 1) {
      const [config, weight] = layers[index]!;
      // Only the newest layer advances simulation state (meteors).
      this.scene.drawUnder(ctx, config, frame, index === layers.length - 1 ? frameScale : 0, weight);
    }
  }

  drawBodies(ctx: WeatherCanvasContext, frame: number, showCelestial: boolean) {
    if (!showCelestial) return;
    for (const [config, weight] of this.layers()) {
      this.drawBodyLayer(ctx, config, frame, weight);
    }
  }

  private drawBodyLayer(ctx: WeatherCanvasContext, config: WeatherRenderConfig, frame: number, weight: number) {
    if (config.celestial === "none") return;
    const { width, height } = this;
    const radius = Math.min(width, height) * 0.035;
    const hour = config.sceneHour >= 0 ? config.sceneHour : 12;
    const murk = config.mood.murk;
    const dim = config.mood.bodyDim * weight;
    if (dim <= 0.02) return;

    if (config.celestial === "sun") {
      const sunX = weatherCelestialX(hour, width);
      const sunY = weatherCelestialY(hour, height, false);
      const elevation = sunElevation(hour);
      // Ray strength, computed before the sun so its streak can yield.
      const rayStrength = smoothstep(clamp01(elevation / 0.12)) * Math.max(0, 1 - murk * 1.7) * weight;
      drawLuminousSun(ctx, sunX, sunY, radius, elevation, frame, dim, murk, rayStrength);
      if (elevation > 0) this.scene.drawGodRays(ctx, config, frame, sunX, sunY, rayStrength);
      return;
    }

    const moonNorm = hour >= 12 ? ((hour - 21 + 24) % 24) / 10 : (hour + 3) / 10;
    const moonX = width * 0.1 + Math.min(1, Math.max(0, moonNorm)) * width * 0.8;
    const moonY = weatherCelestialY(hour, height, true);
    const moonRadius = radius * 1.28;
    const altitude = moonAltitude(hour);
    const scratchCtx = this.moonScratch ? scratchContext(this.moonScratch) : null;
    if (murk > 0.05 && this.moonScratch && scratchCtx && supportsCanvasFilter(ctx)) {
      // Murky weather diffuses the moon: draw it offscreen, blit through a blur.
      const center = this.moonScratch.width / 2;
      scratchCtx.clearRect(0, 0, this.moonScratch.width, this.moonScratch.height);
      drawLuminousMoon(scratchCtx, center, center, moonRadius, altitude, this.moonPhase, dim, murk);
      ctx.save();
      ctx.filter = `blur(${(murk * 2.2).toFixed(1)}px)`;
      ctx.drawImage(this.moonScratch, moonX - center, moonY - center);
      ctx.restore();
      ctx.filter = "none";
    } else {
      drawLuminousMoon(ctx, moonX, moonY, moonRadius, altitude, this.moonPhase, dim, murk);
    }
  }

  drawOver(ctx: WeatherCanvasContext, frame: number) {
    for (const [config, weight] of this.layers()) {
      this.scene.drawOver(ctx, config, frame, weight);
    }
  }
}
