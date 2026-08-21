// Audio: WebAudio director. Kenney music loops + UI sounds, synthesized water
// and footsteps. Everything is created lazily on the first user gesture
// (browser autoplay policy); `M` toggles mute.

import { isWading } from "@shared/tide";

const ASSETS = {
  music: "assets/audio/music_night_at_the_beach.ogg",
  chime: "assets/audio/egg_chime.ogg",
  select: "assets/audio/ui_select.ogg",
} as const;

export class AudioDirector {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private waterGain: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private muted = false;
  private started = false;

  /** Call from a user-gesture handler; safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);

    await this.loadBuffers();

    // Music loop.
    const musicBuf = this.buffers.get(ASSETS.music);
    if (musicBuf && this.ctx && this.musicGain === null) {
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.5;
      this.musicGain.connect(this.master);
      const src = this.ctx.createBufferSource();
      src.buffer = musicBuf;
      src.loop = true;
      src.connect(this.musicGain);
      src.start();
    }

    // Synthesized surf: filtered noise whose gain follows wading state.
    if (this.ctx && this.master) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.makeNoise(2);
      noise.loop = true;
      const filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 500;
      this.waterGain = this.ctx.createGain();
      this.waterGain.gain.value = 0;
      noise.connect(filter).connect(this.waterGain).connect(this.master);
      noise.start();
    }
  }

  /** Per-frame update: water loudness follows the tide and player state. */
  update(tSec: number, onFloorZero: boolean, moving: boolean): void {
    if (!this.ctx || !this.waterGain) return;
    const target = onFloorZero && isWading(tSec) ? (moving ? 0.35 : 0.22) : 0.04;
    this.waterGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.4);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** UI blip (menu buttons). */
  playSelect(): void {
    void this.play(ASSETS.select, 0.5);
  }

  /** Egg pickup jingle. */
  playChime(): void {
    void this.play(ASSETS.chime, 0.9);
  }

  /** Footstep: short filtered noise tap, pitch varies with stride. */
  playStep(sprinting: boolean): void {
    if (!this.ctx || !this.master || this.muted) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.makeNoise(0.09);
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = sprinting ? 900 : 700;
    filter.Q.value = 1.2;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(sprinting ? 0.5 : 0.3, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.09);
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
  }

  private async play(url: string, volume: number): Promise<void> {
    if (!this.ctx || !this.master || this.muted) return;
    const buf = this.buffers.get(url);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(this.master);
    src.start();
  }

  private async loadBuffers(): Promise<void> {
    if (!this.ctx) return;
    await Promise.all(
      Object.values(ASSETS).map(async (url) => {
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const arr = await res.arrayBuffer();
          const buf = await this.ctx!.decodeAudioData(arr);
          this.buffers.set(url, buf);
        } catch {
          // missing audio must never break the game
        }
      }),
    );
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.ceil(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }
}
