export interface ExtensionSettings {
  backendUrl: string;
  network: "testnet" | "mainnet";
  defaultDonationAmount: string;
}

import {
  detectFreighterApi,
  FreighterNotInstalledError,
  FreighterOutdatedError,
  formatFreighterError,
} from "./freighter-compat";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  backendUrl: "https://api.stellar-indigopay.app",
  network: "testnet",
  defaultDonationAmount: "5",
};

export function loadSettings(): Promise<ExtensionSettings> {
  return new Promise((resolve) => {
    const keys = Object.keys(DEFAULT_SETTINGS) as Array<keyof ExtensionSettings>;
    chrome.storage.sync.get(keys, (items: { [key: string]: unknown }) => {
      resolve(items as unknown as ExtensionSettings);
    });
  });
}

export function saveSettings(settings: ExtensionSettings): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(settings, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

// --- Wallet helpers ---

function truncateAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Show a Freighter compatibility upgrade prompt in the settings UI.
 * ↪ #046 / GrantFox OSS — converts cryptic "is not a function" errors
 *   into actionable upgrade instructions.
 */
function showWalletUpdateBanner(message: string, upgradeUrl: string): void {
  const banner = document.getElementById("wallet-update-banner");
  if (!banner) return;
  banner.innerHTML = `
    <div class="banner-content">
      <strong>⚠️ Freighter update required</strong>
      <p>${escapeHtml(message)}</p>
      <a href="${escapeHtml(upgradeUrl)}" target="_blank" rel="noopener noreferrer"
         class="banner-cta">Update Freighter →</a>
    </div>
  `;
  banner.classList.remove("hidden");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Get the connected wallet public key. Returns null if Freighter is not
 * installed, is too old to expose getPublicKey, or the user has not yet
 * authorized the extension.
 *
 * Pre-flight compatibility check via detectFreighterApi() avoids surfacing
 * a "TypeError: freighter.getPublicKey is not a function" — instead we
 * render an upgrade prompt (#046).
 */
async function getWalletPublicKey(): Promise<string | null> {
  const compat = detectFreighterApi();
  if (!compat.isCompatible || !compat.installed) {
    if (!compat.isCompatible && compat.isOutdated && compat.issue) {
      showWalletUpdateBanner(compat.issue, compat.upgradeUrl);
    }
    return null;
  }
  try {
    const fn = (window as any).freighter.getPublicKey;
    if (typeof fn !== "function") return null;
    return (await fn.call((window as any).freighter)) as string;
  } catch (err) {
    if (
      err instanceof FreighterOutdatedError ||
      err instanceof FreighterNotInstalledError
    ) {
      const f = formatFreighterError(err);
      showWalletUpdateBanner(f.message, f.upgradeUrl);
    }
    return null;
  }
}

/**
 * Check whether Freighter currently has this extension authorized.
 *
 * Surfaces an upgrade prompt if Freighter is installed but isConnected()
 * is missing from the API surface — this is the symptom of an outdated
 * Freighter that no longer exposes the legacy connection check.
 */
async function isFreighterConnected(): Promise<boolean> {
  const compat = detectFreighterApi();
  if (!compat.isCompatible || !compat.installed) {
    if (!compat.isCompatible && compat.isOutdated && compat.issue) {
      showWalletUpdateBanner(compat.issue, compat.upgradeUrl);
    }
    return false;
  }
  try {
    const fn = (window as any).freighter.isConnected;
    if (typeof fn !== "function") return false;
    const result = await fn.call((window as any).freighter);
    return result === true || result?.isConnected === true;
  } catch (err) {
    if (
      err instanceof FreighterOutdatedError ||
      err instanceof FreighterNotInstalledError
    ) {
      const f = formatFreighterError(err);
      showWalletUpdateBanner(f.message, f.upgradeUrl);
    }
    return false;
  }
}

async function freighterDisconnect(): Promise<void> {
  const compat = detectFreighterApi();
  if (!compat.isCompatible || !compat.installed) {
    if (!compat.isCompatible && compat.isOutdated && compat.issue) {
      showWalletUpdateBanner(compat.issue, compat.upgradeUrl);
    }
    return;
  }
  const freighter = (window as any).freighter;
  if (freighter && typeof freighter.disconnect === "function") {
    try {
      await freighter.disconnect();
    } catch (err) {
      if (
        err instanceof FreighterOutdatedError ||
        err instanceof FreighterNotInstalledError
      ) {
        const f = formatFreighterError(err);
        showWalletUpdateBanner(f.message, f.upgradeUrl);
      }
      // Silently ignore other errors
    }
  }
}

// --- Settings page UI ---

document.addEventListener("DOMContentLoaded", async () => {
  const backBtn = document.getElementById("back-btn") as HTMLButtonElement;
  const form = document.getElementById("settings-form") as HTMLFormElement;
  const urlInput = document.getElementById("backend-url") as HTMLInputElement;
  const urlError = document.getElementById("url-error") as HTMLSpanElement;
  const amountInput = document.getElementById(
    "default-amount",
  ) as HTMLInputElement;
  const btnTestnet = document.getElementById(
    "btn-testnet",
  ) as HTMLButtonElement;
  const btnMainnet = document.getElementById(
    "btn-mainnet",
  ) as HTMLButtonElement;
  const mainnetWarning = document.getElementById(
    "mainnet-warning",
  ) as HTMLSpanElement;
  const saveStatus = document.getElementById("save-status") as HTMLDivElement;
  const walletAddressText = document.getElementById(
    "wallet-address-text",
  ) as HTMLSpanElement;
  const walletDot = document.getElementById("wallet-dot") as HTMLSpanElement;
  const walletActionBtn = document.getElementById(
    "wallet-action-btn",
  ) as HTMLButtonElement;

  let selectedNetwork: "testnet" | "mainnet" = "testnet";
  let walletConnected = false;

  function setActiveNetwork(network: "testnet" | "mainnet") {
    selectedNetwork = network;
    btnTestnet.classList.toggle("network-btn-active", network === "testnet");
    btnMainnet.classList.toggle("network-btn-active", network === "mainnet");
    mainnetWarning.classList.toggle("hidden", network !== "mainnet");
  }

  function updateWalletUI(connected: boolean, publicKey: string | null = null) {
    walletConnected = connected;
    if (connected && publicKey) {
      walletAddressText.textContent = truncateAddress(publicKey);
      walletDot.className = "dot online";
      walletActionBtn.textContent = "Disconnect";
    } else {
      walletAddressText.textContent = "Not connected";
      walletDot.className = "dot";
      walletActionBtn.textContent = "Connect Wallet";
    }
  }

  // Load saved settings
  const settings = await loadSettings();
  urlInput.value = settings.backendUrl;
  amountInput.value = settings.defaultDonationAmount;
  setActiveNetwork(settings.network);

  // Check wallet connection
  const connected = await isFreighterConnected();
  if (connected) {
    const publicKey = await getWalletPublicKey();
    updateWalletUI(true, publicKey);
  } else {
    updateWalletUI(false);
  }

  backBtn.addEventListener("click", () => {
    window.location.href = "popup.html";
  });

  btnTestnet.addEventListener("click", () => setActiveNetwork("testnet"));
  btnMainnet.addEventListener("click", () => setActiveNetwork("mainnet"));

  walletActionBtn.addEventListener("click", async () => {
    if (walletConnected) {
      await freighterDisconnect();
      updateWalletUI(false);
    } else {
      const publicKey = await getWalletPublicKey();
      if (publicKey) {
        updateWalletUI(true, publicKey);
      }
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    urlError.classList.add("hidden");
    saveStatus.textContent = "";
    saveStatus.className = "status-message";

    const rawUrl = urlInput.value.trim();
    try {
      new URL(rawUrl);
    } catch {
      urlError.classList.remove("hidden");
      return;
    }

    const defaultAmount = amountInput.value.trim();
    const amount =
      defaultAmount && parseFloat(defaultAmount) > 0 ? defaultAmount : "5";

    try {
      await saveSettings({
        backendUrl: rawUrl,
        network: selectedNetwork,
        defaultDonationAmount: amount,
      });
      saveStatus.textContent = "Settings saved.";
      saveStatus.classList.add("success");
    } catch (err: any) {
      saveStatus.textContent = `Failed to save: ${err.message}`;
      saveStatus.classList.add("error");
    }
  });
});
