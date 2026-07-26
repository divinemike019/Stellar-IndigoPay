/**
 * hooks/useBiometricAuth.ts
 *
 * Enhanced biometric (Face ID / fingerprint) authentication hook with
 * threshold checking, preference storage via AsyncStorage, and a
 * graceful fallback to the OS-level device passcode when the device
 * has no biometric sensor (issue #047).
 *
 * Fallback contract:
 *   1. If biometric hardware is present AND enrolled AND the user has
 *      enabled biometric confirmation above the configured threshold,
 *      we attempt a biometric prompt via expo-local-authentication.
 *   2. If the device has NO biometric hardware (e.g. budget Android,
 *      CI emulators), we still ask expo-local-authentication to
 *      authenticate — `disableDeviceFallback: false` lets the OS drop
 *      straight to the device passcode/PIN prompt, which is the same
 *      surface we already use elsewhere in the app (AuthProvider /
 *      secureStore).
 *   3. If neither biometric nor device credential is available, the
 *      hook returns `success: true` with `biometricsUnavailable: true`
 *      so callers can either proceed without confirmation or surface a
 *      graceful informational message in the UI.
 */
import { useState, useEffect } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BIOMETRIC_THRESHOLD_KEY = '@indigopay:biometric_threshold';
const BIOMETRIC_ENABLED_KEY = '@indigopay:biometric_enabled';
const DEFAULT_THRESHOLD_XLM = 50;

// expo-local-authentication error codes that indicate the device has
// neither biometric hardware nor a device credential configured. When
// `authenticateAsync` returns one of these we let the caller proceed
// without an OS-handled confirmation step, but surface a
// `biometricsUnavailable: true` flag so consumers can show a graceful
// message and surface the situation in analytics / telemetry.
const UNAVAILABILITY_ERROR_CODES: ReadonlySet<string> = new Set([
  'authentication_unavailable',
  'invalid_authentication_type',
  'no_enrolled_credentials',
  'passcode_not_set',
]);

export interface ConfirmDonationResult {
  success: boolean;
  error?: string;
  /**
   * True when the device has no biometric sensor AND no device
   * passcode configured. In that case the hook proceeded without
   * any OS-handled confirmation step. Callers can surface a graceful
   * banner ("device authentication unavailable") instead of blocking
   * the user outright.
   */
  biometricsUnavailable?: boolean;
}

export interface BiometricAuthApi {
  /** True only when biometric hardware + enrollment are both present. */
  isAvailable: boolean;
  /** True only when biometric *or* device credential is fully absent. */
  biometricsUnavailable: boolean;
  /** Human-readable type name ("Face ID" / "Touch ID" / "Biometric"). */
  biometricType: string | null;
  /** Threshold (XLM) above which confirmation is required. */
  threshold: number;
  /** Whether the user has biometric confirmation toggled on. */
  isEnabled: boolean;
  /** True while an OS prompt is on screen. */
  isAuthenticating: boolean;
  /**
   * Ask the user (via biometric OR device passcode) to confirm a
   * transaction of `amount` XLM. Resolves with `success: true` when
   * either the user authenticates successfully or no confirmation is
   * required (below threshold, toggle off, or no auth available at
   * all). Resolves with `success: false` only on an explicit failure
   * the user cannot recover from (cancel, lockout, etc).
   */
  confirmDonation: (amount: number) => Promise<ConfirmDonationResult>;
  setBiometricThreshold: (xlm: number) => Promise<void>;
  setIsEnabled: (enabled: boolean) => Promise<void>;
}

