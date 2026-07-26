/**
 * extension/src/freighter-compat.ts
 *
 * Graceful error handling for Freighter wallet API compatibility.
 *
 * Public surface:
 *   - MINIMUM_FREIGHTER_VERSION     — the lowest API version this extension supports
 *   - FreighterApiInfo              — result of probing the injected window.freighter object
 *   - detectFreighterApi()          — probe what's available in `window.freighter`
 *   - callFreighter()               — safely call a Freighter method with version check
 *   - getFreighterApiInfo()         — convenience wrapper that returns info + cached state
 *   - formatFreighterError()        — turn any error into an actionable upgrade message
 *   - assertFreighterApiReady()     — throw a typed error if the API isn't compatible
 *
 * Required Freighter methods used by this extension:
 *   - getPublicKey          (core: connect / address display)
 *   - signTransaction       (core: signing donations)
 *   - isConnected           (settings page status check)
 *   - disconnect            (settings page log-out)
 *
 * Version detection strategy:
 *   1. If `window.freighter` is missing  → "not installed"
 *      (we still allow checking via injected bridge scripts in content scripts)
 *   2. If a method we need is not a function → "outdated API; please update Freighter"
 *   3. If window.freighter.getApiVersion is a function, query it and compare to
 *      MINIMUM_FREIGHTER_VERSION. We use a [major, minor, patch] tuple comparison so
 *      older builds ("2.5.0") vs newer ("2.10.0") compare correctly.
 *
 * This module is intentionally pure (no side effects) so it can be imported
 * safely from popup.ts, content scripts, settings.ts, and unit tests.
 */

// ── public types ─────────────────────────────────────────────────────

/**
 * The lowest Freighter API version this extension supports.
 * Bump this when we add a dependency on a newer Freighter capability.
 */
export const MINIMUM_FREIGHTER_VERSION: readonly [number, number, number] = [
  2, 0, 0,
];

/** Methods the extension relies on. */
export const REQUIRED_METHODS = [
  "getPublicKey",
  "signTransaction",
  "isConnected",
  "disconnect",
] as const;

export type FreighterMethodName = (typeof REQUIRED_METHODS)[number];

/** Probe result describing the current state of the injected Freighter API. */
export interface FreighterApiInfo {
  /** True if `window.freighter` exists (or a stub was provided). */
  installed: boolean;
  /** Reported semver tuple, or null if version info isn't available. */
  version: [number, number, number] | null;
  /** Semver string as reported by Freighter, or null. */
  versionString: string | null;
  /** Methods this extension requires that are actually callable. */
  availableMethods: FreighterMethodName[];
  /** Methods this extension requires that are missing. */
  missingMethods: FreighterMethodName[];
  /** True if installed AND no required methods are missing AND version is OK. */
  isCompatible: boolean;
  /** True if installed but doesn't meet our requirements. */
  isOutdated: boolean;
  /** Human-readable description of the issue, or null if everything is fine. */
  issue: string | null;
  /** URL where the user can update Freighter. */
  upgradeUrl: string;
}

// ── parity helpers ────────────────────────────────────────────────────

/**
 * Compare two semver tuples. Returns negative if a<b, positive if a>b, 0 if equal.
 * The tuple comparison MUST be done element-wise because we want 2.10.0 > 2.5.0.
 */
