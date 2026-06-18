/**
 * Playback clock. Maps real wall-clock progression onto the game's
 * [startTime, endTime] window, compressed into `durationSec` of video. Supports
 * play/pause, speed multipliers, scrubbing and looping.
 */
export class Clock {
  readonly startTime: number;
  readonly endTime: number;
  /** base video length in seconds at 1x (before speed multiplier). */
  durationSec: number;
  speed = 1;
  playing = true;
  loop = true;
  /** 0..1 progress through the game window. */
  private progress = 0;

  constructor(startTime: number, endTime: number, durationSec = 75) {
    this.startTime = startTime;
    this.endTime = endTime;
    this.durationSec = durationSec;
  }

  /** Advance by real dt (seconds). Returns current game-time (ms). */
  tick(dtSec: number): number {
    if (this.playing) {
      this.progress += (dtSec * this.speed) / this.durationSec;
      if (this.progress >= 1) {
        if (this.loop) this.progress = 0;
        else {
          this.progress = 1;
          this.playing = false;
        }
      }
    }
    return this.gameTime();
  }

  gameTime(): number {
    return this.startTime + this.progress * (this.endTime - this.startTime);
  }

  getProgress(): number {
    return this.progress;
  }

  setProgress(p: number) {
    this.progress = Math.min(1, Math.max(0, p));
  }

  togglePlay() {
    if (!this.playing && this.progress >= 1) this.progress = 0;
    this.playing = !this.playing;
  }

  atEnd(): boolean {
    return this.progress >= 1;
  }
}
