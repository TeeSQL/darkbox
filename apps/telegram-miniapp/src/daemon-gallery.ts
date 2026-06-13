import * as THREE from 'three';

type Daemon = {
  id: string;
  name: string;
  species: string;
  class: string;
  origin: string;
  role: string;
  image: string;
};

type Manifest = { daemons: Daemon[] };

const grid = document.querySelector<HTMLElement>('#daemon-grid');
const stage = document.querySelector<HTMLElement>('#daemon-stage');
const title = document.querySelector<HTMLElement>('#daemon-stage-title');
const meta = document.querySelector<HTMLElement>('#daemon-stage-meta');
const micButton = document.querySelector<HTMLButtonElement>('#daemon-mic');
const micStatus = document.querySelector<HTMLElement>('#daemon-mic-status');

let manifest: Manifest | null = null;
let selected: Daemon | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.OrthographicCamera | null = null;
let mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
let textureLoader: THREE.TextureLoader | null = null;
let raf = 0;
let started = false;
let micLevel = 0;
let micStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;

const vertexShader = `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uMic;
  uniform float uHover;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  void main() {
    vUv = uv;
    vec3 pos = position;
    float grain = hash(vec2(floor(uv.y * 120.0), floor(uTime * 18.0)));
    float wave = sin((uv.y * 19.0) + uTime * 1.35) * 0.006;
    float twitch = step(0.988 - uMic * 0.035, grain) * (0.018 + uMic * 0.035);
    float edge = smoothstep(0.12, 0.0, uv.x) + smoothstep(0.88, 1.0, uv.x);
    pos.x += wave + (grain - 0.5) * (0.006 + uMic * 0.018) + twitch * edge;
    pos.y += sin(uTime * 0.9) * 0.012 + uMic * 0.018;
    pos.z += (sin(uTime * 1.7 + uv.y * 7.0) * 0.018 + twitch) * (0.35 + uHover);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const fragmentShader = `
  varying vec2 vUv;
  uniform sampler2D uMap;
  uniform float uTime;
  uniform float uMic;
  uniform float uHover;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453123);
  }

  void main() {
    vec2 uv = vUv;
    float glitchGate = step(0.992 - uMic * 0.055, hash(vec2(floor(uTime * 11.0), floor(uv.y * 42.0))));
    float slice = (hash(vec2(floor(uv.y * 90.0), floor(uTime * 16.0))) - 0.5) * glitchGate * (0.018 + uMic * 0.045);
    float breathe = sin(uTime * 1.05) * 0.003;

    vec4 base = texture2D(uMap, uv + vec2(slice + breathe, 0.0));
    vec4 r = texture2D(uMap, uv + vec2(slice + 0.004 + uMic * 0.009, 0.0));
    vec4 b = texture2D(uMap, uv - vec2(0.004 + uMic * 0.007, 0.0));
    base.r = mix(base.r, r.r, 0.22 + uMic * 0.32);
    base.b = mix(base.b, b.b, 0.18 + uMic * 0.26);

    float luma = dot(base.rgb, vec3(0.299, 0.587, 0.114));
    float creature = smoothstep(0.07, 0.42, luma);
    float scan = sin((uv.y + uTime * 0.018) * 900.0) * 0.025;
    float noise = (hash(uv * vec2(720.0, 1280.0) + floor(uTime * 30.0)) - 0.5) * 0.055;
    float wake = clamp(uMic * 1.8 + uHover * 0.28, 0.0, 1.5);
    vec3 glow = vec3(0.78, 0.62, 1.0) * creature * (0.16 + wake * 0.44);
    vec3 color = base.rgb + glow + scan + noise;

    float vignette = smoothstep(0.94, 0.24, distance(uv, vec2(0.5, 0.48)));
    color *= mix(0.58, 1.14, vignette);
    color += glitchGate * creature * vec3(0.20, 0.12, 0.35);
    gl_FragColor = vec4(color, 1.0);
  }
