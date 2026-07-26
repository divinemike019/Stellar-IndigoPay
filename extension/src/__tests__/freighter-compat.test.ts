/**
 * Tests for the Freighter compatibility module (extension/src/freighter-compat.ts).
 *
 * Covers:
 *  - parseSemver() parsing & invalid input handling
 *  - compareSemver() tuple ordering (2.10.0 > 2.5.0)
 *  - meetsMinimumVersion()
 *  - detectFreighterApi() — missing, fully compatible, missing methods, outdated version
 *  - FreighterOutdatedError / FreighterNotInstalledError typed errors
 *  - callFreighter() — safe wrapper that throws typed errors
 *  - formatFreighterError() — turns any error into UI-friendly output
 *  - assertFreighterApiReady() — guard helper
 */

import {
  MINIMUM_FREIGHTER_VERSION,
  REQUIRED_METHODS,
  parseSemver,
  compareSemver,
  meetsMinimumVersion,
  detectFreighterApi,
  getFreighterApiInfo,
  callFreighter,
  formatFreighterError,
  assertFreighterApiReady,
  FreighterOutdatedError,
  FreighterNotInstalledError,
} from "../freighter-compat";

// ── helpers ─────────────────────────────────────────────────────────

/** Build a fully-compatible Freighter stub. */
function makeCompatibleFreighter(versionString?: string): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of REQUIRED_METHODS) {
    stub[m] = jest.fn().mockResolvedValue("ok");
  }
  if (versionString) {
    stub.getApiVersion = jest.fn().mockReturnValue(versionString);
  }
  return stub;
}

/** Build a Freighter stub missing one or more methods. */
function makeOutdatedFreighter(
  missing: string[] = ["signTransaction"],
  versionString?: string,
): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of REQUIRED_METHODS) {
    if (!missing.includes(m)) {
      stub[m] = jest.fn().mockResolvedValue("ok");
    }
  }
  if (versionString) {
    stub.getApiVersion = jest.fn(() => {
      throw new Error("getApiVersion crashed");
    });
  }
  return stub;
}

// ── 1. parseSemver ──────────────────────────────────────────────────

describe("parseSemver", () => {
  test("parses a standard 3-part version", () => {
    expect(parseSemver("2.5.1")).toEqual([2, 5, 1]);
  });

  test("parses a 2-part version (defaults patch to 0)", () => {
    expect(parseSemver("2.5")).toEqual([2, 5, 0]);
  });

  test("parses a 1-part version", () => {
    expect(parseSemver("3")).toEqual([3, 0, 0]);
  });

  test("trims surrounding whitespace", () => {
    expect(parseSemver("  4.2.0  ")).toEqual([4, 2, 0]);
  });

  test("returns null for non-strings", () => {
    expect(parseSemver(null)).toBeNull();
    expect(parseSemver(undefined)).toBeNull();
    expect(parseSemver(123 as any)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseSemver("")).toBeNull();
  });

  test("returns null for non-numeric parts", () => {
    expect(parseSemver("a.b.c")).toBeNull();
    expect(parseSemver("2.x.0")).toBeNull();
  });
});

// ── 2. compareSemver ────────────────────────────────────────────────

describe("compareSemver", () => {
  test("returns 0 for equal tuples", () => {
    expect(compareSemver([2, 5, 1], [2, 5, 1])).toBe(0);
  });

  test("compares major first", () => {
    expect(compareSemver([3, 0, 0], [2, 99, 99])).toBeGreaterThan(0);
    expect(compareSemver([1, 99, 99], [2, 0, 0])).toBeLessThan(0);
  });

  test("compares minor when major is equal", () => {
    expect(compareSemver([2, 6, 0], [2, 5, 99])).toBeGreaterThan(0);
    expect(compareSemver([2, 4, 99], [2, 5, 0])).toBeLessThan(0);
  });

  test("compares patch when major+minor are equal", () => {
    expect(compareSemver([2, 5, 2], [2, 5, 1])).toBeGreaterThan(0);
    expect(compareSemver([2, 5, 0], [2, 5, 1])).toBeLessThan(0);
  });

  test("treats 2.10.0 as greater than 2.5.0 (numeric, not lexicographic)", () => {
    expect(compareSemver([2, 10, 0], [2, 5, 0])).toBeGreaterThan(0);
    expect(compareSemver([2, 5, 0], [2, 10, 0])).toBeLessThan(0);
  });
});

