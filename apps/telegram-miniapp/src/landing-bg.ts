import * as THREE from 'three';

/**
 * Landing background — a very slight, brand-coloured field that only wakes once
 * the mic is granted. Soft drifting fbm clouds over the void (maroon bruise →
 * violet pockets → cold edge) with a fine vertical brushed grain. It should
 * read as "something is moving, but you can't see who or what" — never a shape,
 * never loud.
 *
 * Lightweight by design: one fullscreen quad, rendered at a downscaled buffer,
 * capped pixel ratio, and the rAF loop only runs while the landing view is
 * active, the mic is on, and the tab is visible.
 */

const landing = document.querySelector<HTMLElement>('#v-landing');
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const BUFFER_SCALE = 0.6; // render below CSS size; the blur hides it, the GPU thanks you

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.OrthographicCamera | null = null;
let material: THREE.ShaderMaterial | null = null;
let canvas: HTMLCanvasElement | null = null;
let raf = 0;
let lastT = 0;
let micOn = false;
let running = false;

const fragmentShader = `
  precision mediump float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uRes;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
    return v;
  }

  void main() {
    vec2 uv = vUv;
    vec2 p = uv * vec2(uRes.x / uRes.y, 1.0);
    float t = uTime * 0.025;

    // domain-warped, slow-drifting field — no edges, no shapes
    vec2 q = vec2(fbm(p * 1.3 + vec2(0.0, t)), fbm(p * 1.3 + vec2(5.2, -t * 0.8)));
    float n = fbm(p * 1.6 + q * 1.1 + vec2(t * 0.5, t * 0.2));

    vec3 cVoid   = vec3(0.039, 0.039, 0.059); // #0a0a0f
    vec3 cBruise = vec3(0.16, 0.05, 0.10);    // deep maroon bruise
    vec3 cViolet = vec3(0.545, 0.482, 1.0);   // #8b7bff — only in the bright pockets
    vec3 cCool   = vec3(0.11, 0.12, 0.22);    // cold blue at the edge

    vec3 col = cVoid;
    col = mix(col, cBruise, smoothstep(0.24, 0.74, n));
    col = mix(col, cViolet, smoothstep(0.56, 0.96, n) * 0.7);
    col = mix(col, cCool, smoothstep(0.50, 0.90, fbm(p * 0.8 - t)) * 0.30);

    // fine vertical brushed grain
    float grain = hash(vec2(floor(uv.x * uRes.x * 0.5), 3.0));
    col *= 0.93 + 0.07 * grain;
    col *= 0.97 + 0.03 * sin(uv.x * uRes.x * 0.55);

    // cold vignette
    float vig = smoothstep(1.25, 0.25, length(uv - 0.5));
    col *= mix(0.78, 1.0, vig);

    // alpha from brightness: the void stays page-transparent, only glow shows
    float b = max(col.r, max(col.g, col.b));
    float alpha = smoothstep(0.03, 0.30, b);
    gl_FragColor = vec4(col, alpha);
  }
`;

const vertexShader = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function size() {
  if (!renderer || !landing || !material) return;
  const w = landing.clientWidth || window.innerWidth;
  const h = landing.clientHeight || window.innerHeight;
  renderer.setSize(Math.max(1, Math.round(w * BUFFER_SCALE)), Math.max(1, Math.round(h * BUFFER_SCALE)), false);
  material.uniforms.uRes.value.set(w, h);
}

function init() {
  if (renderer || reduceMotion || !landing) return;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power' });
  } catch (_) {
    renderer = null;
    return; // no WebGL — silently skip, the page is fine without it
  }
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  canvas = renderer.domElement;
  canvas.className = 'landing-bg';
  landing.insertBefore(canvas, landing.firstChild);

  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) } },
  });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  size();
  window.addEventListener('resize', size);
}

function frame(now: number) {
  if (!running || !renderer || !scene || !camera || !material) return;
  if (!lastT) lastT = now;
  lastT = now;
  material.uniforms.uTime.value = now * 0.001;
  renderer.render(scene, camera);
  raf = requestAnimationFrame(frame);
}

function landingActive() {
  return Boolean(landing?.classList.contains('active'));
}

function update() {
  const shouldRun = micOn && landingActive() && !document.hidden;
  canvas?.classList.toggle('on', micOn && landingActive());
  if (shouldRun && !running) {
    running = true;
    lastT = 0;
    size(); // the view may have been display:none at init — measure now that it's visible
    raf = requestAnimationFrame(frame);
  } else if (!shouldRun && running) {
    running = false;
    cancelAnimationFrame(raf);
  }
}

function enableMic() {
  if (micOn) return;
  micOn = true;
  init();
  update();
}

// Wake when the mic is granted (or already granted this session).
window.addEventListener('daemonhall:mic-granted-this-session', enableMic);
try {
  if (sessionStorage.getItem('daemonhall:mic-ok-this-session') === '1') enableMic();
} catch (_) { /* ignore */ }

// Pause/resume with view changes and tab visibility.
document.addEventListener('visibilitychange', update);
if (landing) {
  new MutationObserver(update).observe(landing, { attributes: true, attributeFilter: ['class'] });
}
