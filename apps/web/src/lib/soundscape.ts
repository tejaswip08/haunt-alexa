/**
 * Procedural horror ambience, synthesized with the Web Audio API so every sound is
 * original. Each scene's mood sets the mix, its sound cues add accents, and the whole
 * bed ducks under the narrator.
 */

type Layer = "drone" | "wind" | "pulse" | "tick" | "drips" | "shimmer";
type Mix = Record<Layer, number>;

const SILENT: Mix = { drone: 0, wind: 0, pulse: 0, tick: 0, drips: 0, shimmer: 0 };

const MOODS: Record<string, Mix> = {
  calm: { ...SILENT, drone: 0.25, wind: 0.15 },
  uneasy: { ...SILENT, drone: 0.45, wind: 0.25, shimmer: 0.05 },
  suspense: { ...SILENT, drone: 0.5, wind: 0.15, tick: 0.35 },
  exploration: { ...SILENT, drone: 0.35, wind: 0.45, drips: 0.2 },
  threat: { ...SILENT, drone: 0.7, wind: 0.2, pulse: 0.6 },
  revelation: { ...SILENT, drone: 0.55, shimmer: 0.35 },
  ending: { ...SILENT, drone: 0.2, wind: 0.1, shimmer: 0.15 },
};

/** Sound-cue keywords from the Story Director that bring a layer forward for one scene. */
const CUES: [RegExp, Layer, number][] = [
  [/wind|gust|breeze|howl/i, "wind", 0.6],
  [/heart|pulse|breath/i, "pulse", 0.5],
  [/tick|clock|watch/i, "tick", 0.4],
  [/drip|water|rain|leak/i, "drips", 0.45],
  [/chime|bell|music box|choir|hum/i, "shimmer", 0.3],
];

const VOLUME = 0.32;
const DUCKED = 0.35; // share of the volume kept while the narrator speaks
const FADE_SECONDS = 2.5;

class Soundscape {
  #ctx?: AudioContext;
  #master?: GainNode;
  #layers = new Map<Layer, GainNode>();
  #target: Mix = SILENT;
  #timer?: number;
  #next = { pulse: 0, tick: 0, drips: 0 };
  #pulseBpm = 66;
  #enabled = true;
  #ducked = false;

  get enabled() {
    return this.#enabled;
  }

