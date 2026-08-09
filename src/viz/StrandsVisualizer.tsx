import { useEffect, useRef, useState } from "react";
import { onVizEnv } from "../shared/bus";
import Strands from "./Strands";

// Mirrored from admin_shadow-garden's VoiceVisualizer, adapted for the two-window
// split: the analyser lives in the FAB webview, so instead of tapping an <audio>
// element directly, this listens to the `viz-env` IPC stream (raw RMS at 20Hz)
// and applies the same attack/release envelope locally. Everything else — the
// critically-damped springs, palette crossfade, settle-halt — is the original.
//
// Palette doctrine carried over verbatim: the ribbons are additive and need a
// dark field (the strip is backed bench-950), so these stay pinned to the DARK
// ramp values regardless of theme.
const ACCENT_PALETTE = ["#a855f7", "#7c3aed", "#22d3ee"];
const THINKING_PALETTE = ["#6d28d9", "#7c3aed", "#38bdf8"];

const ATTACK = 0.34;
const RELEASE = 0.85;
const EPS = 0.004;
const V_EPS = 0.02;
const MAX_DT = 0.05;

// Critically damped spring (smooth damp): converges without overshoot, is
// frame-rate independent, and bends motion mid-flight instead of kinking it.
function smoothDamp(
  cur: number,
  target: number,
  vel: number,
  smoothTime: number,
  dt: number
): [number, number] {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel + omega * change) * dt;
  return [target + (change + temp) * exp, (vel - omega * temp) * exp];
}

const poleK = (tau: number, dt: number) => 1 - Math.exp(-dt / tau);

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const ACCENT_RGB = ACCENT_PALETTE.map(hexToRgb);
const THINKING_RGB = THINKING_PALETTE.map(hexToRgb);

function mixPalette(t: number): string[] {
  if (t <= 0.001) return ACCENT_PALETTE;
  if (t >= 0.999) return THINKING_PALETTE;
  return ACCENT_RGB.map((from, i) => {
    const to = THINKING_RGB[i];
    let out = "#";
    for (let c = 0; c < 3; c++) {
      out += Math.round(from[c] + (to[c] - from[c]) * t)
        .toString(16)
        .padStart(2, "0");
    }
    return out;
  });
}

interface Props {
  /** Engine is actively playing narration. */
  playing: boolean;
  /** Synthesis in flight — the "composing" shimmer. */
  thinking: boolean;
  /** Round glass-lens rendering (the voice-brief orb look). */
  glass?: boolean;
  /** Ancestor CSS-transform scale (the fab dial) — keeps the canvas crisp. */
  pixelScale?: number;
}

interface Frame {
  paused: boolean;
  speed: number;
  intensity: number;
  amplitude: number;
  glow: number;
  hueShift: number;
  colors: string[];
}

const IDLE = {
  speed: 0.22,
  intensity: 0.6,
  amplitude: 1.1,
  glow: 0.5,
  hueShift: 0,
};
const REDUCED: Frame = {
  paused: true,
  speed: 0,
  intensity: 0.62,
  amplitude: 1.15,
  glow: 3.2,
  hueShift: 0,
  colors: ACCENT_PALETTE,
};

