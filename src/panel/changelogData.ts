// Panel-only module: the ?raw import bundles CHANGELOG.md into the panel
// entry — never import from fab code (two-entry build invariant).
import raw from "../../CHANGELOG.md?raw";
import { parseChangelog } from "../shared/changelog";

export const releases = parseChangelog(raw);
