/**
 * Project Hyperion — procedural WebAudio SFX engine (Task 2-b).
 *
 * Zero audio assets, zero network: every sound is synthesized live from
 * oscillators and one cached white-noise buffer. SSR-safe: nothing touches
 * `window` or `AudioContext` at import time — the context is created lazily
 * inside unlock(), which must be called from a user-gesture handler. Every
 * public method is guarded and wrapped in try/catch so audio failures can
 * never crash the game loop.
 */
export class HyperionAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  // Persistent engine-loop nodes (created by startEngine, killed by stopEngine).
  private engOsc: OscillatorNode | null = null;
  private engSub: OscillatorNode | null = null;
  private engGain: GainNode | null = null;

  constructor() {}

  // ------------------------------------------------------------------ core

  /** Create/resume AudioContext (call from a user gesture handler). Safe to call repeatedly. */
  unlock(): void {
    try {
      if (typeof window === 'undefined') return;
      if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor(), master = ctx.createGain();
      master.gain.value = 0.8;
      master.connect(ctx.destination);
      // Cached 1s white-noise buffer, created exactly once.
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.ctx = ctx; this.master = master; this.noiseBuf = buf;
    } catch {
      /* audio unavailable — stay silent forever */
    }
  }

  setMasterVolume(v: number): void {
    try {
      if (!this.ctx || !this.master) return;
      this.master.gain.setTargetAtTime(v < 0 ? 0 : v > 1 ? 1 : v, this.ctx.currentTime, 0.02);
    } catch { /* noop */ }
  }

  // --------------------------------------------------------------- helpers

  /** Looping white-noise source starting at currentTime + at, auto-stopped after dur. */
  private noise(dur: number, at = 0): AudioBufferSourceNode | null {
    if (!this.ctx || !this.noiseBuf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const t0 = this.ctx.currentTime + at;
    src.start(t0, Math.random() * 0.9);
    src.stop(t0 + dur);
    return src;
  }

  /** Attack/decay envelope on a gain node: ~0 -> peak over a seconds, -> ~0 over d seconds. */
  private env(g: GainNode, t0: number, a: number, d: number, peak: number): void {
    const p = g.gain;
    p.setValueAtTime(0.0001, t0);
    p.linearRampToValueAtTime(Math.max(0.0001, peak), t0 + a);
    p.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  }

  /** Distance 0..1 (0 = near, 1 = ~80m+) mapped to a gain scalar 1..0.06. */
  private farGain(far: number): number {
    const f = far < 0 ? 0 : far > 1 ? 1 : far;
    return 1 - f * 0.94;
  }

  private filter(type: BiquadFilterType, freq: number, q = 0): BiquadFilterNode | null {
    if (!this.ctx) return null;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q) f.Q.value = q;
    return f;
  }

  private osc(type: OscillatorType, freq: number): OscillatorNode | null {
    if (!this.ctx) return null;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return o;
  }

  /** Connect nodes left-to-right; if toMaster, also connect the last node to master. */
  private chain(nodes: (AudioNode | null)[], toMaster = true): void {
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i], b = nodes[i + 1];
      if (a && b) a.connect(b);
    }
    const last = nodes[nodes.length - 1];
    if (toMaster && last && this.master) last.connect(this.master);
  }

  /** One-shot noise burst: white noise -> biquad -> (soft-clip) -> env gain -> master. */
  private burst(o: { dur: number; at?: number; type: BiquadFilterType; f0: number; f1?: number; sweep?: number; q?: number; a: number; d: number; peak: number; distort?: boolean }): void {
    try {
      if (!this.ctx || !this.master) return;
      const src = this.noise(o.dur, o.at), f = this.filter(o.type, o.f0, o.q), g = this.ctx.createGain();
      if (!src || !f) return;
      const t0 = this.ctx.currentTime + (o.at ?? 0);
      if (o.f1 !== undefined && o.sweep !== undefined) f.frequency.exponentialRampToValueAtTime(o.f1, t0 + o.sweep);
      let tail: AudioNode = f;
      if (o.distort) {
        const ws = this.ctx.createWaveShaper(), curve = new Float32Array(257);
        for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(x * 2.5); }
        ws.curve = curve;
        f.connect(ws);
        tail = ws;
      }
      this.env(g, t0, o.a, o.d, o.peak);
      src.connect(f); tail.connect(g); g.connect(this.master);
    } catch { /* noop */ }
  }

  /** One-shot tone: osc -> (lowpass) -> env gain -> master; optional freq sweep. */
  private tone(o: { type: OscillatorType; f0: number; f1?: number; sweep?: number; a: number; d: number; peak: number; lp?: number }): void {
    try {
      if (!this.ctx || !this.master) return;
      const osc = this.osc(o.type, o.f0), g = this.ctx.createGain();
      if (!osc) return;
      const t0 = this.ctx.currentTime;
      if (o.f1 !== undefined && o.sweep !== undefined) osc.frequency.exponentialRampToValueAtTime(o.f1, t0 + o.sweep);
      let tail: AudioNode = osc;
      if (o.lp) {
        const f = this.filter('lowpass', o.lp);
        if (f) { osc.connect(f); tail = f; }
      }
      this.env(g, t0, o.a, o.d, o.peak);
      tail.connect(g); g.connect(this.master);
      osc.start(t0); osc.stop(t0 + o.a + o.d + 0.03);
    } catch { /* noop */ }
  }

  // ---------------------------------------------------------------- events

  /** Big explosion: noise burst lowpass sweep 900->60Hz ~1.1s + sub sine 42Hz decay + soft-clip distortion. */
  boom(far: number): void {
    try {
      if (!this.ctx || !this.master) return;
      const v = this.farGain(far);
      this.burst({ dur: 1.25, type: 'lowpass', f0: 900, f1: 60, sweep: 1.1, q: 0.7, a: 0.008, d: 1.15, peak: 0.9 * v, distort: true });
      this.tone({ type: 'sine', f0: 52, f1: 42, sweep: 0.15, a: 0.012, d: 0.95, peak: 0.8 * v });
    } catch { /* noop */ }
  }

  /** Short pickaxe tick: 50-70ms noise burst, bandpass 700-1400Hz random. */
  dig(): void {
    try {
      if (!this.ctx || !this.master) return;
      this.burst({ dur: 0.07, type: 'bandpass', f0: 700 + Math.random() * 700, q: 1.4, a: 0.002, d: 0.055, peak: 0.4 });
    } catch { /* noop */ }
  }

  /** Crunchier block break: 120ms noise burst bandpass ~350Hz + high sparkle layer. */
  breakBlock(): void {
    try {
      if (!this.ctx || !this.master) return;
      this.burst({ dur: 0.14, type: 'bandpass', f0: 420, f1: 240, sweep: 0.12, q: 0.9, a: 0.004, d: 0.12, peak: 0.55 });
      this.burst({ dur: 0.08, type: 'bandpass', f0: 1600 + Math.random() * 800, a: 0.002, d: 0.07, peak: 0.18 });
    } catch { /* noop */ }
  }

  /** Soft block-place thud: sine 170->70Hz 90ms + tiny click. */
  place(): void {
    try {
      if (!this.ctx || !this.master) return;
      this.tone({ type: 'sine', f0: 170, f1: 70, sweep: 0.09, a: 0.004, d: 0.09, peak: 0.45 });
      this.burst({ dur: 0.015, type: 'highpass', f0: 2000, a: 0.001, d: 0.012, peak: 0.12 });
    } catch { /* noop */ }
  }

  /** Fire whoosh: noise highpass sweep 200->2000Hz over 0.5s. */
  ignite(far: number): void {
    try {
      if (!this.ctx || !this.master) return;
      this.burst({ dur: 0.6, type: 'highpass', f0: 200, f1: 2000, sweep: 0.5, a: 0.12, d: 0.42, peak: 0.4 * this.farGain(far) });
    } catch { /* noop */ }
  }

  /** Car horn: two detuned saw oscillators ~340Hz + ~425Hz, 350ms, lowpassed. */
  horn(far: number): void {
    try {
      if (!this.ctx || !this.master) return;
      const p = 0.22 * this.farGain(far);
      this.tone({ type: 'sawtooth', f0: 340, a: 0.02, d: 0.33, peak: p, lp: 1200 });
      this.tone({ type: 'sawtooth', f0: 425, a: 0.02, d: 0.33, peak: p, lp: 1200 });
    } catch { /* noop */ }
  }

  /** Ender pearl: throw chirp 500->1200Hz 120ms + reverse-whoosh impact (combined). */
  pearl(): void {
    try {
      if (!this.ctx || !this.master) return;
      this.tone({ type: 'sine', f0: 500, f1: 1200, sweep: 0.12, a: 0.01, d: 0.11, peak: 0.25 });
      this.burst({ dur: 0.3, at: 0.12, type: 'bandpass', f0: 300, f1: 2400, sweep: 0.28, q: 1.2, a: 0.16, d: 0.12, peak: 0.3 });
    } catch { /* noop */ }
  }

  /** Eating: 3 quick crunchy noise bites over ~500ms. */
  eat(): void {
    try {
      if (!this.ctx || !this.master) return;
      for (let i = 0; i < 3; i++) this.burst({ dur: 0.07, at: i * 0.19, type: 'bandpass', f0: 400 + Math.random() * 500, q: 1.1, a: 0.004, d: 0.06, peak: 0.32 });
    } catch { /* noop */ }
  }

  /** Player hurt: square osc 240->110Hz 140ms. */
  hurt(): void {
    try {
      if (!this.ctx || !this.master) return;
      this.tone({ type: 'square', f0: 240, f1: 110, sweep: 0.14, a: 0.005, d: 0.135, peak: 0.22 });
    } catch { /* noop */ }
  }

  /** Dull impact (car crash): lowpassed noise 150ms + sine 80Hz. */
  thud(far: number): void {
    try {
      if (!this.ctx || !this.master) return;
      const v = this.farGain(far);
      this.burst({ dur: 0.16, type: 'lowpass', f0: 380, a: 0.004, d: 0.15, peak: 0.6 * v });
      this.tone({ type: 'sine', f0: 95, f1: 80, sweep: 0.12, a: 0.005, d: 0.14, peak: 0.5 * v });
    } catch { /* noop */ }
  }

  /** Car door thunk: sine 95Hz 60ms + click. */
  enterCar(): void {
    try {
      if (!this.ctx || !this.master) return;
      this.tone({ type: 'sine', f0: 120, f1: 95, sweep: 0.06, a: 0.003, d: 0.06, peak: 0.5 });
      this.burst({ dur: 0.02, type: 'highpass', f0: 2500, a: 0.001, d: 0.015, peak: 0.15 });
    } catch { /* noop */ }
  }

  /** Collapse rumble 1.8s: brown-ish noise, lowpass sweeping to 120Hz, slow decay (2 layers). */
  collapse(far: number): void {
    try {
      if (!this.ctx || !this.master) return;
      const v = this.farGain(far);
      this.burst({ dur: 1.9, type: 'lowpass', f0: 220, f1: 120, sweep: 1.0, q: 0.4, a: 0.05, d: 1.75, peak: 0.7 * v });
      this.burst({ dur: 1.9, type: 'lowpass', f0: 120, q: 0.4, a: 0.08, d: 1.72, peak: 0.5 * v });
    } catch { /* noop */ }
  }

  /** Item pickup pop: 600->900Hz. */
  pickup(): void {
    try {
      if (!this.ctx || !this.master) return;
      this.tone({ type: 'sine', f0: 600, f1: 900, sweep: 0.07, a: 0.005, d: 0.07, peak: 0.3 });
    } catch { /* noop */ }
  }

  // ---------------------------------------------------------------- engine

  /** Start the persistent engine loop (call once when entering a vehicle). */
  startEngine(): void {
    try {
      if (!this.ctx || !this.master || this.engOsc) return;
      const t0 = this.ctx.currentTime;
      const lp = this.filter('lowpass', 400), g = this.ctx.createGain(), gs = this.ctx.createGain();
      const o = this.osc('sawtooth', 55), sub = this.osc('sawtooth', 27.5); // half-freq detuned grumble layer
      if (!lp || !o || !sub) return;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.setTargetAtTime(0.028, t0, 0.1);
      sub.detune.value = 8;
      gs.gain.value = 0.5;
      this.chain([o, lp], false);
      this.chain([sub, gs, lp], false);
      this.chain([lp, g]);
      o.start(t0);
      sub.start(t0);
      this.engOsc = o; this.engSub = sub; this.engGain = g;
    } catch { /* noop */ }
  }

  /** Update engine pitch/level every frame. speed01: 0 = idle, 1 = flat out. */
  setEngine(speed01: number): void {
    try {
      if (!this.ctx || !this.engOsc || !this.engSub || !this.engGain) return;
      const s = speed01 < 0 ? 0 : speed01 > 1 ? 1 : speed01, t = this.ctx.currentTime, freq = 55 + s * 130;
      this.engOsc.frequency.setTargetAtTime(freq, t, 0.08);
      this.engSub.frequency.setTargetAtTime(freq * 0.5, t, 0.08);
      this.engGain.gain.setTargetAtTime(0.028 + s * 0.05, t, 0.08);
    } catch { /* noop */ }
  }

  /** Stop the engine loop (call when exiting a vehicle). */
  stopEngine(): void {
    try {
      const { engOsc: o, engSub: sub, engGain: g } = this;
      this.engOsc = null; this.engSub = null; this.engGain = null;
      if (!this.ctx || !o || !sub || !g) return;
      const t = this.ctx.currentTime;
      g.gain.setTargetAtTime(0.0001, t, 0.06);
      o.stop(t + 0.3);
      sub.stop(t + 0.3);
    } catch { /* noop */ }
  }

  // ------------------------------------------------------------------ fire

  /** Call ~every 0.5s while something burns; plays a tiny random crackle with probability 0.6. */
  fireCrackle(far: number): void {
    try {
      if (!this.ctx || !this.master || Math.random() > 0.6) return;
      this.burst({ dur: 0.02 + Math.random() * 0.03, type: 'highpass', f0: 1400 + Math.random() * 1600, a: 0.002, d: 0.03, peak: (0.1 + Math.random() * 0.12) * this.farGain(far) });
    } catch { /* noop */ }
  }

  // --------------------------------------------------------------- cleanup

  dispose(): void {
    try { this.stopEngine(); } catch { /* noop */ }
    try { if (this.ctx) void this.ctx.close(); } catch { /* noop */ }
    this.ctx = null; this.master = null; this.noiseBuf = null;
  }
}
