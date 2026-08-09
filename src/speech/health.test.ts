import { describe, expect, it } from "vitest";
import { categorizeSynthError, HEALTH_WINDOW_MS, synthHealthOf } from "./health";

describe("categorizeSynthError", () => {
  it("maps auth failures to key rejected with the provider named", () => {
    const r = categorizeSynthError("all-providers-failed: elevenlabs auth 401 Unauthorized");
    expect(r).toEqual({ reason: "key rejected", provider: "elevenlabs" });
  });

  it("maps 429 to rate limited", () => {
    const r = categorizeSynthError(
      'all-providers-failed: elevenlabs 429: {"detail":{"status":"too_many_concurrent_requests"}}'
    );
    expect(r.reason).toBe("rate limited");
    expect(r.provider).toBe("elevenlabs");
  });

  it("quota beats status code — a 401 quota body reads as out of credits", () => {
    const r = categorizeSynthError(
      'all-providers-failed: elevenlabs 401: {"detail":{"status":"quota_exceeded"}}'
    );
    expect(r.reason).toBe("out of credits");
  });

  it("maps reqwest network errors", () => {
    const r = categorizeSynthError("all-providers-failed: mistral network: connection reset");
    expect(r).toEqual({ reason: "network error", provider: "mistral" });
  });

  it("maps missing keys", () => {
    expect(categorizeSynthError("all-providers-failed: no provider configured").reason).toBe(
      "no API key"
    );
  });

  it("falls back to provider error for the unclassifiable", () => {
    const r = categorizeSynthError("all-providers-failed: mistral 500: internal");
    expect(r).toEqual({ reason: "provider error", provider: "mistral" });
  });

  it("names piper for its local synthesis errors", () => {
    const r = categorizeSynthError("all-providers-failed: piper tts: load en_GB-alba-medium: …");
    expect(r).toEqual({ reason: "provider error", provider: "piper" });
  });

  it("names the on-device provider for windows tts errors", () => {
    const r = categorizeSynthError("all-providers-failed: windows tts: init: 0x80004005");
    expect(r).toEqual({ reason: "provider error", provider: "windows" });
  });
});

describe("synthHealthOf", () => {
  it("is ok with no error", () => {
    expect(synthHealthOf(null, 0)).toEqual({ state: "ok" });
  });

  it("is degraded while the error is fresh", () => {
    const now = 1_000_000;
    const h = synthHealthOf("elevenlabs auth 401", now - 5_000, now);
    expect(h.state).toBe("degraded");
    expect(h.reason).toBe("key rejected");
  });

  it("goes stale after the window — the queue has moved on", () => {
    const now = 1_000_000;
    expect(synthHealthOf("elevenlabs auth 401", now - HEALTH_WINDOW_MS - 1, now)).toEqual({
      state: "ok",
    });
  });
});
