/** Fork provenance reported by `/health`; `null` on a stock checkout. */
export interface SupportDiagnosticsFork {
  repo: string | null;
  branch: string | null;
  baseRef: string | null;
  baseCommit: string | null;
  baseVersion: string | null;
  commitsAhead: number | null;
}

export interface SupportDiagnostics {
  version: string;
  build: string;
  commit: string | null;
  fork?: SupportDiagnosticsFork | null;
  serverOs: string;
  serverMemory?: {
    heapUsedMiB: number;
    heapLimitMiB: number;
    rssMiB: number;
  };
  clientOs: string;
  browser: string;
  gpu: string;
  connectionName: string | null;
  connectionProvider: string | null;
  model: string | null;
}

export function resolveClientOs(userAgent: string, platform: string, maxTouchPoints = 0): string {
  const windows = userAgent.match(/Windows NT ([\d.]+)/u);
  if (windows) return `Windows ${windows[1]}`;
  const android = userAgent.match(/Android ([\d.]+)/u);
  if (android) return `Android ${android[1]}`;
  const ios = userAgent.match(/(?:iPhone OS|CPU OS) ([\d_]+)/u);
  if (ios) return `iOS ${ios[1]!.replaceAll("_", ".")}`;
  if (/Macintosh/u.test(userAgent) && maxTouchPoints > 1) {
    const webkitVersion = userAgent.match(/AppleWebKit\/([\d.]+)/u)?.[1];
    return webkitVersion ? `iPadOS (WebKit ${webkitVersion})` : "iPadOS";
  }
  const mac = userAgent.match(/Mac OS X ([\d_]+)/u);
  if (mac) return `macOS ${mac[1]!.replaceAll("_", ".")}`;
  if (/Linux/u.test(userAgent)) return "Linux";
  return platform.trim() || "Unavailable";
}

export function detectBrowserGpu(): string {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!context) return "Unavailable";
    const debugInfo = context.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
    const renderer = debugInfo
      ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : context.getParameter(context.RENDERER);
    return typeof renderer === "string" && renderer.trim() ? renderer.trim() : "Unavailable";
  } catch {
    return "Unavailable";
  }
}

function available(value: string | null | undefined): string {
  return value?.trim() || "Unavailable";
}

/** e.g. `luma-inibitor/Marinara-Engine @ luma/staging (6 commits ahead of origin/staging)`. */
export function formatForkSummary(fork: SupportDiagnosticsFork): string {
  const checkout = `${fork.repo?.trim() || "Unknown repository"} @ ${fork.branch?.trim() || "detached HEAD"}`;
  if (fork.commitsAhead == null) return checkout;
  const commits = `${fork.commitsAhead} commit${fork.commitsAhead === 1 ? "" : "s"} ahead`;
  const baseRef = fork.baseRef?.trim();
  return `${checkout} (${baseRef ? `${commits} of ${baseRef}` : commits})`;
}

/** e.g. `2.4.3+2b3232ff15df` — the build label of the upstream commit this fork sits on. */
export function formatForkBaseBuild(fork: SupportDiagnosticsFork): string | null {
  const version = fork.baseVersion?.trim();
  const commit = fork.baseCommit?.trim();
  if (!version) return commit || null;
  return commit ? `${version}+${commit}` : version;
}

export function formatSupportDiagnostics(diagnostics: SupportDiagnostics): string {
  const memory = diagnostics.serverMemory;
  const { fork } = diagnostics;
  return [
    "Marinara Engine diagnostics",
    `Version: ${available(diagnostics.version)}`,
    `Build: ${available(diagnostics.build)}`,
    `Commit: ${available(diagnostics.commit)}`,
    // Omitted entirely on a stock checkout, so upstream tickets read unchanged.
    ...(fork
      ? [
          `Fork: ${formatForkSummary(fork)}`,
          `Upstream version: ${available(fork.baseVersion)}`,
          `Upstream build: ${available(formatForkBaseBuild(fork))}`,
          `Upstream commit: ${available(fork.baseCommit)}`,
        ]
      : []),
    `Server OS: ${available(diagnostics.serverOs)}`,
    `Server memory: ${memory ? `heap ${memory.heapUsedMiB} / ${memory.heapLimitMiB} MiB; RSS ${memory.rssMiB} MiB` : "Unavailable"}`,
    `Client OS: ${available(diagnostics.clientOs)}`,
    `Browser / app shell: ${available(diagnostics.browser)}`,
    `GPU: ${available(diagnostics.gpu)}`,
    `Active connection: ${available(diagnostics.connectionName)}`,
    `Connection provider: ${available(diagnostics.connectionProvider)}`,
    `LLM model: ${available(diagnostics.model)}`,
  ].join("\n");
}
