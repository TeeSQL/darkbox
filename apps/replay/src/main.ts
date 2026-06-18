/**
 * Replay app entry. Loads a replay bundle (served `replay.json`, else a
 * deterministic in-browser mock), wires the cinematic Scene to a playback Clock,
 * and drives a requestAnimationFrame render loop with transport controls.
 */
import { Clock } from './engine/clock.js';
import { World } from './engine/world.js';
import { Scene } from './render/scene.js';
import { generateMockBundle } from './mock.js';
import type { ReplayBundle } from './types.js';
import { elapsed } from './util.js';

async function loadBundle(): Promise<ReplayBundle> {
  try {
    const res = await fetch('./replay.json', { cache: 'no-cache' });
    if (res.ok) return (await res.json()) as ReplayBundle;
  } catch {
    /* fall through to mock */
  }
  return generateMockBundle();
}

async function main() {
  const bundle = await loadBundle();
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const world = new World(bundle);
  const clock = new Clock(bundle.meta.startTime, bundle.meta.endTime, 78);
  // Play once, then hold on the final frame (no loop).
  clock.loop = false;
  const scene = new Scene(canvas, world, clock);

  const playBtn = document.getElementById('play') as HTMLButtonElement;
  const scrub = document.getElementById('scrub') as HTMLInputElement;
  const speedBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-speed]'));
  const clockLabel = document.getElementById('clock-label') as HTMLElement;

  let scrubbing = false;

  const updatePlayIcon = () => {
    playBtn.textContent = clock.playing ? '⏸' : '▶';
  };

  playBtn.addEventListener('click', () => {
    clock.togglePlay();
    updatePlayIcon();
  });

  scrub.addEventListener('input', () => {
    scrubbing = true;
    clock.setProgress(Number(scrub.value) / 1000);
  });
  scrub.addEventListener('change', () => {
    scrubbing = false;
  });

  for (const b of speedBtns) {
    b.addEventListener('click', () => {
      clock.speed = Number(b.dataset.speed);
      speedBtns.forEach((x) => x.classList.toggle('active', x === b));
    });
  }
  speedBtns.find((b) => b.dataset.speed === '1')?.classList.add('active');

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      clock.togglePlay();
      updatePlayIcon();
    }
  });

  window.addEventListener('resize', () => scene.resize());

  let last = performance.now();
  function frame(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const t = scrubbing ? clock.gameTime() : clock.tick(dt);
    world.seek(t);
    scene.render(t, dt);
    if (!scrubbing) scrub.value = String(Math.round(clock.getProgress() * 1000));
    clockLabel.textContent = `T+${elapsed(t, bundle.meta.startTime)}`;
    updatePlayIcon();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // expose for debugging
  (window as unknown as Record<string, unknown>).__replay = { world, clock, bundle };
}

main();
