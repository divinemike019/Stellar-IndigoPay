import React from "react";
import { Text, Pressable, View } from "react-native";
import { render, act, waitFor, fireEvent } from "@testing-library/react-native";
import * as LocalAuthentication from "expo-local-authentication";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useBiometricAuth } from "../hooks/useBiometricAuth";

jest.setTimeout(20000);

const LA = LocalAuthentication as unknown as {
  hasHardwareAsync: jest.Mock;
  isEnrolledAsync: jest.Mock;
  authenticateAsync: jest.Mock;
  supportedAuthenticationTypesAsync: jest.Mock;
};

// We mock AsyncStorage with a simple in-memory mock if the package mock isn't loaded
jest.mock("@react-native-async-storage/async-storage", () => {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn(async (key: string) => store[key] || null),
    setItem: jest.fn(async (key: string, value: string) => {
      store[key] = String(value);
    }),
    clear: jest.fn(async () => {
      store = {};
    }),
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  (AsyncStorage.getItem as jest.Mock).mockClear();
  (AsyncStorage.setItem as jest.Mock).mockClear();
  LA.hasHardwareAsync.mockResolvedValue(true);
  LA.isEnrolledAsync.mockResolvedValue(true);
  LA.supportedAuthenticationTypesAsync.mockResolvedValue([
    LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION,
  ]);
  LA.authenticateAsync.mockResolvedValue({ success: true });
});

