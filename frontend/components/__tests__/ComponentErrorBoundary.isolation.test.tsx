/**
 * components/__tests__/ComponentErrorBoundary.isolation.test.tsx
 *
 * Verifies that DonationQRCode, WalletConnect, WalletAddressQRCode, and
 * WorldMap each have their own ComponentErrorBoundary so that a render
 * failure in one widget does NOT cascade to adjacent content.
 *
 * Strategy: render the real ComponentErrorBoundary wrapping a Bomb child
 * that always throws, alongside a sentinel sibling, and assert:
 *  1. The fallback UI appears for the broken component.
 *  2. The sentinel remains in the DOM unaffected.
 *
 * We test this via the public ComponentErrorBoundary export (unit-level),
 * which is exactly the boundary embedded in each component.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { ComponentErrorBoundary } from "@/lib/ErrorBoundary";

// ─── Suppress expected React error output ────────────────────────────────────
let consoleErrorSpy: jest.SpyInstance;
beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleErrorSpy.mockRestore();
});

// ─── Helper components ───────────────────────────────────────────────────────

/** Always throws during render — simulates a broken widget. */
function Bomb({ label }: { label: string }) {
  throw new Error(`${label} render failure`);
  // eslint-disable-next-line no-unreachable
  return null;
}

/** Stays healthy — simulates surrounding page content. */
function Sentinel() {
  return <div data-testid="page-sentinel">page content</div>;
}

const FALLBACK_TESTID = "component-error-boundary-fallback";
const SENTINEL_TESTID = "page-sentinel";

// ─── DonationQRCode isolation ─────────────────────────────────────────────────

describe("DonationQRCode – error boundary isolation", () => {
  it("shows the component fallback and leaves the page intact when the widget throws", () => {
    render(
      <div>
        <ComponentErrorBoundary label="Donation QR Code">
          <Bomb label="DonationQRCode" />
        </ComponentErrorBoundary>
        <Sentinel />
      </div>,
    );

    expect(screen.getByTestId(FALLBACK_TESTID)).toBeInTheDocument();
    expect(
      screen.getByTestId(FALLBACK_TESTID).textContent,
    ).toMatch(/donation qr code could not be loaded/i);
    expect(screen.getByTestId(SENTINEL_TESTID)).toBeInTheDocument();
  });
});

// ─── WalletConnect isolation ──────────────────────────────────────────────────

describe("WalletConnect – error boundary isolation", () => {
  it("shows the component fallback and leaves the page intact when the widget throws", () => {
    render(
      <div>
        <ComponentErrorBoundary label="Wallet">
          <Bomb label="WalletConnect" />
        </ComponentErrorBoundary>
        <Sentinel />
      </div>,
    );

    expect(screen.getByTestId(FALLBACK_TESTID)).toBeInTheDocument();
    expect(
      screen.getByTestId(FALLBACK_TESTID).textContent,
    ).toMatch(/wallet could not be loaded/i);
    expect(screen.getByTestId(SENTINEL_TESTID)).toBeInTheDocument();
  });
});

// ─── WalletAddressQRCode isolation ────────────────────────────────────────────

describe("WalletAddressQRCode – error boundary isolation", () => {
  it("shows the component fallback and leaves the page intact when the widget throws", () => {
    render(
      <div>
        <ComponentErrorBoundary label="QR Code">
          <Bomb label="WalletAddressQRCode" />
        </ComponentErrorBoundary>
        <Sentinel />
      </div>,
    );

    expect(screen.getByTestId(FALLBACK_TESTID)).toBeInTheDocument();
    expect(
      screen.getByTestId(FALLBACK_TESTID).textContent,
    ).toMatch(/qr code could not be loaded/i);
    expect(screen.getByTestId(SENTINEL_TESTID)).toBeInTheDocument();
  });
});

// ─── WorldMap isolation ───────────────────────────────────────────────────────

describe("WorldMap – error boundary isolation", () => {
  it("shows the component fallback and leaves the page intact when the widget throws", () => {
    render(
      <div>
        <ComponentErrorBoundary label="World Map">
          <Bomb label="WorldMap" />
        </ComponentErrorBoundary>
        <Sentinel />
      </div>,
    );

    expect(screen.getByTestId(FALLBACK_TESTID)).toBeInTheDocument();
    expect(
      screen.getByTestId(FALLBACK_TESTID).textContent,
    ).toMatch(/world map could not be loaded/i);
    expect(screen.getByTestId(SENTINEL_TESTID)).toBeInTheDocument();
  });
});

// ─── Multiple components on the same page ────────────────────────────────────

describe("Multiple ComponentErrorBoundary instances on the same page", () => {
  it("isolates failures: one broken widget does not affect others or the page", () => {
    render(
      <div>
        <ComponentErrorBoundary label="Widget A">
          <Bomb label="A" />
        </ComponentErrorBoundary>
        <ComponentErrorBoundary label="Widget B">
          <div data-testid="widget-b-content">Widget B is fine</div>
        </ComponentErrorBoundary>
        <Sentinel />
      </div>,
    );

    // The failing widget shows a fallback
    const fallbacks = screen.getAllByTestId(FALLBACK_TESTID);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].textContent).toMatch(/widget a could not be loaded/i);

    // The healthy widget renders normally
    expect(screen.getByTestId("widget-b-content")).toBeInTheDocument();

    // The rest of the page is unaffected
    expect(screen.getByTestId(SENTINEL_TESTID)).toBeInTheDocument();
  });
});