export function useBiometricAuth(): BiometricAuthApi {
  const [isAvailable, setIsAvailable] = useState(false);
  const [biometricsUnavailable, setBiometricsUnavailable] = useState(true);
  const [biometricType, setBiometricType] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD_XLM);
  const [isEnabled, setIsEnabled] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  useEffect(() => {
    checkAvailability();
    loadPreferences();
  }, []);

  async function checkAvailability() {
    try {
      const hardware = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
      const hasBiometric =
        hardware && enrolled && Array.isArray(types) && types.length > 0;

      setIsAvailable(hasBiometric);
      setBiometricsUnavailable(!hasBiometric);

      if (hasBiometric) {
        setBiometricType(
          types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)
            ? 'Face ID'
            : types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)
            ? 'Touch ID'
            : 'Biometric'
        );
      } else {
        setBiometricType(null);
      }
    } catch (err) {
      // Conservative default: assume nothing works so callers do not
      // quietly bypass authentication on hardware we cannot probe.
      if (__DEV__) console.warn('[useBiometricAuth] check failed', err);
      setIsAvailable(false);
      setBiometricsUnavailable(true);
      setBiometricType(null);
    }
  }

  async function loadPreferences() {
    try {
      const stored = await AsyncStorage.getItem(BIOMETRIC_THRESHOLD_KEY);
      if (stored) setThreshold(Number(stored));
      const enabled = await AsyncStorage.getItem(BIOMETRIC_ENABLED_KEY);
      if (enabled !== null) setIsEnabled(enabled === 'true');
    } catch (err) {
      console.error('Error loading biometric preferences:', err);
    }
  }

  async function confirmDonation(
    amount: number
  ): Promise<ConfirmDonationResult> {
    // No confirmation required by the user's preferences. Also guard
    // against NaN / non-finite amounts so we never invoke the OS prompt
    // with a bogus "Confirm donation of NaN XLM" message — the donate
    // screen validates upstream but the hook is exported and may be
    // called from anywhere.
    if (
      !isEnabled ||
      !Number.isFinite(amount) ||
      amount < threshold
    ) {
      return { success: true };
    }

    setIsAuthenticating(true);
    try {
      // `disableDeviceFallback: false` (the default, made explicit here
      // for documentation) lets expo-local-authentication automatically
      // fall back to the device passcode/PIN prompt when no biometric
      // is enrolled. On iOS, the equivalent is the
      // LAPolicyDeviceOwnerAuthentication path which also surfaces a
      // passcode prompt by default.
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: `Confirm donation of ${amount} XLM`,
        fallbackLabel: 'Use device passcode',
        cancelLabel: 'Cancel donation',
        disableDeviceFallback: false,
      });

      if (result.success) {
        return { success: true };
      }

      // Distinguish "device just can't do auth" from "user actively
      // rejected / failed" so callers can decide whether to let the
      // action proceed without confirmation (the former) or block it
      // (the latter).
      const errCode = (result as any).error as string | undefined;
      if (errCode && UNAVAILABILITY_ERROR_CODES.has(errCode)) {
        setBiometricsUnavailable(true);
        return { success: true, biometricsUnavailable: true };
      }

      return { success: false, error: errCode };
    } catch (err) {
      return { success: false, error: 'Biometric authentication failed' };
    } finally {
      setIsAuthenticating(false);
    }
  }

  async function setBiometricThreshold(newThreshold: number) {
    setThreshold(newThreshold);
    try {
      await AsyncStorage.setItem(BIOMETRIC_THRESHOLD_KEY, String(newThreshold));
    } catch (err) {
      console.error('Error saving biometric threshold:', err);
    }
  }

  async function updateIsEnabled(value: boolean) {
    setIsEnabled(value);
    try {
      await AsyncStorage.setItem(BIOMETRIC_ENABLED_KEY, String(value));
    } catch (err) {
      console.error('Error saving biometric enabled status:', err);
    }
  }

  return {
    isAvailable,
    biometricsUnavailable,
    biometricType,
    threshold,
    isEnabled,
    isAuthenticating,
    confirmDonation,
    setBiometricThreshold,
    setIsEnabled: updateIsEnabled,
  };
}

/**
 * Standalone authenticate helper exported for non-hook consumers
 * (e.g. secureStore.ts, AuthProvider.unlock) that can't call the
 * React hook directly.
 *
 * Returns `false` on cancellation, lockout, or when the device exposes
 * neither a biometric sensor nor a device credential. Returning false
 * (rather than auto-succeeding) keeps the secureStore and AuthProvider
 * fail-closed contract intact — callers that need a richer result
 * shape (`{ success, biometricsUnavailable, error }`) should use the
 * `useBiometricAuth` hook directly.
 */
export async function authenticate(reason: string): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      fallbackLabel: 'Use device passcode',
      disableDeviceFallback: false,
    });
    return result.success;
  } catch {
    return false;
  }
}
