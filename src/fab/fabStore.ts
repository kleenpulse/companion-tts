import { create } from "zustand";
import type { EngineMode, VizStyle } from "../shared/types";

/** Fab-window-local mirror of the engine — written directly by engine.ts (same window). */
interface FabState {
  mode: EngineMode;
  queueCount: number;
  audioUnlocked: boolean;
  panelOpen: boolean;
  vizStyle: VizStyle;
  fabScale: number;
  vizOn: boolean;
  composing: boolean;
  set: (patch: Partial<Omit<FabState, "set">>) => void;
}

export const useFabStore = create<FabState>((set) => ({
  mode: "idle",
  queueCount: 0,
  audioUnlocked: true,
  panelOpen: false,
  vizStyle: "strands",
  fabScale: 1,
  vizOn: true,
  composing: false,
  set: (patch) => set(patch),
}));
