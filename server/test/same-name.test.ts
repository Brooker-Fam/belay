import { describe, expect, it } from "vitest";
import { sameName } from "../src/text.js";

describe("a phone's name, typed to confirm", () => {
  it("matches as a person means it: case, spaces and a keyboard's curly quotes don't count", () => {
    expect(sameName("Sam's phone", "Sam's phone")).toBe(true);
    expect(sameName("sam’s phone", "Sam's phone")).toBe(true);
    expect(sameName("  SAM'S   PHONE ", "Sam's phone")).toBe(true);
    expect(sameName("The “big” tablet", 'The "big" tablet')).toBe(true);
    expect(sameName("Ｓａｍ's phone", "Sam's phone")).toBe(true);
  });

  it("refuses anything else, and an empty name never matches", () => {
    expect(sameName("Sam", "Sam's phone")).toBe(false);
    expect(sameName("Sams phone", "Sam's phone")).toBe(false);
    expect(sameName("Sam's phone!", "Sam's phone")).toBe(false);
    expect(sameName("", "")).toBe(false);
    expect(sameName("  ", " ")).toBe(false);
  });
});
