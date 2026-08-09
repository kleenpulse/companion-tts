import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlurbCollapser, blurbFor } from "./blurbs";

describe("blurbFor mapping", () => {
  it("maps the core tools", () => {
    expect(blurbFor("Edit", { filePath: "D:\\x\\PillTabs.tsx" })?.phrase).toBe("editing PillTabs.tsx");
    expect(blurbFor("Write", { filePath: "a/b/new.rs" })?.phrase).toBe("writing new.rs");
    expect(blurbFor("Read", { filePath: "src/lib.rs" })?.phrase).toBe("reading lib.rs");
    expect(blurbFor("Grep", { pattern: "foo" })?.phrase).toBe("searching the code");
    expect(blurbFor("WebSearch", {})?.phrase).toBe("searching the web");
  });

  it("uses short command descriptions", () => {
    expect(blurbFor("Bash", { description: "Install package dependencies" })?.phrase).toBe(
      "running: install package dependencies"
    );
    expect(
      blurbFor("Bash", {
        description:
          "A very long description that goes on and on well past eight words in total length",
      })?.phrase
    ).toBe("running a command");
  });

  it("silences bookkeeping tools", () => {
    expect(blurbFor("TodoWrite", {})).toBeNull();
    expect(blurbFor("AskUserQuestion", {})).toBeNull();
    expect(blurbFor("ExitPlanMode", {})).toBeNull();
  });

  it("names mcp servers", () => {
    expect(blurbFor("mcp__figma__get_file", {})?.phrase).toBe("using figma tools");
  });

  it("falls back for unknown tools", () => {
    expect(blurbFor("MysteryTool", {})?.phrase).toBe("using MysteryTool");
  });
});

describe("BlurbCollapser", () => {
  let flushed: string[];
  let collapser: BlurbCollapser;

  beforeEach(() => {
    vi.useFakeTimers();
    flushed = [];
    collapser = new BlurbCollapser((p) => flushed.push(p), 2500, 10_000, () => Date.now());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses a same-kind burst into a plural", () => {
    collapser.push("Edit", { filePath: "a.ts" });
    collapser.push("Edit", { filePath: "b.ts" });
    collapser.push("Edit", { filePath: "c.ts" });
    vi.advanceTimersByTime(2600);
    expect(flushed).toEqual(["editing 3 files"]);
  });

  it("a different kind flushes the pending burst instantly — order preserved", () => {
    collapser.push("Edit", { filePath: "a.ts" });
    collapser.push("Read", { filePath: "b.ts" });
    expect(flushed).toEqual(["editing a.ts"]);
    vi.advanceTimersByTime(2600);
    expect(flushed).toEqual(["editing a.ts", "reading b.ts"]);
  });

  it("flushAll drains before prose", () => {
    collapser.push("Bash", { description: "Run tests" });
    collapser.flushAll();
    expect(flushed).toEqual(["running: run tests"]);
  });

  it("suppresses identical repeats inside the dedupe window", () => {
    collapser.push("Grep", {});
    collapser.flushAll();
    collapser.push("Grep", {});
    collapser.flushAll();
    expect(flushed).toEqual(["searching the code"]);
    vi.advanceTimersByTime(11_000);
    collapser.push("Grep", {});
    collapser.flushAll();
    expect(flushed).toEqual(["searching the code", "searching the code"]);
  });

  it("single blurb flushes with its own phrase after the window", () => {
    collapser.push("Write", { filePath: "x/y/z.md" });
    vi.advanceTimersByTime(2600);
    expect(flushed).toEqual(["writing z.md"]);
  });
});
