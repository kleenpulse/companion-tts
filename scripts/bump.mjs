#!/usr/bin/env node
/**
 * Release cutter — syncs every version file, cuts CHANGELOG.md, commits, tags.
 *
 *   node scripts/bump.mjs patch|minor|major|<x.y.z>  [--allow-empty]
 *
 * Refuses on a dirty git tree and on an empty [Unreleased] section
 * (--allow-empty overrides the latter for emergency re-cuts). Rewrites
 * package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml,
 * src-tauri/Cargo.lock and CHANGELOG.md, then commits `chore(release): vX.Y.Z`
 * and creates annotated tag vX.Y.Z. Never pushes.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bumpCargoLock,
  bumpCargoToml,
  bumpPackageJson,
  bumpTauriConf,
  cutRelease,
  nextVersion,
} from "./bumpCore.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const allowEmpty = args.includes("--allow-empty");
const arg = args.find((a) => !a.startsWith("--"));

if (!arg) {
  console.error("usage: node scripts/bump.mjs patch|minor|major|<x.y.z> [--allow-empty]");
  process.exit(1);
}

const git = (cmd) => execSync(`git ${cmd}`, { cwd: root, encoding: "utf8" });

const dirty = git("status --porcelain").trim();
if (dirty) {
  console.error("refusing: working tree is dirty — commit or stash first:\n" + dirty);
  process.exit(1);
}

const FILES = {
  pkg: join(root, "package.json"),
  conf: join(root, "src-tauri", "tauri.conf.json"),
  toml: join(root, "src-tauri", "Cargo.toml"),
  lock: join(root, "src-tauri", "Cargo.lock"),
  changelog: join(root, "CHANGELOG.md"),
};

const current = JSON.parse(readFileSync(FILES.pkg, "utf8")).version;
const next = nextVersion(current, arg);
const date = new Date().toISOString().slice(0, 10);

const changelogRaw = readFileSync(FILES.changelog, "utf8");
const { out: changelogOut, entryCount } = cutRelease(changelogRaw, next, date);
if (entryCount === 0 && !allowEmpty) {
  console.error("refusing: [Unreleased] has no entries — write the changelog first (--allow-empty to override)");
  process.exit(1);
}

const rewrites = [
  [FILES.pkg, (raw) => bumpPackageJson(raw, current, next)],
  [FILES.conf, (raw) => bumpTauriConf(raw, current, next)],
  [FILES.toml, (raw) => bumpCargoToml(raw, current, next)],
  [FILES.lock, (raw) => bumpCargoLock(raw, current, next)],
  [FILES.changelog, () => changelogOut],
];
for (const [file, fn] of rewrites) {
  writeFileSync(file, fn(readFileSync(file, "utf8")));
}

const rel = Object.values(FILES).map((f) => JSON.stringify(f)).join(" ");
git(`add ${rel}`);
git(`commit -m "chore(release): v${next}"`);
git(`tag -a v${next} -m "v${next}"`);

console.log(`v${current} -> v${next} (${entryCount} changelog entries) — committed and tagged.`);
