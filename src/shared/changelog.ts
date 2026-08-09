/** Keep-a-changelog parser — feeds the What's New card and settings browser. */

export type ChangeCategory =
  | "added"
  | "changed"
  | "fixed"
  | "removed"
  | "deprecated"
  | "security";

export interface ChangelogEntry {
  category: ChangeCategory;
  text: string;
}

export interface ChangelogRelease {
  version: string;
  /** `YYYY-MM-DD` from the heading, or null when the heading has no date. */
  date: string | null;
  entries: ChangelogEntry[];
}

const RELEASE_RE = /^##\s+\[(\d+\.\d+\.\d+)\](?:\s*-\s*(\S+))?\s*$/;
const CATEGORY_RE = /^###\s+(\w+)\s*$/;
const ENTRY_RE = /^-\s+(.*)$/;

const CATEGORIES: readonly ChangeCategory[] = [
  "added",
  "changed",
  "fixed",
  "removed",
  "deprecated",
  "security",
];

/** Released versions only (Unreleased is skipped); file order = newest first. */
export function parseChangelog(raw: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let current: ChangelogRelease | null = null;
  let category: ChangeCategory = "changed";

  for (const line of raw.split(/\r?\n/)) {
    const release = RELEASE_RE.exec(line);
    if (release) {
      current = { version: release[1], date: release[2] ?? null, entries: [] };
      category = "changed";
      releases.push(current);
      continue;
    }
    if (/^##\s/.test(line)) {
      // Non-version section heading (e.g. "## [Unreleased]") ends any release.
      current = null;
      continue;
    }
    if (!current) continue;

    const cat = CATEGORY_RE.exec(line);
    if (cat) {
      const c = cat[1].toLowerCase() as ChangeCategory;
      category = CATEGORIES.includes(c) ? c : "changed";
      continue;
    }
    const entry = ENTRY_RE.exec(line);
    if (entry) {
      current.entries.push({ category, text: entry[1].trim() });
      continue;
    }
    // Continuation line of the previous entry (indented prose).
    const cont = line.trim();
    if (cont && current.entries.length > 0) {
      const last = current.entries[current.entries.length - 1];
      last.text = `${last.text} ${cont}`;
    }
  }
  return releases;
}

export function releaseFor(
  releases: ChangelogRelease[],
  version: string
): ChangelogRelease | undefined {
  return releases.find((r) => r.version === version);
}