  /** Call from a user gesture: browsers only start audio after one. */
  unlock() {
    if (!this.#enabled) return;
    if (!this.#ctx) this.#build();
    void this.#ctx?.resume();
  }

  setEnabled(enabled: boolean) {
    this.#enabled = enabled;
    if (enabled) {
      this.unlock();
      this.#applyVolume();
    } else if (this.#master && this.#ctx) {
      this.#master.gain.setTargetAtTime(0, this.#ctx.currentTime, 0.2);
    }
  }

  /** Crossfade to a scene's mood, with its sound cues as accents. */
  setScene(mood: string, cues: string[] = []) {
    const mix = { ...(MOODS[mood] ?? MOODS.uneasy!) };
    for (const cue of cues) {
      for (const [pattern, layer, level] of CUES) if (pattern.test(cue)) mix[layer] = Math.max(mix[layer], level);
    }
    this.#pulseBpm = mood === "threat" ? 84 : 66;
    this.#target = mix;
    if (mood === "revelation") this.#sting();
    this.#applyMix();
  }

  /** Lower the ambience while the narrator speaks. */
  duck(on: boolean) {
    this.#ducked = on;
    this.#applyVolume();
  }

  stop() {
    this.#target = SILENT;
    this.#applyMix();
  }

  #applyMix() {
    const ctx = this.#ctx;
    if (!ctx) return;
    for (const [layer, gain] of this.#layers) {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setTargetAtTime(this.#target[layer], ctx.currentTime, FADE_SECONDS / 3);
    }
  }

  #applyVolume() {
    const ctx = this.#ctx;
    if (!ctx || !this.#master || !this.#enabled) return;
    this.#master.gain.setTargetAtTime(this.#ducked ? VOLUME * DUCKED : VOLUME, ctx.currentTime, 0.25);
  }

  #build() {
    const ctx = new AudioContext({ latencyHint: "playback" });
    this.#ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    this.#master = master;
    for (const layer of Object.keys(SILENT) as Layer[]) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(master);
      this.#layers.set(layer, gain);
    }
    this.#buildDrone();
    this.#buildWind();
    this.#buildShimmer();
    this.#timer = window.setInterval(() => this.#schedule(), 50);
    this.#applyVolume();
    this.#applyMix();
  }

  #lfo(frequency: number, depth: number, target: AudioParam) {
    const ctx = this.#ctx!;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = frequency;
    const amount = ctx.createGain();
    amount.gain.value = depth;
    lfo.connect(amount).connect(target);
    lfo.start();
  }

  /** Two detuned saws and a sub, through a slowly breathing low-pass filter. */
  #buildDrone() {
    const ctx = this.#ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 170;
    filter.Q.value = 5;
    this.#lfo(0.05, 70, filter.frequency);
    for (const [type, frequency, level] of [
      ["sawtooth", 55, 0.35],
      ["sawtooth", 55.37, 0.35],
      ["sine", 27.5, 0.6],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = frequency;
      const gain = ctx.createGain();
      gain.gain.value = level;
      osc.connect(gain).connect(filter);
      osc.start();
    }
    filter.connect(this.#layers.get("drone")!);
  }

  /** Brown noise through a wandering band-pass. */
  #buildWind() {
    const ctx = this.#ctx!;
    const source = ctx.createBufferSource();
    source.buffer = this.#noise(6, true);
    source.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 420;
    band.Q.value = 0.7;
    this.#lfo(0.07, 260, band.frequency);
    const swell = ctx.createGain();
    swell.gain.value = 0.7;
    this.#lfo(0.11, 0.3, swell.gain);
    source.connect(band).connect(swell).connect(this.#layers.get("wind")!);
    source.start();
  }

  /** A high minor second that beats slowly: the "something is wrong" note. */
  #buildShimmer() {
    const ctx = this.#ctx!;
    const tremolo = ctx.createGain();
    tremolo.gain.value = 0.5;
    this.#lfo(0.3, 0.3, tremolo.gain);
    for (const frequency of [1760, 1864.7]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = frequency;
      const gain = ctx.createGain();
      gain.gain.value = 0.05;
      osc.connect(gain).connect(tremolo);
      osc.start();
    }
    tremolo.connect(this.#layers.get("shimmer")!);
  }

  #noise(seconds: number, brown: boolean): AudioBuffer {
    const ctx = this.#ctx!;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
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

  /** Look-ahead scheduler for the rhythmic layers, so timing stays tight. */
  #schedule() {
    const ctx = this.#ctx;
    if (!ctx || ctx.state !== "running") return;
    const horizon = ctx.currentTime + 0.2;
    if (this.#target.pulse > 0) {
      if (this.#next.pulse < ctx.currentTime) this.#next.pulse = ctx.currentTime + 0.05;
      while (this.#next.pulse < horizon) {
        this.#thump(this.#next.pulse, 1);
        this.#thump(this.#next.pulse + 0.2, 0.7);
        this.#next.pulse += 60 / this.#pulseBpm;
      }
    }
    if (this.#target.tick > 0) {
      if (this.#next.tick < ctx.currentTime) this.#next.tick = ctx.currentTime + 0.05;
      while (this.#next.tick < horizon) {
        this.#click(this.#next.tick);
        this.#next.tick += 1;
      }
    }
    if (this.#target.drips > 0) {
      if (this.#next.drips < ctx.currentTime) this.#next.drips = ctx.currentTime + 0.5 + Math.random() * 2;
      while (this.#next.drips < horizon) {
        this.#drip(this.#next.drips);
        this.#next.drips += 1.5 + Math.random() * 3;
      }
    }
  }

  #thump(at: number, level: number) {
    const ctx = this.#ctx!;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(62, at);
    osc.frequency.exponentialRampToValueAtTime(38, at + 0.15);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(level, at + 0.008);
    env.gain.exponentialRampToValueAtTime(0.001, at + 0.18);
    osc.connect(env).connect(this.#layers.get("pulse")!);
    osc.start(at);
    osc.stop(at + 0.2);
  }

  #click(at: number) {
    const ctx = this.#ctx!;
    const source = ctx.createBufferSource();
    source.buffer = this.#noise(0.03, false);
    const high = ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 2800;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.6, at);
    env.gain.exponentialRampToValueAtTime(0.001, at + 0.025);
    source.connect(high).connect(env).connect(this.#layers.get("tick")!);
    source.start(at);
  }

  #drip(at: number) {
    const ctx = this.#ctx!;
    const osc = ctx.createOscillator();
    const start = 900 + Math.random() * 600;
    osc.frequency.setValueAtTime(start, at);
    osc.frequency.exponentialRampToValueAtTime(start / 2.2, at + 0.08);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.4, at);
    env.gain.exponentialRampToValueAtTime(0.001, at + 0.12);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    osc.connect(env).connect(pan).connect(this.#layers.get("drips")!);
    osc.start(at);
    osc.stop(at + 0.15);
  }

  /** A dissonant swell for revelations. */
  #sting() {
    const ctx = this.#ctx;
    if (!ctx || !this.#master) return;
    const at = ctx.currentTime + 0.05;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.35, at + 1.2);
    env.gain.exponentialRampToValueAtTime(0.001, at + 4);
    env.connect(this.#master);
    for (const frequency of [110, 116.5, 164.8, 233]) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = frequency;
      osc.connect(env);
      osc.start(at);
      osc.stop(at + 4.1);
    }
  }
}

export const soundscape = new Soundscape();
