import { motion } from "motion/react";

/** House pattern: layoutId sliding indicator, canonical spring {350, 30}. */
export function PillTabs<T extends string>({
	value,
	options,
	onChange,
	label,
}: {
	value: T;
	options: readonly { value: T; label: string }[];
	onChange: (v: T) => void;
	label: string;
}) {
	return (
		<div
			role="tablist"
			aria-label={label}
			className="flex flex-wrap items-center gap-0.5 rounded-lg border border-hairline bg-surface p-0.5"
		>
			{options.map((opt) => {
				const active = opt.value === value;
				return (
					<button
						key={opt.value}
						role="tab"
						aria-selected={active}
						onClick={() => onChange(opt.value)}
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
					</button>
				);
			})}
		</div>
	);
}