export function StrandsVisualizer({ playing, thinking, glass = false, pixelScale = 1 }: Props) {
  const [reducedMotion, setReducedMotion] = useState(false);
  const [frame, setFrame] = useState<Frame>({
    paused: false,
    ...IDLE,
    colors: ACCENT_PALETTE,
  });

  // Raw RMS pushed over IPC; the rAF loop below smooths it into the envelope.
  const envTargetRef = useRef(0);
  const envRef = useRef(0);

  const rafRef = useRef<number>(0);
  const runningRef = useRef(false);
  const lastTRef = useRef(-1);
  const aRef = useRef({ ...IDLE });
  const vRef = useRef({ speed: 0, intensity: 0, amplitude: 0, glow: 0, hueShift: 0 });
  const mixRef = useRef(0);
  const mixVRef = useRef(0);
  const mirror = useRef({ thinking, playing });
  mirror.current = { thinking, playing };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void onVizEnv((env) => {
      envTargetRef.current = env.rms;
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const tick = (t: number) => {
      const { playing: isPlaying, thinking: isThinking } = mirror.current;

      const dt =
        lastTRef.current >= 0 ? Math.min((t - lastTRef.current) / 1000, MAX_DT) : 0;
      lastTRef.current = t;

      // --- audio envelope: fast attack for speech onsets, slow release ---
      const target = isPlaying ? envTargetRef.current : 0;
      const tau = target > envRef.current ? 0.067 : 0.27;
      envRef.current += (target - envRef.current) * poleK(tau, dt);
      const env = envRef.current;

      let tSpeed: number, tInt: number, tAmp: number, tGlow: number, tHue: number;
      let tMix = 0;
      if (isPlaying) {
        tSpeed = 1.3;
        tInt = 1;
        tAmp = 1.6;
        tGlow = 0.3 + env * 0.2;
        tHue = 0;
      } else if (isThinking) {
        tSpeed = 0.5;
        tInt = 0.7;
        tAmp = 1.25;
        tGlow = 1.6;
        tHue = 0.04;
        tMix = 1;
      } else {
        tSpeed = IDLE.speed;
        tInt = IDLE.intensity;
        tAmp = IDLE.amplitude;
        tGlow = IDLE.glow;
        tHue = 0;
      }

      const smoothTime = isPlaying || isThinking ? ATTACK : RELEASE;
      const a = aRef.current;
      const v = vRef.current;
      [a.speed, v.speed] = smoothDamp(a.speed, tSpeed, v.speed, smoothTime, dt);
      [a.intensity, v.intensity] = smoothDamp(a.intensity, tInt, v.intensity, smoothTime, dt);
      [a.amplitude, v.amplitude] = smoothDamp(a.amplitude, tAmp, v.amplitude, smoothTime, dt);
      [a.glow, v.glow] = smoothDamp(a.glow, tGlow, v.glow, smoothTime, dt);
      [a.hueShift, v.hueShift] = smoothDamp(a.hueShift, tHue, v.hueShift, smoothTime, dt);
      [mixRef.current, mixVRef.current] = smoothDamp(
        mixRef.current,
        tMix,
        mixVRef.current,
        smoothTime,
        dt
      );

      setFrame({
        paused: false,
        speed: a.speed,
        intensity: a.intensity,
        amplitude: a.amplitude,
        glow: a.glow,
        hueShift: a.hueShift,
        colors: mixPalette(mixRef.current),
      });

      // Halt at rest so an idle strip doesn't re-render forever.
      const settled =
        !isPlaying &&
        !isThinking &&
        Math.abs(a.speed - tSpeed) < EPS &&
        Math.abs(a.intensity - tInt) < EPS &&
        Math.abs(a.amplitude - tAmp) < EPS &&
        Math.abs(a.glow - tGlow) < EPS &&
        Math.abs(a.hueShift - tHue) < EPS &&
        Math.abs(mixRef.current - tMix) < EPS &&
        Math.abs(v.speed) < V_EPS &&
        Math.abs(v.intensity) < V_EPS &&
        Math.abs(v.amplitude) < V_EPS &&
        Math.abs(v.glow) < V_EPS &&
        env < EPS;
      if (settled) {
        runningRef.current = false;
        lastTRef.current = -1;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (runningRef.current) return;
      runningRef.current = true;
      lastTRef.current = -1;
      rafRef.current = requestAnimationFrame(tick);
    };

    if (reducedMotion) {
      runningRef.current = false;
      cancelAnimationFrame(rafRef.current);
      aRef.current = {
        speed: 0,
        intensity: REDUCED.intensity,
        amplitude: REDUCED.amplitude,
        glow: REDUCED.glow,
        hueShift: 0,
      };
      vRef.current = { speed: 0, intensity: 0, amplitude: 0, glow: 0, hueShift: 0 };
      mixRef.current = 0;
      mixVRef.current = 0;
      lastTRef.current = -1;
      setFrame(REDUCED);
      envRef.current = 0;
    } else {
      startLoop();
    }

    return () => {
      runningRef.current = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [playing, thinking, reducedMotion]);

  // Glass lens runs the voice-brief's exact proportions (fills the orb);
  // the flat variant keeps the strip-friendly tuning.
  if (glass) {
    return (
      <Strands
        count={10}
        waviness={1}
        thickness={1}
        strandWidth={100}
        scale={1.5}
        glass
        refraction={1.6}
        glassSize={0.62}
        pixelScale={pixelScale}
        {...frame}
      />
    );
  }
  return (
    <Strands
      count={8}
      waviness={1}
      thickness={0.8}
      strandWidth={100}
      scale={0.62}
      taper={2.2}
      pixelScale={pixelScale}
      {...frame}
    />
  );
}
