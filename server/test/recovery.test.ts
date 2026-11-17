import { describe, expect, it } from "vitest";
import {
  groupRecoveryKey,
  makeRecoveryKey,
  normalizeRecoveryKey,
  RECOVERY_ALPHABET,
  RECOVERY_LENGTH,
  recoveryHash,
} from "../src/family/recovery.js";

describe("the recovery key", () => {
  // Shared with the agent's RecoveryKeyTest: the same salt and key give the same hash there.
  const key = "7KD2M8Q4ZX1HNP3RT6VWB9CF0G";
  const salt = "000102030405060708090a0b0c0d0e0f";
  const hash = "de01d867f9fc4097eae169b9abdf2b2b8092afa3f3e80f38c6fdc08f283a83a1";

  it("matches the agent's test vector", () => {
    expect(recoveryHash(salt, key)).toBe(hash);
  });

  it("forgives case, spaces, dashes and look-alike letters, like the phone", () => {
    expect(normalizeRecoveryKey("7kd2m-8q4zx-1hnp3-rt6vw-b9cf0g")).toBe(key);
    expect(normalizeRecoveryKey(" 7KD2M 8Q4ZX\t1HNP3 RT6VW B9CFOG ")).toBe(key);
    expect(normalizeRecoveryKey("7KD2M8Q4ZXIHNP3RT6VWB9CF0G")).toBe(key);
    expect(normalizeRecoveryKey("7KD2M8Q4ZXlHNP3RT6VWB9CF0G")).toBe(key);
    expect(normalizeRecoveryKey("7KD2M8Q4ZX1HNP3RT6VWB9CF0U")).toBeNull();
    expect(normalizeRecoveryKey(key.slice(1))).toBeNull();
    expect(normalizeRecoveryKey("")).toBeNull();
  });

  it("is shown in groups", () => {
    expect(groupRecoveryKey(key)).toBe("7KD2M-8Q4ZX-1HNP3-RT6VW-B9CF0G");
    expect(normalizeRecoveryKey(groupRecoveryKey(key))).toBe(key);
  });

  it("makes random keys whose check matches", () => {
    const a = makeRecoveryKey();
    const b = makeRecoveryKey();
    expect(a.key).not.toBe(b.key);
    expect(a.key).toHaveLength(RECOVERY_LENGTH);
    expect(a.key).toMatch(new RegExp(`^[${RECOVERY_ALPHABET}]+$`));
    expect(a.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(a.hash).toBe(recoveryHash(a.salt, normalizeRecoveryKey(a.grouped) ?? ""));
  });
});
