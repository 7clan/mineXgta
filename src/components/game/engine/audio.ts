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
  // Persistent police-siren loop nodes.
  private sirOsc: OscillatorNode | null = null;
  private sirLfo: OscillatorNode | null = null;
  private sirGain: GainNode | null = null;
  // Persistent rain loop (looping noise -> bandpass -> gain).
  private rainSrc: AudioBufferSourceNode | null = null;
  private rainGain: GainNode | null = null;
  private rainLevel = 0;
  // Persistent jetpack-thrust loop (saw osc + looping noise).
  private jetOsc: OscillatorNode | null = null;
  private jetSrc: AudioBufferSourceNode | null = null;
  private jetGain: GainNode | null = null;
  // Car radio: lookahead scheduler state.
  private radioTimer: ReturnType<typeof setInterval> | null = null;
  private radioStep = 0;
  private radioNextT = 0;
  radioStation = 0; // 0 = off, 1..3 = stations

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

  /** Police siren wail: triangle osc 720Hz modulated by a slow sine LFO (±210Hz, 0.42Hz). */
  sirenLoop(): void {
    try {
      if (!this.ctx || !this.master || this.sirOsc) return;
      const t0 = this.ctx.currentTime;
      const o = this.osc('triangle', 720);
      const lfo = this.osc('sine', 0.42);
      const depth = this.ctx.createGain();
      depth.gain.value = 210;
      const g = this.ctx.createGain();
      if (!o || !lfo) return;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.setTargetAtTime(0.042, t0, 0.25);
      lfo.connect(depth);
      depth.connect(o.frequency); // AudioParam modulation
      this.chain([o, g]);
      o.start(t0);
      lfo.start(t0);
      this.sirOsc = o;
      this.sirLfo = lfo;
      this.sirGain = g;
    } catch { /* noop */ }
  }

  /** Fade out and stop the siren loop (when no units are near). */
  stopSiren(): void {
    try {
      if (!this.ctx || !this.sirOsc || !this.sirGain) return;
      const t = this.ctx.currentTime;
      this.sirGain.gain.setTargetAtTime(0.0001, t, 0.12);
      const o = this.sirOsc;
      const lfo = this.sirLfo;
      this.sirOsc = null;
      this.sirLfo = null;
      this.sirGain = null;
      window.setTimeout(() => {
        try {
          o?.stop();
          lfo?.stop();
        } catch { /* noop */ }
      }, 500);
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

  // ------------------------------------------------------------------ jetpack

  /** Jetpack thrust loop: 92Hz saw growl + bandpassed noise roar. on=false fades out. */
  jetThrust(on: boolean): void {
    try {
      if (!on) {
        if (!this.jetGain) return;
        const g = this.jetGain, o = this.jetOsc, s = this.jetSrc, ctx = this.ctx;
        this.jetGain = null; this.jetOsc = null; this.jetSrc = null;
        if (ctx) g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.07);
        window.setTimeout(() => {
          try { o?.stop(); s?.stop(); } catch { /* noop */ }
        }, 420);
        return;
      }
      if (!this.ctx || !this.master || !this.noiseBuf || this.jetGain) return;
      const t0 = this.ctx.currentTime;
      const o = this.osc('sawtooth', 92);
      const lp = this.filter('lowpass', 620);
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const bp = this.filter('bandpass', 850, 0.8);
      const g = this.ctx.createGain();
      if (!o || !lp || !bp) return;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.setTargetAtTime(0.055, t0, 0.06);
      this.chain([o, lp, g]);
      const g2 = this.ctx.createGain();
      g2.gain.setValueAtTime(0.0001, t0);
      g2.gain.setTargetAtTime(0.03, t0, 0.06);
      this.chain([src, bp, g2]);
      o.start(t0);
      src.start(t0);
      this.jetOsc = o;
      this.jetSrc = src;
      this.jetGain = g;
    } catch { /* noop */ }
  }

  // ------------------------------------------------------------------ rain

  /** Start (or re-target) the looping rain bed: broadband noise through a soft bandpass.
   *  intensity 0..1 — 0 fades out and tears the loop down. */
  setRain(intensity: number): void {
    try {
      if (!this.ctx || !this.master || !this.noiseBuf) return;
      const v = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity;
      this.rainLevel = v;
      if (v <= 0.001) {
        this.stopRain();
        return;
      }
      if (!this.rainSrc || !this.rainGain) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.noiseBuf;
        src.loop = true;
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 400;
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 5200;
        const g = this.ctx.createGain();
        g.gain.value = 0.0001;
        this.chain([src, hp, lp, g]);
        src.start(0, Math.random() * 0.9);
        this.rainSrc = src;
        this.rainGain = g;
      }
      const peak = 0.026 + v * 0.075;
      this.rainGain!.gain.setTargetAtTime(peak, this.ctx.currentTime, 0.9);
    } catch { /* noop */ }
  }

  /** Fade out and stop the rain loop. */
  stopRain(): void {
    try {
      const src = this.rainSrc, g = this.rainGain;
      this.rainSrc = null;
      this.rainGain = null;
      this.rainLevel = 0;
      if (!this.ctx || !src || !g) return;
      g.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.5);
      window.setTimeout(() => {
        try { src.stop(); } catch { /* noop */ }
      }, 1600);
    } catch { /* noop */ }
  }

  /** Thunder clap: deep filtered noise rumble with a slow roll-off. */
  thunder(far: number): void {
    try {
      if (!this.ctx || !this.master) return;
      const fg = this.farGain(far);
      const src = this.noise(2.6), lp = this.filter('lowpass', 240, 0.4), g = this.ctx.createGain();
      if (!src || !lp) return;
      const t0 = this.ctx.currentTime;
      lp.frequency.setValueAtTime(300, t0);
      lp.frequency.exponentialRampToValueAtTime(55, t0 + 2.2);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.34 * fg, t0 + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.4);
      this.chain([src, lp, g]);
      // Second delayed roll for realism
      const src2 = this.noise(1.6, 0.5), lp2 = this.filter('lowpass', 130), g2 = this.ctx.createGain();
      if (src2 && lp2 && g2) {
        const t1 = t0 + 0.5;
        g2.gain.setValueAtTime(0.0001, t1);
        g2.gain.linearRampToValueAtTime(0.2 * fg, t1 + 0.12);
        g2.gain.exponentialRampToValueAtTime(0.0001, t1 + 1.5);
        this.chain([src2, lp2, g2]);
      }
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

  // ------------------------------------------------------------------ radio

  /** Car radio station definitions (seeded procedural chiptune). */
  static readonly STATIONS = [
    { name: 'RADIO OFF', bpm: 0 },
    { name: 'HYP FM 101.3', bpm: 128 },
    { name: 'MIDNIGHT 84.5', bpm: 82 },
    { name: 'VOXEL HARDWARE', bpm: 152 },
  ];

  /** Start the car radio at a station (or advance into station 1). */
  startRadio(station = 1): void {
    try {
      if (!this.ctx || !this.master) return;
      this.stopRadio();
      this.radioStation = Math.max(1, Math.min(3, station));
      this.radioStep = 0;
      this.radioNextT = this.ctx.currentTime + 0.08;
      this.radioTimer = setInterval(() => this.radioScheduler(), 50);
    } catch { /* noop */ }
  }

  /** Stop the radio scheduler. */
  stopRadio(): void {
    try {
      if (this.radioTimer !== null) {
        clearInterval(this.radioTimer);
        this.radioTimer = null;
      }
    } catch { /* noop */ }
  }

  /** Cycle station; returns the new station name. 0 = off. */
  cycleRadio(): string {
    try {
      this.radioStation = (this.radioStation + 1) % HyperionAudio.STATIONS.length;
      if (this.radioStation === 0) {
        this.stopRadio();
        return HyperionAudio.STATIONS[0].name;
      }
      this.startRadio(this.radioStation);
      return HyperionAudio.STATIONS[this.radioStation].name;
    } catch {
      return HyperionAudio.STATIONS[0].name;
    }
  }

  /** Lookahead scheduler: queues 16th-notes ~0.18s ahead. */
  private radioScheduler(): void {
    try {
      if (!this.ctx) return;
      const st = HyperionAudio.STATIONS[this.radioStation];
      if (!st || st.bpm <= 0) return;
      const stepDur = 60 / st.bpm / 4; // 16th note
      while (this.radioNextT < this.ctx.currentTime + 0.18) {
        this.scheduleRadioStep(this.radioStep, this.radioNextT, stepDur, this.radioStation);
        this.radioStep = (this.radioStep + 1) % 64;
        this.radioNextT += stepDur;
      }
    } catch { /* noop */ }
  }

  /** Absolute-time note (radio scheduler needs future-time scheduling). */
  private radioNote(type: OscillatorType, f0: number, t0: number, dur: number, peak: number, lp?: number): void {
    try {
      if (!this.ctx || !this.master) return;
      const o = this.osc(type, f0), g = this.ctx.createGain();
      if (!o) return;
      const p = g.gain;
      p.setValueAtTime(0.0001, t0);
      p.linearRampToValueAtTime(peak, t0 + 0.012);
      p.setValueAtTime(peak, t0 + Math.max(0.013, dur - 0.05));
      p.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.02);
      let tail: AudioNode = o;
      if (lp) {
        const f = this.filter('lowpass', lp);
        if (f) { o.connect(f); tail = f; }
      }
      tail.connect(g);
      g.connect(this.master);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    } catch { /* noop */ }
  }

  /** Absolute-time hat/shaker from the cached noise buffer. */
  private radioHat(t0: number, peak: number, open: boolean): void {
    try {
      if (!this.ctx || !this.master || !this.noiseBuf) return;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const f = this.filter('highpass', 6500);
      const g = this.ctx.createGain();
      if (!f) return;
      const dur = open ? 0.09 : 0.03;
      g.gain.setValueAtTime(peak, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(t0, Math.random() * 0.9);
      src.stop(t0 + dur + 0.02);
    } catch { /* noop */ }
  }

  /** One 16th-step of the station's pattern: bass / lead / hats / pad. */
  private scheduleRadioStep(step: number, t0: number, stepDur: number, station: number): void {
    try {
      if (station === 1) {
        // HYP FM: upbeat major-pentatonic square lead + triangle bass + offbeat hats
        const C = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
        const bassRoot = [65.41, 65.41, 87.31, 98.0][Math.floor(step / 16) % 4];
        if (step % 2 === 0) this.radioNote('triangle', bassRoot, t0, stepDur * 1.8, 0.16);
        if (step % 4 === 2) this.radioHat(t0, 0.1, false);
        if (step % 8 === 4) this.radioHat(t0, 0.13, true);
        const mel = [0, 2, 4, 5, 4, 2, 5, 4, 0, 2, 5, 4, 2, 4, 5, 2];
        if (step % 2 === 0) {
          const n = C[mel[(step / 2) % 16]] * (step >= 32 ? 1.5 : 1);
          this.radioNote('square', n, t0, stepDur * 1.6, 0.07, 3200);
        }
      } else if (station === 2) {
        // MIDNIGHT: slow dreamy minor, sine lead + soft bass, sparse hats
        const Am = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0];
        const bassRoot = [55.0, 55.0, 61.74, 49.0][Math.floor(step / 16) % 4];
        if (step % 8 === 0) this.radioNote('triangle', bassRoot, t0, stepDur * 7, 0.15);
        if (step % 8 === 4) this.radioHat(t0, 0.05, false);
        const mel = [0, 3, 2, 4, 3, 5, 4, 2];
        if (step % 8 === 0) {
          const n = Am[mel[Math.floor(step / 8) % 8]];
          this.radioNote('sine', n, t0, stepDur * 6, 0.09, 2400);
          this.radioNote('sine', n * 2, t0 + stepDur, stepDur * 4, 0.035, 2400);
        }
      } else {
        // VOXEL HARDWARE: aggressive saw riff + driving bass + every-16th hats
        const Ph = [146.83, 155.56, 174.61, 185.0, 196.0, 220.0];
        const bassRoot = [36.71, 36.71, 32.70, 38.89][Math.floor(step / 16) % 4];
        this.radioNote('sawtooth', bassRoot * 2, t0, stepDur * 0.9, 0.14, 900);
        if (step % 2 === 0) this.radioNote('sawtooth', bassRoot, t0, stepDur, 0.16, 600);
        this.radioHat(t0, step % 4 === 0 ? 0.12 : 0.06, false);
        const riff = [0, 0, 2, 0, 4, 0, 5, 4];
        if (step % 2 === 0) {
          const n = Ph[riff[(step / 2) % 8]] * (Math.floor(step / 16) % 2 === 1 ? 1.189 : 1);
          this.radioNote('square', n, t0, stepDur * 0.85, 0.075, 4200);
        }
      }
    } catch { /* noop */ }
  }

  // --------------------------------------------------------------- cleanup

  dispose(): void {
    try { this.stopEngine(); } catch { /* noop */ }
    try { this.stopSiren(); } catch { /* noop */ }
    try { this.stopRain(); } catch { /* noop */ }
    try { this.stopRadio(); } catch { /* noop */ }
    try { this.jetThrust(false); } catch { /* noop */ }
    try { if (this.ctx) void this.ctx.close(); } catch { /* noop */ }
    this.ctx = null; this.master = null; this.noiseBuf = null;
  }
}
