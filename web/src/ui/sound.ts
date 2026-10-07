/**
 * The city's sound (M6e), generated in the browser with Web Audio, no recordings: the hum
 * of the traffic near the view (louder the more vehicles there are, brighter the faster
 * they go), trams' rumble and bells, and rain. Off until the player turns it on (browsers
 * only let pages make sound after a click).
 */

export interface SoundScene {
  /** Vehicles within earshot of the point looked at, and their mean speed (m/s). */
  vehicles: number;
  speed: number;
  trams: number;
  /** Rain falling (0-1), snow muffling (0-1). */
  rain: number;
  snow: number;
  /** View height (m): further out, quieter. */
  viewHeight: number;
}

export interface SoundLevels {
  /** Gains (0-1) of the traffic hum, the trams' rumble and the rain. */
  hum: number;
  rumble: number;
  rain: number;
  /** Low-pass cut-off of the hum (Hz): faster traffic sounds brighter. */
  cutoff: number;
  /** Chance of a tram bell in the next second. */
  bell: number;
}

/** Sound fades out between these view heights (m). */
const NEAR = 200;
const FAR = 3000;

/** How loud each sound is for a scene (pure, so it can be tested). */
export function soundLevels(s: SoundScene): SoundLevels {
  const near = 1 - Math.min(1, Math.max(0, (s.viewHeight - NEAR) / (FAR - NEAR)));
  const muffle = 1 - 0.4 * s.snow;
  // Loudness grows with the number of sources: roughly their square root.
  const hum = Math.min(1, Math.sqrt(s.vehicles) / 12) * near * muffle;
  const rumble = Math.min(1, s.trams / 3) * near * muffle * 0.8;
  return {
    hum,
    rumble,
    rain: s.rain * (0.3 + 0.7 * near),
    cutoff: 250 + Math.min(14, Math.max(0, s.speed)) * 60,
    bell: s.trams > 0 && near > 0.3 ? Math.min(0.15, 0.05 * s.trams) : 0,
  };
}

/** A second of noise: brown for traffic (deep), white for rain. */
function noiseBuffer(context: AudioContext, brown: boolean): AudioBuffer {
  const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    } else {
      data[i] = white;
    }
  }
  return buffer;
}

export class CitySound {
  private context?: AudioContext;
  private humGain?: GainNode;
  private humFilter?: BiquadFilterNode;
  private rumbleGain?: GainNode;
  private rainGain?: GainNode;
  private master?: GainNode;
  private lastBell = 0;
  enabled = false;
  /** The levels last set (for tests). */
  levels?: SoundLevels;

  /** Turn the sound on (from a click) or off. */
  async setEnabled(on: boolean): Promise<void> {
    this.enabled = on;
    if (on && !this.context) this.build();
    if (!this.context) return;
    if (on) await this.context.resume();
    else await this.context.suspend();
  }

  get state(): string {
    return this.context?.state ?? 'none';
  }

  private build(): void {
    const ctx = new AudioContext();
    this.context = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(ctx.destination);
    const loop = (buffer: AudioBuffer) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.start();
      return source;
    };
    // Traffic: brown noise through a low-pass filter.
    this.humFilter = ctx.createBiquadFilter();
    this.humFilter.type = 'lowpass';
    this.humFilter.frequency.value = 400;
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    loop(noiseBuffer(ctx, true)).connect(this.humFilter).connect(this.humGain).connect(this.master);
    // Trams: a low rumble, brown noise band-passed around 90 Hz.
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'bandpass';
    rumbleFilter.frequency.value = 90;
    rumbleFilter.Q.value = 1.5;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    loop(noiseBuffer(ctx, true))
      .connect(rumbleFilter)
      .connect(this.rumbleGain)
      .connect(this.master);
    // Rain: white noise above 1 kHz.
    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = 'highpass';
    rainFilter.frequency.value = 1200;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    loop(noiseBuffer(ctx, false)).connect(rainFilter).connect(this.rainGain).connect(this.master);
  }

  /** A tram's bell: two bright partials, struck twice. */
  private bell(): void {
    const ctx = this.context;
    if (!ctx || !this.master) return;
    for (const delay of [0, 0.28]) {
      for (const [f, level] of [
        [1480, 0.18],
        [2220, 0.09],
      ]) {
        const osc = ctx.createOscillator();
        osc.frequency.value = f;
        const gain = ctx.createGain();
        const t = ctx.currentTime + delay;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(level, t + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        osc.connect(gain).connect(this.master);
        osc.start(t);
        osc.stop(t + 1);
      }
    }
  }

  /** Follow the scene (called every frame; changes are smoothed over a few tenths of a
   * second). */
  update(scene: SoundScene, now = performance.now()): void {
    if (!this.enabled || !this.context || this.context.state !== 'running') return;
    const levels = soundLevels(scene);
    this.levels = levels;
    const t = this.context.currentTime;
    this.humGain!.gain.setTargetAtTime(levels.hum * 0.5, t, 0.4);
    this.humFilter!.frequency.setTargetAtTime(levels.cutoff, t, 0.6);
    this.rumbleGain!.gain.setTargetAtTime(levels.rumble * 0.6, t, 0.5);
    this.rainGain!.gain.setTargetAtTime(levels.rain * 0.12, t, 0.5);
    // Bells now and then while trams are near (checked about once a second).
    if (now - this.lastBell > 1000) {
      this.lastBell = now;
      if (Math.random() < levels.bell) this.bell();
    }
  }
}