describe("useBiometricAuth (enhanced hook)", () => {
  function TestComponent({ amount }: { amount: number }) {
    const {
      isAvailable,
      biometricsUnavailable,
      biometricType,
      threshold,
      isEnabled,
      isAuthenticating,
      confirmDonation,
      setBiometricThreshold,
      setIsEnabled,
    } = useBiometricAuth();

    const status = [
      `isAvailable=${isAvailable}`,
      `biometricsUnavailable=${biometricsUnavailable}`,
      `biometricType=${biometricType}`,
      `threshold=${threshold}`,
      `isEnabled=${isEnabled}`,
      `isAuthenticating=${isAuthenticating}`,
    ].join("|");

    return (
      <View>
        <Text testID="status">{status}</Text>
        <Pressable
          testID="confirm-btn"
          onPress={() => confirmDonation(amount)}
        >
          <Text>Confirm</Text>
        </Pressable>
        <Pressable
          testID="set-threshold-btn"
          onPress={() => setBiometricThreshold(10)}
        >
          <Text>Set Threshold</Text>
        </Pressable>
        <Pressable
          testID="set-enabled-btn"
          onPress={() => setIsEnabled(false)}
        >
          <Text>Disable</Text>
        </Pressable>
      </View>
    );
  }

  // Helper component for tests that need to inspect the structured
  // return value of `confirmDonation` rather than just side effects.
  function ConfirmResultComponent({
    amount,
    testID = "confirm-result",
  }: {
    amount: number;
    testID?: string;
  }) {
    const { confirmDonation } = useBiometricAuth();
    const [json, setJson] = React.useState("idle");
    return (
      <View>
        <Text testID="confirm-status">{json === "idle" ? "idle" : "done"}</Text>
        <Text testID={testID}>{json}</Text>
        <Pressable
          testID="confirm-result-btn"
          onPress={async () => {
            const r = await confirmDonation(amount);
            setJson(JSON.stringify(r));
          }}
        >
          <Text>Run</Text>
        </Pressable>
      </View>
    );
  }

  it("probes the device and loads default preferences", async () => {
    const { getByTestId } = render(<TestComponent amount={100} />);

    await waitFor(() => {
      const status = getByTestId("status").props.children;
      expect(status).toMatch(/isAvailable=true/);
      expect(status).toMatch(/biometricsUnavailable=false/);
      expect(status).toMatch(/biometricType=Face ID/);
      expect(status).toMatch(/threshold=50/);
      expect(status).toMatch(/isEnabled=true/);
    });
  });

  it("skips authentication when amount is not a finite number", async () => {
    LA.authenticateAsync.mockResolvedValue({ success: true });
    const { getByTestId } = render(<ConfirmResultComponent amount={NaN} />);

    await act(async () => {
      fireEvent.press(getByTestId("confirm-result-btn"));
    });

    await waitFor(() => {
      const result = getByTestId("confirm-result").props.children;
      expect(result).toMatch(/"success":true/);
    });
    // NaN must NOT trigger the OS prompt.
    expect(LA.authenticateAsync).not.toHaveBeenCalled();
  });

  it("skips authentication when amount is below threshold", async () => {
    const { getByTestId } = render(<TestComponent amount={20} />);
    await waitFor(() => {
      expect(getByTestId("status").props.children).toMatch(/isAvailable=true/);
    });

    await act(async () => {
      fireEvent.press(getByTestId("confirm-btn"));
    });

    expect(LA.authenticateAsync).not.toHaveBeenCalled();
  });

  it("exposes biometricsUnavailable=true when no biometric hardware can be probed", async () => {
    LA.hasHardwareAsync.mockResolvedValue(false);
    LA.isEnrolledAsync.mockResolvedValue(false);
    LA.supportedAuthenticationTypesAsync.mockResolvedValue([]);

    const { getByTestId } = render(<TestComponent amount={100} />);
    await waitFor(() => {
      const status = getByTestId("status").props.children;
      expect(status).toMatch(/isAvailable=false/);
      expect(status).toMatch(/biometricsUnavailable=true/);
      expect(status).toMatch(/biometricType=null/);
    });
  });

  it("falls back to device passcode (disablesDeviceFallback:false) when no biometric hardware is present", async () => {
    LA.hasHardwareAsync.mockResolvedValue(false);
    LA.isEnrolledAsync.mockResolvedValue(false);
    LA.supportedAuthenticationTypesAsync.mockResolvedValue([]);

    const { getByTestId } = render(<TestComponent amount={100} />);
    await waitFor(() => {
      expect(getByTestId("status").props.children).toMatch(/isAvailable=false/);
    });

    await act(async () => {
      fireEvent.press(getByTestId("confirm-btn"));
    });

    // authenticateAsync MUST be called so the OS can drop into the
    // device passcode prompt. disableDeviceFallback explicitly set to
    // false so the test pin-points the documented behavior.
    expect(LA.authenticateAsync).toHaveBeenCalledTimes(1);
    const callArg = LA.authenticateAsync.mock.calls[0][0];
    expect(callArg.disableDeviceFallback).toBe(false);
  });

  it("returns success:true with biometricsUnavailable flag when device has neither biometric nor passcode", async () => {
    LA.hasHardwareAsync.mockResolvedValue(false);
    LA.supportedAuthenticationTypesAsync.mockResolvedValue([]);
    LA.authenticateAsync.mockResolvedValue({
      success: false,
      error: "no_enrolled_credentials",
    });

    const { getByTestId } = render(<ConfirmResultComponent amount={100} />);
    await act(async () => {
      fireEvent.press(getByTestId("confirm-result-btn"));
    });

    await waitFor(() => {
      const result = getByTestId("confirm-result").props.children;
      expect(result).toMatch(/"success":true/);
      expect(result).toMatch(/"biometricsUnavailable":true/);
    });
  });

  it("treats each documented unavailability error code the same way", async () => {
    const codes = [
      "authentication_unavailable",
      "invalid_authentication_type",
      "no_enrolled_credentials",
      "passcode_not_set",
    ];
    for (const code of codes) {
      // Only re-patch the mock we're actually testing; leave
      // hasHardwareAsync / isEnrolledAsync / supportedAuthenticationTypesAsync
      // alone so this test stays robust to future changes in the
      // availability probing flow.
      LA.authenticateAsync.mockResolvedValue({ success: false, error: code });
      LA.authenticateAsync.mockClear();
      const { getByTestId, unmount } = render(
        <ConfirmResultComponent amount={100} />
      );
      await act(async () => {
        fireEvent.press(getByTestId("confirm-result-btn"));
      });
      await waitFor(() => {
        const result = getByTestId("confirm-result").props.children;
        expect(result).toMatch(/"success":true/);
        expect(result).toMatch(/"biometricsUnavailable":true/);
      });
      unmount();
    }
  });

  it("still rejects user cancellation as a hard failure", async () => {
    LA.authenticateAsync.mockResolvedValue({
      success: false,
      error: "user_cancel",
    });

    const { getByTestId } = render(<ConfirmResultComponent amount={100} />);
    await act(async () => {
      fireEvent.press(getByTestId("confirm-result-btn"));
    });

    await waitFor(() => {
      const result = getByTestId("confirm-result").props.children;
      expect(result).toMatch(/"success":false/);
      expect(result).toMatch(/"error":"user_cancel"/);
      expect(result).not.toMatch(/"biometricsUnavailable":true/);
    });
  });

  it("triggers authentication when amount is above or equal to threshold", async () => {
    const { getByTestId } = render(<TestComponent amount={100} />);
    await waitFor(() => {
      expect(getByTestId("status").props.children).toMatch(/isAvailable=true/);
    });

    await act(async () => {
      fireEvent.press(getByTestId("confirm-btn"));
    });

    expect(LA.authenticateAsync).toHaveBeenCalled();
  });

  it("saves preferences to AsyncStorage when updating settings", async () => {
    const { getByTestId } = render(<TestComponent amount={100} />);
    await waitFor(() => {
      expect(getByTestId("status").props.children).toMatch(/threshold=50/);
    });

    await act(async () => {
      fireEvent.press(getByTestId("set-threshold-btn"));
    });

    await waitFor(() => {
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        "@indigopay:biometric_threshold",
        "10"
      );
    });

    await act(async () => {
      fireEvent.press(getByTestId("set-enabled-btn"));
    });

    await waitFor(() => {
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        "@indigopay:biometric_enabled",
        "false"
      );
    });
  });
});
