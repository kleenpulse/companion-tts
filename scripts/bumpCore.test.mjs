import { describe, expect, it } from "vitest";
import {
  bumpCargoLock,
  bumpCargoToml,
  bumpPackageJson,
  bumpTauriConf,
  cutRelease,
  nextVersion,
} from "./bumpCore.mjs";

describe("nextVersion", () => {
  it("bumps patch/minor/major", () => {
    expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(nextVersion("0.1.9", "minor")).toBe("0.2.0");
    expect(nextVersion("0.9.3", "major")).toBe("1.0.0");
  });

  it("accepts an explicit version and rejects junk", () => {
    expect(nextVersion("0.1.0", "2.5.7")).toBe("2.5.7");
    expect(() => nextVersion("0.1.0", "banana")).toThrow(/patch\|minor\|major/);
    expect(() => nextVersion("dev", "patch")).toThrow(/not x\.y\.z/);
  });
});

describe("file rewriters", () => {
  it("package.json / tauri.conf.json: first version key only", () => {
    const pkg = `{\n  "name": "companion-tts",\n  "version": "0.1.0",\n  "deps": { "version": "0.1.0" }\n}`;
    const out = bumpPackageJson(pkg, "0.1.0", "0.2.0");
    expect(out).toContain(`"version": "0.2.0"`);
    expect(out).toContain(`"deps": { "version": "0.1.0" }`);
    expect(bumpTauriConf(`{"version": "0.1.0"}`, "0.1.0", "0.2.0")).toBe(`{"version": "0.2.0"}`);
  });

  it("Cargo.toml: first version assignment only", () => {
    const toml = `[package]\nname = "companion-tts"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "0.1.0" }\n`;
    const out = bumpCargoToml(toml, "0.1.0", "0.2.0");
    expect(out).toContain(`name = "companion-tts"\nversion = "0.2.0"`);
    expect(out).toContain(`serde = { version = "0.1.0" }`);
  });

  it("Cargo.lock: only the companion-tts stanza, decoy at same version untouched", () => {
    const lock = [
      "[[package]]",
      'name = "decoy"',
      'version = "0.1.0"',
      "",
      "[[package]]",
      'name = "companion-tts"',
      'version = "0.1.0"',
      "dependencies = []",
      "",
    ].join("\n");
    const out = bumpCargoLock(lock, "0.1.0", "0.2.0");
    expect(out).toContain('name = "decoy"\nversion = "0.1.0"');
    expect(out).toContain('name = "companion-tts"\nversion = "0.2.0"');
  });

  it("throws when the expected version string is absent", () => {
    expect(() => bumpPackageJson("{}", "0.1.0", "0.2.0")).toThrow(/package\.json/);
  });
});

describe("cutRelease", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- New thing.",
    "- Another thing.",
    "",
    "## [0.1.0] - 2026-07-01",
    "",
    "### Added",
    "",
    "- Old thing.",
    "",
  ].join("\n");

  it("moves Unreleased under the new version and leaves a fresh Unreleased", () => {
    const { out, entryCount } = cutRelease(changelog, "0.2.0", "2026-08-09");
    expect(entryCount).toBe(2);
    const unreleasedAt = out.indexOf("## [Unreleased]");
    const newAt = out.indexOf("## [0.2.0] - 2026-08-09");
    const oldAt = out.indexOf("## [0.1.0] - 2026-07-01");
    expect(unreleasedAt).toBeGreaterThan(-1);
    expect(newAt).toBeGreaterThan(unreleasedAt);
    expect(oldAt).toBeGreaterThan(newAt);
    // The fresh Unreleased section is empty.
    expect(out.slice(unreleasedAt, newAt)).not.toContain("- ");
    // Entries moved under the new heading.
    expect(out.slice(newAt, oldAt)).toContain("- New thing.");
  });

  it("reports 0 entries for an empty Unreleased", () => {
    const empty = "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-07-01\n\n- Old.\n";
    expect(cutRelease(empty, "0.2.0", "2026-08-09").entryCount).toBe(0);
  });

  it("throws without an Unreleased section", () => {
    expect(() => cutRelease("# Changelog\n", "0.2.0", "2026-08-09")).toThrow(/Unreleased/);
  });
});
