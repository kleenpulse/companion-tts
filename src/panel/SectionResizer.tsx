import { useRef } from "react";

/**
 * Horizontal drag divider between panel sections. 8px hit area around a
 * hairline that wakes to accent on hover/drag; pointer-captured so fast
 * drags never escape. Parent owns the height state and the sign of dy.
 */
export function SectionResizer({
  label,
  onDelta,
}: {
  label: string;
  onDelta: (dy: number) => void;
}) {
  const lastY = useRef<number | null>(null);

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      className="group flex h-2 shrink-0 cursor-ns-resize touch-none items-center justify-center"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        lastY.current = e.clientY;
      }}
      onPointerMove={(e) => {
        if (lastY.current === null) return;
        onDelta(e.clientY - lastY.current);
        lastY.current = e.clientY;
      }}
      onPointerUp={(e) => {
        lastY.current = null;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // capture may already be gone — fine
        }
      }}
      onPointerCancel={() => {
        lastY.current = null;
      }}
    >
      <span className="h-px w-full bg-hairline transition-colors duration-200 group-hover:bg-accent/50 group-active:bg-accent" />
    </div>
  );
}
