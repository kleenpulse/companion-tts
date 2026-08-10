/**
 * One persistent <audio> element wired through Web Audio:
 *   element → MediaElementSource → BoostGain (per-provider) → Gain (volume/mute)
 *   → Analyser → destination.
 * The analyser drives the FAB's waveform ring. The chime is two oscillators
 * into the master gain directly, so volume and mute apply to everything but
 * provider corrections never color the chime.
 */

/** Per-provider playback corrections — layered over the user's settings,
 * never persisted into them. */
export interface ProviderBoost {
  rate: number;
  gain: number;
}

export class Player {
  readonly el: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private boostNode: GainNode | null = null;
  analyser: AnalyserNode | null = null;

  private volume = 0.9;
  private rate = 1.0;
  private boost: ProviderBoost = { rate: 1, gain: 1 };

  constructor() {
    this.el = new Audio();
    this.el.preload = "auto";
  }

  /** createMediaElementSource is once-per-element-lifetime — guard with ctx null check. */
  private ensureGraph(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    const src = this.ctx.createMediaElementSource(this.el);
    this.boostNode = this.ctx.createGain();
    this.boostNode.gain.value = this.boost.gain;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.volume;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 64;
    this.analyser.smoothingTimeConstant = 0.7;
    // Analyser MUST chain to destination or audio goes silent.
    src.connect(this.boostNode);
    this.boostNode.connect(this.gain);
    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  /**
   * Autoplay probe: with --autoplay-policy=no-user-gesture-required the
   * AudioContext starts (or resumes to) "running" without any gesture.
   * If it stays suspended, the flag regressed and narration cannot start.
   */
  async probeAutoplay(): Promise<boolean> {
    this.ensureGraph();
    if (!this.ctx) return false;
    if (this.ctx.state === "running") return true;
    try {
      await this.ctx.resume();
    } catch {
      return false;
    }
    // resume() mutates state behind TS's narrowing — re-read it wide.
    return (this.ctx.state as AudioContextState) === "running";
  }

  playUrl(url: string, onEnded: () => void, onError: (e: unknown) => void): void {
    this.ensureGraph();
    const el = this.el;
    el.onended = () => {
      el.onended = null;
      el.onerror = null;
      onEnded();
    };
    el.onerror = () => {
      el.onended = null;
      el.onerror = null;
      onError(new Error("audio element error"));
    };
    el.src = url;
    el.playbackRate = this.effectiveRate();
    void el.play().catch((e) => onError(e));
  }

  /** Turn-complete cue: A5 → E6, ~300ms, exponential decay. No asset, obeys the gain chain. */
  chime(onDone: () => void): void {
    this.ensureGraph();
    if (!this.ctx || !this.gain) {
      onDone();
      return;
    }
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const notes: Array<[number, number]> = [
      [880.0, 0], // A5
      [1318.5, 0.1], // E6, 100ms later — 40ms overlap
    ];
    for (const [freq, at] of notes) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0.0001, t0 + at);
      env.gain.exponentialRampToValueAtTime(0.35, t0 + at + 0.02);
      env.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.22);
      osc.connect(env);
      env.connect(this.gain);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.24);
    }
    setTimeout(onDone, 340);
  }

  /** Attention cue: three quick C6 pings, ~450ms — unmistakably different
   * from the rising turn chime. Fire-and-forget: oscillators ring over any
   * ongoing narration; no queue participation, nothing waits on it.
   * Routed to the master gain, NOT the provider boostNode — corrections
   * never color cues. */
  attentionPing(): void {
    this.ensureGraph();
    if (!this.ctx || !this.gain) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    for (const at of [0, 0.15, 0.3]) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 1046.5; // C6
      env.gain.setValueAtTime(0.0001, t0 + at);
      env.gain.exponentialRampToValueAtTime(0.35, t0 + at + 0.015);
      env.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.12);
      osc.connect(env);
      env.connect(this.gain);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.14);
    }
  }

  pause(): void {
    this.el.pause();
  }

  resume(): void {
    this.ensureGraph();
    // Only meaningful mid-track; a finished or stopped element has nothing to resume.
    if (this.el.src && !this.el.ended && this.el.paused) {
      void this.el.play().catch(() => {});
    }
  }

  stop(): void {
    this.el.pause();
    this.el.onended = null;
    this.el.onerror = null;
    this.el.removeAttribute("src");
    this.el.load();
  }

  /** Played fraction of the current track; null when there is nothing to measure. */
  progress(): number | null {
    const el = this.el;
    return Number.isFinite(el.duration) && el.duration > 0
      ? Math.min(1, el.currentTime / el.duration)
      : null;
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  setRate(r: number): void {
    this.rate = Math.min(2, Math.max(0.5, r));
    this.el.playbackRate = this.effectiveRate();
  }

  /** Engine-driven, from the active provider. Applies mid-track too. */
  setProviderBoost(b: ProviderBoost): void {
    this.boost = b;
    this.el.playbackRate = this.effectiveRate();
    if (this.boostNode) this.boostNode.gain.value = b.gain;
  }

  /** playbackRate must stay in the user-visible envelope even boosted. */
  private effectiveRate(): number {
    return Math.min(2, this.rate * this.boost.rate);
  }
}