// ── 3. meetsMinimumVersion ──────────────────────────────────────────

describe("meetsMinimumVersion", () => {
  test("exact version meets the minimum", () => {
    expect(
      meetsMinimumVersion([2, 0, 0], MINIMUM_FREIGHTER_VERSION),
    ).toBe(true);
  });

  test("higher version meets the minimum", () => {
    expect(
      meetsMinimumVersion([2, 5, 1], MINIMUM_FREIGHTER_VERSION),
    ).toBe(true);
    expect(
      meetsMinimumVersion([3, 0, 0], MINIMUM_FREIGHTER_VERSION),
    ).toBe(true);
  });

  test("older version does not meet the minimum", () => {
    expect(
      meetsMinimumVersion([1, 9, 9], MINIMUM_FREIGHTER_VERSION),
    ).toBe(false);
    expect(
      meetsMinimumVersion([2, 0, 0 - 1], MINIMUM_FREIGHTER_VERSION),
    ).toBe(false);
  });
});

// ── 4. detectFreighterApi — basic presence ─────────────────────────

describe("detectFreighterApi (Freighter presence)", () => {
  test("returns installed=false when window.freighter is missing", () => {
    const info = detectFreighterApi(undefined);
    expect(info.installed).toBe(false);
    expect(info.isCompatible).toBe(false);
    expect(info.isOutdated).toBe(false);
    expect(info.availableMethods).toEqual([]);
    expect(info.missingMethods).toEqual([...REQUIRED_METHODS]);
    expect(info.issue).toMatch(/not detected/i);
    expect(info.upgradeUrl).toMatch(/freighter\.app/);
  });

  test("returns installed=false when window.freighter is not an object", () => {
    const info = detectFreighterApi("not-an-object");
    expect(info.installed).toBe(false);
    expect(info.issue).toMatch(/not detected/i);
  });

  test("returns installed=true when window.freighter is present", () => {
    const stub = makeCompatibleFreighter();
    const info = detectFreighterApi(stub);
    expect(info.installed).toBe(true);
    expect(info.isCompatible).toBe(true);
    expect(info.isOutdated).toBe(false);
    expect(info.issue).toBeNull();
    expect(info.availableMethods).toEqual([...REQUIRED_METHODS]);
    expect(info.missingMethods).toEqual([]);
  });
});

// ── 5. detectFreighterApi — missing methods ────────────────────────

describe("detectFreighterApi (missing methods)", () => {
  test("marks isCompatible=false when a required method is missing", () => {
    const stub = makeOutdatedFreighter(["signTransaction"]);
    const info = detectFreighterApi(stub);
    expect(info.installed).toBe(true);
    expect(info.isCompatible).toBe(false);
    expect(info.isOutdated).toBe(true);
    expect(info.issue).toMatch(/signTransaction/);
    expect(info.issue).toMatch(/update/i);
    expect(info.missingMethods).toEqual(["signTransaction"]);
  });

  test("lists all missing methods in the issue message", () => {
    const stub = makeOutdatedFreighter([
      "getPublicKey",
      "signTransaction",
    ]);
    const info = detectFreighterApi(stub);
    expect(info.issue).toMatch(/getPublicKey/);
    expect(info.issue).toMatch(/signTransaction/);
    expect(info.missingMethods).toEqual([
      "getPublicKey",
      "signTransaction",
    ]);
  });

  test("uses singular grammar when only one method is missing", () => {
    const stub = makeOutdatedFreighter(["disconnect"]);
    const info = detectFreighterApi(stub);
    expect(info.issue).toMatch(/method: disconnect/);
  });

  test("treats non-function descriptors as missing", () => {
    const stub: Record<string, unknown> = {
      getPublicKey: jest.fn(),
      // signTransaction is present but not a function
      signTransaction: { foo: "bar" },
      isConnected: jest.fn(),
      disconnect: jest.fn(),
    };
    const info = detectFreighterApi(stub);
    expect(info.missingMethods).toContain("signTransaction");
  });
});

