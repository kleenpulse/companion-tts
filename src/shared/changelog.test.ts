import { describe, expect, it } from "vitest";
import { parseChangelog, releaseFor } from "./changelog";

const NORMAL = `# Changelog

Preamble prose that must be ignored.

## [Unreleased]

### Added

- Not released yet.

## [0.2.0] - 2026-08-09

### Added

- Version tracker with What's New card.
- Release pipeline via bump script.

### Fixed

- Footer overflow at minimum width.

## [0.1.0] - 2026-07-01

### Added

- Floating companion dial.
`;

describe("parseChangelog", () => {
  it("parses releases newest-first and skips Unreleased", () => {
    const releases = parseChangelog(NORMAL);
    expect(releases.map((r) => r.version)).toEqual(["0.2.0", "0.1.0"]);
    expect(releases[0].date).toBe("2026-08-09");
    expect(releases[0].entries).toEqual([
      { category: "added", text: "Version tracker with What's New card." },
      { category: "added", text: "Release pipeline via bump script." },
      { category: "fixed", text: "Footer overflow at minimum width." },
    ]);
  });

  it("tolerates a missing date", () => {
    const [r] = parseChangelog("## [1.0.0]\n\n### Added\n\n- Thing.\n");
    expect(r.version).toBe("1.0.0");
    expect(r.date).toBeNull();
    expect(r.entries).toHaveLength(1);
  });

  it("buckets unknown categories as changed", () => {
    const [r] = parseChangelog("## [1.0.0] - 2026-01-01\n\n### Experimental\n\n- Odd.\n");
    expect(r.entries).toEqual([{ category: "changed", text: "Odd." }]);
  });

  it("defaults to changed when entries precede any category heading", () => {
    const [r] = parseChangelog("## [1.0.0] - 2026-01-01\n\n- Bare entry.\n");
    expect(r.entries).toEqual([{ category: "changed", text: "Bare entry." }]);
  });

  it("folds continuation lines into the previous entry", () => {
    const [r] = parseChangelog(
      "## [1.0.0] - 2026-01-01\n\n### Added\n\n- First line\n  continues here.\n"
    );
    expect(r.entries).toEqual([{ category: "added", text: "First line continues here." }]);
  });

  it("handles empty sections and CRLF input", () => {
    const releases = parseChangelog("## [1.0.0] - 2026-01-01\r\n\r\n### Added\r\n\r\n");
    expect(releases).toEqual([{ version: "1.0.0", date: "2026-01-01", entries: [] }]);
  });

  it("ignores prose outside any release section", () => {
    expect(parseChangelog("# Changelog\n\nJust prose.\n- stray bullet\n")).toEqual([]);
  });
});

describe("releaseFor", () => {
  it("finds an exact version and misses gracefully", () => {
    const releases = parseChangelog(NORMAL);
    expect(releaseFor(releases, "0.1.0")?.version).toBe("0.1.0");
    expect(releaseFor(releases, "9.9.9")).toBeUndefined();
  });
});
