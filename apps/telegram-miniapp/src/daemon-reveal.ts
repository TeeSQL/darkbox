import * as THREE from 'three';

type RevealPayload = { image?: string; name?: string; seed?: string };

const stage = document.querySelector<HTMLElement>('#daemon-reveal-stage');
const fallback = document.querySelector<HTMLImageElement>('#daemon-reveal-fallback');

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.OrthographicCamera | null = null;
let mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
let loader: THREE.TextureLoader | null = null;
let raf = 0;
let started = false;
let targetWake = 0.18;

const vertexShader = `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uWake;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  void main() {
    vUv = uv;
    vec3 pos = position;
    float grain = hash(vec2(floor(uv.y * 126.0), floor(uTime * 17.0)));
    float wave = sin((uv.y * 18.0) + uTime * 1.25) * 0.007;
    float twitch = step(0.992 - uWake * 0.035, grain) * (0.012 + uWake * 0.035);
    float edge = smoothstep(0.14, 0.0, uv.x) + smoothstep(0.86, 1.0, uv.x);
    pos.x += wave + (grain - 0.5) * (0.004 + uWake * 0.014) + twitch * edge;
    pos.y += sin(uTime * 0.84) * 0.01 + uWake * 0.012;
    pos.z += (sin(uTime * 1.55 + uv.y * 7.0) * 0.014 + twitch) * (0.25 + uWake);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const fragmentShader = `
  varying vec2 vUv;
  uniform sampler2D uMap;
  uniform float uTime;
  uniform float uWake;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453123);
  }

  void main() {
    vec2 uv = vUv;
    float gate = step(0.993 - uWake * 0.055, hash(vec2(floor(uTime * 10.0), floor(uv.y * 44.0))));
    float slice = (hash(vec2(floor(uv.y * 92.0), floor(uTime * 15.0))) - 0.5) * gate * (0.014 + uWake * 0.04);
    float breathe = sin(uTime * 1.0) * 0.0025;

    vec4 base = texture2D(uMap, uv + vec2(slice + breathe, 0.0));
    vec4 red = texture2D(uMap, uv + vec2(slice + 0.0035 + uWake * 0.006, 0.0));
    vec4 blue = texture2D(uMap, uv - vec2(0.0035 + uWake * 0.006, 0.0));
    base.r = mix(base.r, red.r, 0.20 + uWake * 0.22);
    base.b = mix(base.b, blue.b, 0.18 + uWake * 0.20);

    float luma = dot(base.rgb, vec3(0.299, 0.587, 0.114));
    float creature = smoothstep(0.06, 0.42, luma);
    float scan = sin((uv.y + uTime * 0.014) * 860.0) * 0.018;
    float noise = (hash(uv * vec2(720.0, 1280.0) + floor(uTime * 28.0)) - 0.5) * 0.042;
    vec3 glow = vec3(0.55, 0.49, 1.0) * creature * (0.10 + uWake * 0.22);
    vec3 color = base.rgb + glow + scan + noise;

    float vignette = smoothstep(0.96, 0.22, distance(uv, vec2(0.5, 0.48)));
    color *= mix(0.56, 1.10, vignette);
    color += gate * creature * vec3(0.14, 0.09, 0.24);
    gl_FragColor = vec4(color, 1.0);
  }
`;

function resize() {
  if (!stage || !renderer || !camera || !mesh) return;
  const rect = stage.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  renderer.setSize(width, height, false);
  const aspect = width / height;
  const view = 1.18;
  camera.left = -aspect * view;
  camera.right = aspect * view;
  camera.top = view;
  camera.bottom = -view;
  camera.updateProjectionMatrix();
  const frustumWidth = aspect * view * 2;
  const frustumHeight = view * 2;
  mesh.scale.setScalar(Math.min((frustumWidth * 0.94) / 1.28, (frustumHeight * 0.94) / 1.92));
}

function animate(time = 0) {
  raf = requestAnimationFrame(animate);
  if (!renderer || !scene || !camera || !mesh) return;
  const uniforms = mesh.material.uniforms;
  uniforms.uTime.value = time * 0.001;
  uniforms.uWake.value += (targetWake - uniforms.uWake.value) * 0.045;
  renderer.render(scene, camera);
}

function init() {
  if (!stage || started) return Boolean(renderer);
  started = true;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x101016, 1);
    stage.prepend(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    camera.position.z = 2;
    loader = new THREE.TextureLoader();
    mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.28, 1.92, 84, 128),
      new THREE.ShaderMaterial({
        uniforms: { uMap: { value: null }, uTime: { value: 0 }, uWake: { value: targetWake } },
        vertexShader,
        fragmentShader,
      }),
    );
    scene.add(mesh);
    resize();
    window.addEventListener('resize', resize);
    animate();
    stage.classList.add('webgl-ready');
    return true;
  } catch (error) {
    console.warn('daemon reveal webgl unavailable', error);
    stage.classList.add('webgl-fallback');
    return false;
  }
}

function setImage(image: string) {
  if (!stage) return;
  if (fallback) fallback.src = image;
  if (!init() || !loader || !mesh) return;
  loader.load(image, (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    if (mesh) mesh.material.uniforms.uMap.value = texture;
    stage.classList.add('webgl-ready');
  }, undefined, () => {
    stage.classList.add('webgl-fallback');
  });
}

window.addEventListener('daemonhall:reveal', (event) => {
  const payload = (event as CustomEvent<RevealPayload>).detail || {};
  targetWake = 0.22 + (Math.abs(hashCode(payload.seed || payload.name || 'daemon')) % 24) / 100;
  if (payload.image) setImage(payload.image);
});

function hashCode(seed: string) {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

window.addEventListener('pagehide', () => {
  if (raf) cancelAnimationFrame(raf);
});

if (fallback?.src) setImage(fallback.getAttribute('src') || fallback.src);