// ── 6. detectFreighterApi — version check ──────────────────────────

describe("detectFreighterApi (version check)", () => {
  test("accepts strapiVersion-style object via getApiVersion()", () => {
    const stub: Record<string, unknown> = {};
    for (const m of REQUIRED_METHODS) stub[m] = jest.fn();
    stub.getApiVersion = jest.fn().mockReturnValue({ version: "2.5.0" });
    const info = detectFreighterApi(stub);
    expect(info.version).toEqual([2, 5, 0]);
    expect(info.versionString).toBe("2.5.0");
    expect(info.isCompatible).toBe(true);
  });

  test("accepts raw string from getApiVersion()", () => {
    const stub: Record<string, unknown> = {};
    for (const m of REQUIRED_METHODS) stub[m] = jest.fn();
    stub.getApiVersion = jest.fn().mockReturnValue("3.1.4");
    const info = detectFreighterApi(stub);
    expect(info.version).toEqual([3, 1, 4]);
    expect(info.versionString).toBe("3.1.4");
    expect(info.isCompatible).toBe(true);
  });

  test("marks isCompatible=false when version is below the minimum", () => {
    const stub: Record<string, unknown> = {};
    for (const m of REQUIRED_METHODS) stub[m] = jest.fn();
    stub.getApiVersion = jest.fn().mockReturnValue("1.5.0");
    const info = detectFreighterApi(stub);
    expect(info.isCompatible).toBe(false);
    expect(info.isOutdated).toBe(true);
    expect(info.issue).toMatch(/1\.5\.0/);
    expect(info.issue).toMatch(/2\.0\.0/);
    expect(info.issue).toMatch(/update/i);
  });

  test("treats missing getApiVersion as version unknown (no error)", () => {
    const stub = makeCompatibleFreighter();
    const info = detectFreighterApi(stub);
    expect(info.version).toBeNull();
    expect(info.versionString).toBeNull();
    expect(info.isCompatible).toBe(true);
  });

  test("treats getApiVersion throw as version unknown (no error)", () => {
    const stub = makeCompatibleFreighter();
    stub.getApiVersion = jest.fn(() => {
      throw new Error("nope");
    });
    const info = detectFreighterApi(stub);
    expect(info.version).toBeNull();
    expect(info.isCompatible).toBe(true);
  });
});

// ── 7. getFreighterApiInfo fallback ─────────────────────────────────

describe("getFreighterApiInfo", () => {
  test("probes window.freighter when called without a global", () => {
    // Window.freighter isn't set in jest env
    const info = getFreighterApiInfo();
    expect(info.installed).toBe(false);
  });
});

// ── 8. Error classes ────────────────────────────────────────────────

describe("FreighterOutdatedError", () => {
  test("stores info and uses it as the message", () => {
    const info = detectFreighterApi(makeOutdatedFreighter(["signTransaction"]));
    const err = new FreighterOutdatedError(info);
    expect(err.name).toBe("FreighterOutdatedError");
    expect(err.info).toBe(info);
    expect(err.message).toBe(info.issue);
    expect(err instanceof Error).toBe(true);
  });

  test("falls back to a generic message when info.issue is null", () => {
    const info = { ...detectFreighterApi(undefined), issue: null };
    const err = new FreighterOutdatedError(info);
    expect(err.message).toMatch(/not compatible/i);
  });
});

describe("FreighterNotInstalledError", () => {
  test("stores info and uses it as the message", () => {
    const info = detectFreighterApi(undefined);
    const err = new FreighterNotInstalledError(info);
    expect(err.name).toBe("FreighterNotInstalledError");
    expect(err.info).toBe(info);
    expect(err.message).toBe(info.issue);
    expect(err.message).toMatch(/not detected/i);
  });
});

// ── 9. callFreighter ────────────────────────────────────────────────

