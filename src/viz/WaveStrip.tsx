import { useEffect, useRef } from "react";
import { onVizEnv } from "../shared/bus";

// The "waves" visualizer style: center-mirrored amplitude bars on canvas,
// fed by the same viz-env IPC stream as the strands (12 coarse bins at 20Hz),
// smoothed per-bar with fast attack / slow release. Idle collapses to a
// hairline; "thinking" (synthesis in flight) breathes a slow shimmer.
const ACCENT = "168, 85, 247"; // amethyst
const THINKING = "124, 58, 237"; // violet
const ATTACK_TAU = 0.06;
const RELEASE_TAU = 0.28;
const BAR_W = 3;
const GAP = 2;

interface Props {
  playing: boolean;
  thinking: boolean;
}

const poleK = (tau: number, dt: number) => 1 - Math.exp(-dt / tau);

export function WaveStrip({ playing, thinking }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const binsRef = useRef<number[]>(new Array(12).fill(0));
  const mirror = useRef({ playing, thinking });
  mirror.current = { playing, thinking };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void onVizEnv((env) => {
      binsRef.current = env.bins;
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let raf = 0;
    let lastT = -1;
    let smoothed: number[] = [];
    let phase = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const draw = (t: number) => {
      const { playing: isPlaying, thinking: isThinking } = mirror.current;
      const dt = lastT >= 0 ? Math.min((t - lastT) / 1000, 0.05) : 0;
      lastT = t;
      phase += dt;

      const w = canvas.getBoundingClientRect().width;
      const h = canvas.getBoundingClientRect().height;
      const slots = Math.max(6, Math.floor(w / (BAR_W + GAP)));
      if (smoothed.length !== slots) smoothed = new Array(slots).fill(0);

      const bins = binsRef.current;
      const half = slots / 2;
      let energy = 0;
      for (let i = 0; i < slots; i++) {
        // Center-mirrored: bar distance from center indexes into the bins.
        const d = Math.abs(i + 0.5 - half) / half; // 0 center → 1 edge
        let target = 0;
        if (isPlaying) {
          const bi = Math.min(bins.length - 1, Math.floor(d * bins.length));
          target = bins[bi] ?? 0;
        } else if (isThinking) {
          target = 0.1 + 0.07 * Math.sin(phase * 2.2 + i * 0.7);
        }
        const tau = target > smoothed[i] ? ATTACK_TAU : RELEASE_TAU;
        smoothed[i] += (target - smoothed[i]) * poleK(tau, dt || 0.016);
        energy += smoothed[i];
      }

      ctx.clearRect(0, 0, w, h);
      const rgb = isThinking && !isPlaying ? THINKING : ACCENT;
      const mid = h / 2;
      for (let i = 0; i < slots; i++) {
        const x = i * (BAR_W + GAP) + (w - slots * (BAR_W + GAP) + GAP) / 2;
        const bh = Math.max(1.5, smoothed[i] * (h - 8));
        ctx.fillStyle = `rgba(${rgb}, ${0.35 + smoothed[i] * 0.65})`;
        ctx.beginPath();
        ctx.roundRect(x, mid - bh / 2, BAR_W, bh, BAR_W / 2);
        ctx.fill();
      }

      // Halt at rest so an idle strip doesn't paint forever.
      if (!isPlaying && !isThinking && energy < 0.01) {
        lastT = -1;
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(draw);
    };

    const start = () => {
      if (raf) return;
      lastT = -1;
      raf = requestAnimationFrame(draw);
    };

    if (reduced) {
      // Static frame: quiet center-weighted bars, no animation.
      resize();
      const w = canvas.getBoundingClientRect().width;
      const h = canvas.getBoundingClientRect().height;
      const slots = Math.max(6, Math.floor(w / (BAR_W + GAP)));
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < slots; i++) {
        const d = Math.abs(i + 0.5 - slots / 2) / (slots / 2);
        const bh = Math.max(1.5, (1 - d) * 0.35 * (h - 8));
        const x = i * (BAR_W + GAP) + (w - slots * (BAR_W + GAP) + GAP) / 2;
        ctx.fillStyle = `rgba(${ACCENT}, 0.45)`;
        ctx.beginPath();
        ctx.roundRect(x, h / 2 - bh / 2, BAR_W, bh, BAR_W / 2);
        ctx.fill();
      }
    } else {
      start();
    }

    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [playing, thinking]);

  return <canvas ref={canvasRef} className="h-full w-full" aria-hidden="true" />;
}
