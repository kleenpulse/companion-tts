import {
	Pause,
	Play,
	SkipForward,
	Square,
	Volume2,
	VolumeX,
} from "lucide-react";
import { useRef, useState } from "react";
import { sendEngineCmd } from "../shared/bus";
import { usePanelStore } from "./panelStore";
import { InlineFab } from "./InlineFab";
import { PillTabs } from "./PillTabs";

const RATES = ["0.75", "1", "1.25", "1.5"] as const;

/**
 * The deck is theme-locked dark, like the orb's lens: the visualizer needs a
 * dark ground in any theme, so the whole instrument strip adopts the lens's
 * ground instead of leaving the orb as a dark hole in a light panel. Re-pinning
 * the semantic tokens locally keeps every child class untouched.
 */
const DECK_TOKENS = {
	"--color-surface": "#0a0b0c",
	"--color-panel": "#0e1012",
	"--color-raised": "#191d21",
	"--color-hairline": "#2a2f36",
	"--color-ink": "#e2e6e9",
	"--color-ink-dim": "#9ba3ab",
	"--color-ink-mute": "#5c656e",
	"--color-accent": "#a855f7",
	"--color-accent-hover": "#b87df9",
	"--color-danger": "#f87171",
	"--color-bench-700": "#2a2f36",
	"--color-bench-500": "#5c656e",
} as React.CSSProperties;

export function Transport() {
	const { engineState, settings, saveSettings } = usePanelStore();
	const mode = engineState?.mode ?? "idle";
	const paused = mode === "paused";
	const muted = mode === "muted";
	const queued =
		engineState?.queue.filter(
			(u) =>
				u.status === "queued" ||
				u.status === "synthesizing" ||
				u.status === "ready",
		).length ?? 0;
	const health = engineState?.synthHealth;
	const degraded = health?.state === "degraded";
	const volumeCommit = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** Live drag value — settings.volume only lands after the debounced save. */
	const [volDraft, setVolDraft] = useState<number | null>(null);
	const volume = volDraft ?? settings?.volume ?? 0.9;
	const volPct = Math.round(volume * 100);

	const btn =
		"rounded-md border border-hairline bg-bench-700 p-1.5 text-ink-dim transition-colors duration-200 hover:bg-bench-500/60 hover:text-ink disabled:opacity-40";

	const onVolume = (v: number) => {
		setVolDraft(v);
		void sendEngineCmd({ cmd: "set-volume", v });
		if (volumeCommit.current) clearTimeout(volumeCommit.current);
		volumeCommit.current = setTimeout(
			() => void saveSettings({ volume: v }),
			400,
		);
	};

	const onRate = (r: (typeof RATES)[number]) => {
		const v = Number(r);
		void sendEngineCmd({ cmd: "set-rate", v });
		void saveSettings({ rate: v });
	};

	return (
		<div
			style={DECK_TOKENS}
			className="border-t border-hairline bg-bench-850 px-3 py-2"
		>
			<div className="flex items-stretch gap-2.5">
				<div className="flex min-w-0 flex-1 flex-col justify-center">
					<div className="flex items-center gap-1">
						<button
							aria-label={muted ? "Unmute" : "Mute"}
							onClick={() => void sendEngineCmd({ cmd: "toggle-mute" })}
							className={`${btn} ${muted ? "text-danger" : ""}`}
						>
							{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
						</button>
						<button
							aria-label={paused ? "Resume" : "Pause"}
							onClick={() => void sendEngineCmd({ cmd: "pause-resume" })}
							className={btn}
						>
							{paused ? <Play size={15} /> : <Pause size={15} />}
						</button>
						<button
							aria-label="Skip current"
							onClick={() => void sendEngineCmd({ cmd: "skip" })}
							className={btn}
						>
							<SkipForward size={15} />
						</button>
						<button
							aria-label="Stop and clear queue"
							onClick={() => void sendEngineCmd({ cmd: "stop" })}
							className={btn}
						>
							<Square size={13} />
						</button>

						{queued > 0 && (
							<span className="ml-auto shrink-0 rounded-md border border-accent/40 bg-accent px-2 py-0.5 font-display text-[9px] font-semibold uppercase tracking-[0.15em] text-surface">
								{queued} queued
							</span>
						)}
					</div>

					{/* Why the queue is (or isn't) draining — no more silent "12 queued". */}
					{(degraded || queued > 0) && (
						<div className="mt-1 truncate font-display text-[9px] uppercase tracking-[0.15em]">
							{degraded ? (
								<span className="text-danger">
									{health?.provider ? `${health.provider} ` : ""}
									{health?.reason ?? "provider error"}
									{queued > 0 ? " — queue holding" : ""}
								</span>
							) : (
								<span className="text-ink-mute">
									synthesizing · plays in order
								</span>
							)}
						</div>
					)}

					{/* Level meter, not a timeline: discrete LED cells + % readout so
              volume can never be mistaken for an audio scrub bar. */}
					<div className="mt-2 flex items-center gap-2">
						<span className="font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
							Vol
						</span>
						<div className="relative h-2.5 min-w-0 flex-1">
							<div
								aria-hidden
								className="pointer-events-none absolute inset-0"
								style={{
									background: `linear-gradient(to right, var(--color-accent) ${volPct}%, var(--color-hairline) ${volPct}%)`,
									WebkitMaskImage:
										"repeating-linear-gradient(90deg, #000 0 5px, transparent 5px 8px)",
									maskImage:
										"repeating-linear-gradient(90deg, #000 0 5px, transparent 5px 8px)",
								}}
							/>
							<input
								aria-label="Volume"
								type="range"
								min={0}
								max={1}
								step={0.05}
								value={volume}
								onChange={(e) => onVolume(Number(e.target.value))}
								className="peer absolute inset-0 h-full w-full cursor-ew-resize appearance-none opacity-0"
							/>
							<div className="pointer-events-none absolute -inset-1 rounded-sm peer-focus-visible:outline-2 peer-focus-visible:outline-accent" />
						</div>
						<span className="w-8 shrink-0 text-right font-mono text-[10px] text-ink-dim">
							{volPct}%
						</span>
					</div>

					{/* flex-wrap: when the column is tight the pills drop below the
              label as a unit instead of mangling text inside the buttons. */}
					<div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
						<span className="font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
							Rate
						</span>
						<PillTabs
							label="rate"
							value={String(settings?.rate ?? 1) as (typeof RATES)[number]}
							options={RATES.map((r) => ({ value: r, label: `${r}×` }))}
							onChange={onRate}
						/>
					</div>
				</div>

				{/* The companion's face: spans the full section height, always 1:1. */}
				<InlineFab />
			</div>
		</div>
	);
}
