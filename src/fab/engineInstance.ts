import * as bus from "../shared/bus";
import { applyTheme } from "../shared/theme";
import { Engine } from "../speech/engine";
import { Player } from "../speech/player";
import { useFabStore } from "./fabStore";

/**
 * Composition root — the ONLY place the engine meets Tauri/DOM adapters.
 * `io: bus` works because EngineIO is shape-congruent with bus.ts's exports;
 * if bus drifts, this file fails to typecheck. theme.ts's import-time flash
 * guard fires here (fab window, DOM present), never in engine.ts.
 */
export const engine = new Engine({
  io: bus,
  player: new Player(),
  applyTheme,
  mirror: (patch) => useFabStore.getState().set(patch),
});
