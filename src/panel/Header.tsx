import { Moon, Settings, Sun, X } from "lucide-react";
import { togglePanel } from "../shared/bus";
import { projectName, shortTitle } from "../shared/format";
import { resolveTheme } from "../shared/theme";
import { onHeaderPointerDown } from "./dragRegion";
import { usePanelStore } from "./panelStore";
import { PillTabs } from "./PillTabs";
import { useViewStore } from "./viewStore";

export function Header() {
	const { engineState, sessions, settings, saveSettings } = usePanelStore();
	const openSettings = useViewStore((s) => s.openSettings);
	const followed = sessions.find(
		(s) => s.sessionId === engineState?.followedSessionId,
	);
	const followMode = settings?.follow.mode ?? "auto";
	const effectiveTheme = resolveTheme(settings?.theme ?? "dark");

	const flipTheme = () => {
		if (!settings) return;
		void saveSettings({ theme: effectiveTheme === "dark" ? "light" : "dark" });
	};

	const setFollowMode = (mode: "auto" | "pinned") => {
		if (!settings) return;
		void saveSettings({
			follow: {
				mode,
				pinnedSessionId:
					mode === "pinned"
						? (settings.follow.pinnedSessionId ??
							engineState?.followedSessionId ??
							null)
						: null,
			},
		});
	};

	return (
		<header
			onPointerDown={onHeaderPointerDown}
			className="cursor-grab border-b border-hairline px-3 py-2.5 active:cursor-grabbing"
		>
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<div className="font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
						Companion
					</div>
					<div className="truncate text-[13px] font-medium text-ink">
						{followed ? (
							<>
								<span className="text-ink-mute uppercase text-xs">
									{projectName(followed.projectSlug)}:{" "}
								</span>
								{shortTitle(followed.title, followed.projectSlug)}
							</>
						) : (
							"No session followed"
						)}
					</div>
				</div>
				<button
					aria-label={
						effectiveTheme === "dark"
							? "Switch to light theme"
							: "Switch to dark theme"
					}
					onClick={flipTheme}
					className="rounded-md p-1 text-ink-mute transition-colors duration-200 hover:bg-raised hover:text-ink"
				>
					{effectiveTheme === "dark" ? (
						<Sun size={14} strokeWidth={2} />
					) : (
						<Moon size={14} strokeWidth={2} />
					)}
				</button>
				<button
					aria-label="Open settings"
					onClick={() => openSettings()}
					className="rounded-md p-1 text-ink-mute transition-colors duration-200 hover:bg-raised hover:text-ink"
				>
					<Settings size={14} strokeWidth={2} />
				</button>
				<button
					aria-label="Close panel"
					onClick={() => void togglePanel()}
					className="rounded-md p-1 text-ink-mute transition-colors duration-200 hover:bg-raised hover:text-ink"
				>
					<X size={14} strokeWidth={2} />
				</button>
			</div>
			<div className="mt-2 flex items-center justify-between">
				<span className="font-display text-[10px] uppercase tracking-[0.15em] text-ink-mute">
					Follow
				</span>
				<PillTabs
					label="follow"
					value={followMode}
					options={[
						{ value: "auto", label: "Auto" },
						{ value: "pinned", label: "Pinned" },
					]}
					onChange={setFollowMode}
				/>
			</div>
		</header>
	);
}
