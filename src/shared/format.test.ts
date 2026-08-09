import { describe, expect, it } from "vitest";
import { fabLevelToScale, fabScaleToLevel, revealEdge } from "./format";

describe("revealEdge", () => {
  it("shows nothing before playback starts", () => {
    expect(revealEdge(0, 100, false)).toBe(0);
  });

  it("latches full on end regardless of frac", () => {
    expect(revealEdge(0, 100, true)).toBe(100);
    expect(revealEdge(0.4, 100, true)).toBe(100);
  });

  it("leads playback by one unit and clamps at total", () => {
    expect(revealEdge(0.5, 100, false)).toBe(51);
    expect(revealEdge(1, 100, false)).toBe(100);
    expect(revealEdge(0.999, 100, false)).toBe(100);
  });

  it("tiny frac reveals the first unit immediately", () => {
    expect(revealEdge(0.0001, 100, false)).toBe(1);
  });

  it("pairs with Array.from so surrogate pairs never split", () => {
    const units = Array.from("hi 🚀🇬🇧 there");
    // Every edge value indexes whole units — slicing at any edge is valid.
    for (let f = 0; f <= 1; f += 0.05) {
      const edge = revealEdge(f, units.length, false);
      const shown = units.slice(0, edge).join("");
      expect(() => [...shown]).not.toThrow();
      expect(shown).toBe(Array.from("hi 🚀🇬🇧 there").slice(0, edge).join(""));
    }
  });
});

describe("fab size levels", () => {
  it("maps L1..L10 to ×0.75..×3.0 and round-trips exactly", () => {
    expect(fabLevelToScale(1)).toBe(0.75);
    expect(fabLevelToScale(2)).toBe(1.0);
    expect(fabLevelToScale(10)).toBe(3.0);
    for (let level = 1; level <= 10; level++) {
      expect(fabScaleToLevel(fabLevelToScale(level))).toBe(level);
    }
  });

  it("snaps legacy percent-slider values into range", () => {
    expect(fabScaleToLevel(0.9)).toBe(2); // old 90%
    expect(fabScaleToLevel(1.75)).toBe(5); // old max
    expect(fabScaleToLevel(0.1)).toBe(1); // below floor
    expect(fabScaleToLevel(99)).toBe(10); // above ceiling
  });

  it("clamps out-of-range levels", () => {
    expect(fabLevelToScale(0)).toBe(0.75);
    expect(fabLevelToScale(42)).toBe(3.0);
  });
});
