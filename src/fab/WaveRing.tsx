import { useEffect, useRef } from "react";
import type { SpectrumSource } from "../speech/engine";

/**
 * 24 radial bars breathing with real audio amplitude — the instrument needle
 * for Claude's voice. Reduced motion → a steady accent glow instead.
 * `pixelScale` = the dial's CSS-transform scale: the bitmap backs at
 * dpr × pixelScale so it stays crisp when the fab grows.
 */
export function WaveRing({
  analyser,
  pixelScale = 1,
}: {
  analyser: SpectrumSource | null;
  pixelScale?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = (window.devicePixelRatio || 1) * pixelScale;
    const size = 56;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cx = size / 2;
    const cy = size / 2;
    const innerR = 17;
    const bars = 24;
    const accent = "#a855f7";

    if (reduced || !analyser) {
      ctx.clearRect(0, 0, size, size);
      ctx.beginPath();
      ctx.arc(cx, cy, innerR + 3, 0, Math.PI * 2);
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 2;
      ctx.stroke();
      return;
    }

    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    const draw = () => {
      analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, size, size);
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.6;
      ctx.lineCap = "round";
      for (let i = 0; i < bars; i++) {
        // Voice energy lives in the low bins — sample the bottom two thirds.
        const bin = Math.floor((i / bars) * data.length * 0.66);
        const v = data[bin] / 255;
        const len = 2 + v * 7;
        const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
        const x0 = cx + Math.cos(angle) * innerR;
        const y0 = cy + Math.sin(angle) * innerR;
        const x1 = cx + Math.cos(angle) * (innerR + len);
        const y1 = cy + Math.sin(angle) * (innerR + len);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [analyser, pixelScale]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: 56, height: 56 }}
      className="pointer-events-none absolute inset-0"
      aria-hidden
    />
  );
}