`;

function card(daemon: Daemon) {
  const node = document.createElement('button');
  node.className = 'daemon-card';
  node.type = 'button';
  node.innerHTML = `
    <div class="daemon-frame">
      <img loading="lazy" src="${daemon.image}" alt="${daemon.name}, ${daemon.species} ${daemon.class}" />
      <div class="daemon-static" aria-hidden="true"></div>
    </div>
    <div class="daemon-label">
      <strong>${daemon.name}</strong>
      <span>// CLASS: ${daemon.class} //</span>
      <span>// ORIGIN: ${daemon.origin} //</span>
    </div>
  `;
  node.addEventListener('click', () => selectDaemon(daemon, node));
  return node;
}

function initThree() {
  if (!stage || started) return;
  started = true;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x020203, 1);
  stage.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
  camera.position.z = 2;
  textureLoader = new THREE.TextureLoader();
  mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.28, 1.92, 90, 140),
    new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: null },
        uTime: { value: 0 },
        uMic: { value: 0 },
        uHover: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      transparent: false,
    }),
  );
  scene.add(mesh);
  resize();
  window.addEventListener('resize', resize);
  animate();
}

function resize() {
  if (!stage || !renderer || !camera) return;
  const rect = stage.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  renderer.setSize(width, height, false);
  const aspect = width / height;
  const view = 1.2;
  camera.left = -aspect * view;
  camera.right = aspect * view;
  camera.top = view;
  camera.bottom = -view;
  camera.updateProjectionMatrix();
}

function animate(time = 0) {
  raf = requestAnimationFrame(animate);
  if (!renderer || !scene || !camera || !mesh) return;
  const material = mesh.material;
  material.uniforms.uTime.value = time * 0.001;
  material.uniforms.uMic.value += (micLevel - material.uniforms.uMic.value) * 0.08;
  renderer.render(scene, camera);
}

function selectDaemon(daemon: Daemon, node?: HTMLElement) {
  selected = daemon;
  initThree();
  document.querySelectorAll('.daemon-card.selected').forEach((el) => el.classList.remove('selected'));
  node?.classList.add('selected');
  if (title) title.textContent = daemon.name;
  if (meta) meta.textContent = `// CLASS: ${daemon.class} // ORIGIN: ${daemon.origin} // ${daemon.role}`;
  if (textureLoader && mesh) {
    textureLoader.load(daemon.image, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      if (mesh) mesh.material.uniforms.uMap.value = texture;
    });
  }
  document.querySelector('.daemon-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function toggleMic() {
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
    await audioContext?.close();
    audioContext = null;
    micLevel = 0;
    micButton?.classList.remove('listening');
    if (micStatus) micStatus.textContent = 'mic asleep · preview uses idle flicker';
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(micStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    micButton?.classList.add('listening');
    if (micStatus) micStatus.textContent = 'listening · whisper wakes the shader';
    const tick = () => {
      if (!micStream) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }
      micLevel = Math.min(1, Math.sqrt(sum / data.length) * 8);
      requestAnimationFrame(tick);
    };
    tick();
  } catch (_) {
    if (micStatus) micStatus.textContent = 'mic unavailable · click/hover still previews idle state';
  }
}

async function loadDaemons() {
  if (!grid) return;
  try {
    const response = await fetch('/daemons/manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`manifest ${response.status}`);
    manifest = await response.json() as Manifest;
    const cards = manifest.daemons.map(card);
    grid.replaceChildren(...cards);
    if (manifest.daemons[0]) selectDaemon(manifest.daemons[0], cards[0]);
  } catch (error) {
    grid.innerHTML = '<p class="gallery-error">bestiary manifest failed to open.</p>';
    console.error(error);
  }
}

micButton?.addEventListener('click', () => void toggleMic());
window.addEventListener('pagehide', () => {
  if (raf) cancelAnimationFrame(raf);
  micStream?.getTracks().forEach((track) => track.stop());
});

void loadDaemons();