export function compareSemver(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    const av = a[i];
    const bv = b[i];
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Returns true if `version` is greater than or equal to `minimum`.
 */
export function meetsMinimumVersion(
  version: [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  return compareSemver(version, minimum as [number, number, number]) >= 0;
}

/**
 * Parse a "1.2.3" style string into a [major, minor, patch] tuple.
 * Returns null for invalid input.
 */
export function parseSemver(input: string | null | undefined): [number, number, number] | null {
  if (!input || typeof input !== "string") return null;
  const parts = input.trim().split(".");
  if (parts.length < 1) return null;
  const nums: number[] = [];
  for (let i = 0; i < 3; i++) {
    const p = parts[i];
    const n = p === undefined ? 0 : parseInt(p, 10);
    if (Number.isNaN(n)) return null;
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!];
}

// ── core detection ───────────────────────────────────────────────────

/**
 * Probe `window.freighter` (or the provided global) and produce a
 * `FreighterApiInfo` describing whether the API is usable.
 *
 * Does not call any Freighter methods that require user interaction —
 * safe to invoke synchronously at popup open.
 */
export function detectFreighterApi(
  freighterGlobal?: unknown,
): FreighterApiInfo {
  const upgradeUrl = "https://www.freighter.app/";
  const freighter =
    freighterGlobal ??
    (typeof window !== "undefined" ? (window as any).freighter : undefined);

  if (!freighter || typeof freighter !== "object") {
    return {
      installed: false,
      version: null,
      versionString: null,
      availableMethods: [],
      missingMethods: [...REQUIRED_METHODS],
      isCompatible: false,
      isOutdated: false,
      issue:
        "Freighter wallet extension not detected. Please install Freighter to continue.",
      upgradeUrl,
    };
  }

  const available: FreighterMethodName[] = [];
  const missing: FreighterMethodName[] = [];

  for (const name of REQUIRED_METHODS) {
    // Treat anything that isn't a callable function as "missing".
    // Freighter occasionally exposes object descriptors for methods that
    // require an active connection, so `typeof === "function"` is the
    // canonical compatibility check.
    if (typeof (freighter as any)[name] === "function") {
      available.push(name);
    } else {
      missing.push(name);
    }
  }

  // Try to read a version. Freighter exposes getApiVersion() returning
  // { version: "x.y.z" } OR directly a string. Both are supported here.
  let version: [number, number, number] | null = null;
  let versionString: string | null = null;
  try {
    const fn = (freighter as any).getApiVersion;
    if (typeof fn === "function") {
      const result = fn.call(freighter);
      if (typeof result === "string") {
        versionString = result;
        version = parseSemver(result);
      } else if (result && typeof result === "object") {
        versionString =
          (result as any).version ?? (result as any).apiVersion ?? null;
        version = parseSemver(versionString);
      }
    }
  } catch {
    // Ignore — we'll fall through to a method-based detection.
  }

  // If individual method checks already show missing methods, that's the
  // dominant signal — Freighter is outdated, regardless of reported version.
  if (missing.length > 0) {
    const list = missing.join(", ");
    return {
      installed: true,
      version,
      versionString,
      availableMethods: available,
      missingMethods: missing,
      isCompatible: false,
      isOutdated: true,
      issue: `Your Freighter wallet is outdated and is missing the following API method${missing.length === 1 ? "" : "s"}: ${list}. Please update Freighter to the latest version.`,
      upgradeUrl,
    };
  }

  // If Freighter is installed and all methods exist, check the version too.
  if (version && !meetsMinimumVersion(version, MINIMUM_FREIGHTER_VERSION)) {
    return {
      installed: true,
      version,
      versionString,
      availableMethods: available,
      missingMethods: [],
      isCompatible: false,
      isOutdated: true,
      issue: `Your Freighter wallet (v${versionString ?? version.join(".")}) is older than the minimum supported version (v${MINIMUM_FREIGHTER_VERSION.join(".")}). Please update Freighter.`,
      upgradeUrl,
    };
  }

  return {
    installed: true,
    version,
    versionString,
    availableMethods: available,
    missingMethods: [],
    isCompatible: available.length === REQUIRED_METHODS.length,
    isOutdated: false,
    issue: null,
    upgradeUrl,
  };
}

/**
 * Convenience for one-shot checks. Always probes fresh — callers should cache
 * if they need multiple reads.
 */
export function getFreighterApiInfo(): FreighterApiInfo {
  return detectFreighterApi();
}

// ── safe method calls ────────────────────────────────────────────────

/**
 * Call a Freighter method safely. If the method is missing or the API is
 * outdated, throws a typed `FreighterOutdatedError`. If a runtime call fails,
 * the original error bubbles up (callers can inspect `.message`).
 *
 * Always wraps the call in a try/catch so a `TypeError: freighter.foo is not
 * a function`-style error is converted into an actionable upgrade message
 * instead of a cryptic wall of text.
 *
 * The optional `freighterGlobal` parameter lets callers in injected-script
 * contexts (content-script bridge) pass the resolved object instead of
 * relying on `window.freighter`, which is not visible across isolated worlds
 * in Chrome MV3.
 */
export async function callFreighter<T = unknown>(
  method: FreighterMethodName,
  freighterGlobal?: unknown,
  ...args: unknown[]
): Promise<T> {
  const info = detectFreighterApi(freighterGlobal);
  if (!info.isCompatible || !info.installed) {
    if (!info.installed) {
      throw new FreighterNotInstalledError(info);
    }
    throw new FreighterOutdatedError(info);
  }
  const freighter = (freighterGlobal ??
    (typeof window !== "undefined" ? (window as any).freighter : undefined)) as any;
  if (!freighter || typeof freighter[method] !== "function") {
    // Defensive: race condition could remove the method between detection
    // and the call. Re-probe and throw a fresh error.
    throw new FreighterOutdatedError(detectFreighterApi(freighterGlobal));
  }
  try {
    const result = await freighter[method](...args);
    return result as T;
  } catch (err: any) {
    // If Freighter itself removes a method mid-call (very rare), the runtime
    // would throw a TypeError. Re-raise as a typed compatibility error so
    // callers always get an actionable message.
    if (
      err &&
      typeof err.message === "string" &&
      err.message.includes("is not a function")
    ) {
      throw new FreighterOutdatedError(detectFreighterApi(freighterGlobal));
    }
    throw err;
  }
}

// ── error classes ─────────────────────────────────────────────────────

/**
 * Thrown when the Freighter API is installed but its shape doesn't match
 * what this extension needs (outdated or API version mismatch).
 *
 * Always carries a human-readable `message` AND a `info` payload so the
 * popup/overlay can render an actionable upgrade prompt with the URL.
 */
export class FreighterOutdatedError extends Error {
  public readonly info: FreighterApiInfo;

  constructor(info: FreighterApiInfo) {
    super(
      info.issue ??
        "Freighter wallet API is not compatible. Please update to the latest version.",
    );
    this.name = "FreighterOutdatedError";
    this.info = info;
  }
}

/**
 * Thrown when Freighter is not installed at all.
 */
export class FreighterNotInstalledError extends Error {
  public readonly info: FreighterApiInfo;

  constructor(info: FreighterApiInfo) {
    super(
      info.issue ??
        "Freighter wallet extension not detected. Please install Freighter to continue.",
    );
    this.name = "FreighterNotInstalledError";
    this.info = info;
  }
}

// ── formatters & guards ───────────────────────────────────────────────

/**
 * Convert any error (or raw value) thrown by a Freighter call into a
 * user-facing message. Returns `{ message, upgradeUrl, isOutdated }` so
 * callers can show a link or special styling.
 */
export function formatFreighterError(err: unknown): {
  message: string;
  upgradeUrl: string;
  isOutdated: boolean;
  isNotInstalled: boolean;
} {
  const fallbackUpgradeUrl = "https://www.freighter.app/";
  if (err instanceof FreighterOutdatedError) {
    return {
      message: err.message,
      upgradeUrl: err.info.upgradeUrl ?? fallbackUpgradeUrl,
      isOutdated: true,
      isNotInstalled: false,
    };
  }
  if (err instanceof FreighterNotInstalledError) {
    return {
      message: err.message,
      upgradeUrl: err.info.upgradeUrl ?? fallbackUpgradeUrl,
      isOutdated: false,
      isNotInstalled: true,
    };
  }
  if (err instanceof Error) {
    return {
      message: err.message || "Unknown Freighter error",
      upgradeUrl: fallbackUpgradeUrl,
      isOutdated: false,
      isNotInstalled: false,
    };
  }
  return {
    message: "Unknown Freighter error",
    upgradeUrl: fallbackUpgradeUrl,
    isOutdated: false,
    isNotInstalled: false,
  };
}

/**
 * Asserts that the Freighter API is usable. If not, throws the appropriate
 * typed error. Use this at the top of user-initiated flows (connect,
 * donate) so failures are caught and surfaced as upgrade prompts.
 */
export function assertFreighterApiReady(): FreighterApiInfo {
  const info = detectFreighterApi();
  if (!info.installed) {
    throw new FreighterNotInstalledError(info);
  }
  if (!info.isCompatible) {
    throw new FreighterOutdatedError(info);
  }
  return info;
}
