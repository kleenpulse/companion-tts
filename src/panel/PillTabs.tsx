import { motion } from "motion/react";

/** House pattern: layoutId sliding indicator, canonical spring {350, 30}. */
export function PillTabs<T extends string>({
	value,
	options,
	onChange,
	label,
	shake,
}: {
	value: T;
	options: readonly { value: T; label: string }[];
	onChange: (v: T) => void;
	label: string;
	/** Rejection feedback: the named pill shakes; bump key to re-trigger. */
	shake?: { value: T; key: number } | null;
}) {
	return (
		<div
			role="tablist"
			aria-label={label}
			className="flex flex-wrap items-center gap-0.5 rounded-lg border border-hairline bg-surface p-0.5"
		>
			{options.map((opt) => {
				const active = opt.value === value;
				const shaking = shake?.value === opt.value;
				return (
					<motion.button
						// A shaken pill remounts (fresh key) so the keyframes replay on
						// every rejected click. Only ever a non-active pill — the
						// indicator's layoutId lives on the active one, undisturbed.
						key={shaking ? `${opt.value}:shake${shake.key}` : opt.value}
						role="tab"
						aria-selected={active}
						onClick={() => onChange(opt.value)}
						initial={{ x: 0 }}
						animate={shaking ? { x: [0, -5, 5, -3, 3, 0] } : { x: 0 }}
						transition={shaking ? { duration: 0.35, ease: "easeInOut" } : undefined}
						className={`relative whitespace-nowrap rounded-md font-medium px-2 py-1 font-display text-[10px] uppercase tracking-[0.15em] transition-colors duration-200 ${
							active ? "text-surface" : "text-ink-mute hover:text-ink-dim"
						}`}
					>
						{active && (
							<motion.span
								layoutId={`pill-${label}`}
								// Only animate when the selection changes — without this, any
								// container reflow (wrap, resize, section expand) triggers a
								// layout animation and the BG visibly detaches and glides.
								layoutDependency={value}
								initial={false}
								className="absolute inset-0 rounded-md border border-accent/40 bg-accent"
								transition={{ type: "spring", stiffness: 350, damping: 30 }}
							/>
						)}
						<span className="relative">{opt.label}</span>
					</motion.button>
				);
			})}
		</div>
	);
}