describe("callFreighter", () => {
  test("calls the method and returns its result when compatible", async () => {
    const signature = jest.fn().mockResolvedValue("signedXdr");
    const stub: Record<string, unknown> = {};
    for (const m of REQUIRED_METHODS) {
      if (m === "signTransaction") {
        stub[m] = signature;
      } else {
        stub[m] = jest.fn().mockResolvedValue("ok");
      }
    }
    const result = await callFreighter<string>(
      "signTransaction",
      stub,
      "xdr",
      { networkPassphrase: "PUBLIC" },
    );
    expect(result).toBe("signedXdr");
    expect(signature).toHaveBeenCalledWith("xdr", {
      networkPassphrase: "PUBLIC",
    });
  });

  test("throws FreighterNotInstalledError when global is missing", async () => {
    await expect(callFreighter("getPublicKey", undefined)).rejects.toBeInstanceOf(
      FreighterNotInstalledError,
    );
  });

  test("throws FreighterOutdatedError when method is missing", async () => {
    const stub = makeOutdatedFreighter(["getPublicKey"]);
    await expect(callFreighter("getPublicKey", stub)).rejects.toBeInstanceOf(
      FreighterOutdatedError,
    );
  });

  test("throws FreighterOutdatedError when version is too old", async () => {
    const stub: Record<string, unknown> = {};
    for (const m of REQUIRED_METHODS) stub[m] = jest.fn();
    stub.getApiVersion = jest.fn().mockReturnValue("1.0.0");
    await expect(callFreighter("getPublicKey", stub)).rejects.toBeInstanceOf(
      FreighterOutdatedError,
    );
  });

  test("re-throws Method-not-a-function runtime errors as FreighterOutdatedError", async () => {
    const stub = makeCompatibleFreighter();
    // Simulate Freighter removing the method mid-call
    stub.signTransaction = jest.fn().mockImplementation(() => {
      throw new TypeError("freighter.signTransaction is not a function");
    });
    await expect(callFreighter("signTransaction", stub)).rejects.toBeInstanceOf(
      FreighterOutdatedError,
    );
  });

  test("re-throws non-typed errors verbatim", async () => {
    const stub = makeCompatibleFreighter();
    stub.signTransaction = jest
      .fn()
      .mockRejectedValue(new Error("User rejected"));
    await expect(callFreighter("signTransaction", stub)).rejects.toThrow(
      "User rejected",
    );
  });
});

// ── 10. formatFreighterError ────────────────────────────────────────

describe("formatFreighterError", () => {
  test("formats FreighterOutdatedError with upgradeUrl", () => {
    const info = detectFreighterApi(makeOutdatedFreighter(["signTransaction"]));
    const err = new FreighterOutdatedError(info);
    const f = formatFreighterError(err);
    expect(f.isOutdated).toBe(true);
    expect(f.isNotInstalled).toBe(false);
    expect(f.message).toBe(info.issue);
    expect(f.upgradeUrl).toMatch(/freighter\.app/);
  });

  test("formats FreighterNotInstalledError with upgradeUrl", () => {
    const info = detectFreighterApi(undefined);
    const err = new FreighterNotInstalledError(info);
    const f = formatFreighterError(err);
    expect(f.isNotInstalled).toBe(true);
    expect(f.isOutdated).toBe(false);
    expect(f.message).toMatch(/not detected/i);
  });

  test("formats plain Error verbatim", () => {
    const f = formatFreighterError(new Error("User rejected"));
    expect(f.isOutdated).toBe(false);
    expect(f.isNotInstalled).toBe(false);
    expect(f.message).toBe("User rejected");
    expect(f.upgradeUrl).toMatch(/freighter\.app/);
  });

  test("formats unknown values", () => {
    const f = formatFreighterError("nope");
    expect(f.message).toBe("Unknown Freighter error");
  });

  test("formats Error with empty message", () => {
    const f = formatFreighterError(new Error(""));
    expect(f.message).toBe("Unknown Freighter error");
  });
});

// ── 11. assertFreighterApiReady ─────────────────────────────────────

describe("assertFreighterApiReady", () => {
  test("throws FreighterNotInstalledError when window.freighter is missing", () => {
    expect(() => assertFreighterApiReady()).toThrow(
      FreighterNotInstalledError,
    );
  });
});
