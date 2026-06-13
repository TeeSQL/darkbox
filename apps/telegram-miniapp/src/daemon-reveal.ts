import * as THREE from 'three';

type RevealPayload = { image?: string; name?: string; seed?: string };

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
    __daemonhallWaitMicLevel?: number;
    __daemonhallSetWaitMicLevelForTest?: (level: number) => void;
  }
}

const stage = document.querySelector<HTMLElement>('#daemon-reveal-stage');
const fallback = document.querySelector<HTMLImageElement>('#daemon-reveal-fallback');
const waitPortrait = document.querySelector<HTMLElement>('.daemon-wait-portrait');
const waitImage = document.querySelector<HTMLImageElement>('#daemon-wait-image');

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.OrthographicCamera | null = null;
let mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
let loader: THREE.TextureLoader | null = null;
let raf = 0;
let started = false;
let targetWake = 0.18;
let loadedAspect = 1024 / 1536;

let waitRenderer: THREE.WebGLRenderer | null = null;
let waitScene: THREE.Scene | null = null;
let waitCamera: THREE.OrthographicCamera | null = null;
let waitMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
let waitLoader: THREE.TextureLoader | null = null;
let waitRaf = 0;
let waitCharacterRaf = 0;
let waitStarted = false;
let waitLoadedAspect = 1024 / 1536;
let waitMicStream: MediaStream | null = null;
let waitMicAudioContext: AudioContext | null = null;
let waitMicRaf = 0;
let waitMicLevel = 0;
let waitMicTarget = 0;
let waitMicProbeStarted = false;
let waitMicMode: 'idle' | 'listening' | 'test' = 'idle';

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
    vec2 centered = uv - vec2(0.5, 0.48);
    float apparition =
      smoothstep(0.72, 0.10, length(centered * vec2(0.82, 1.18))) *
      smoothstep(0.98, 0.26, abs(centered.x) + abs(centered.y) * 0.68);

    vec4 base = texture2D(uMap, uv + vec2(slice + breathe, 0.0));
    vec4 red = texture2D(uMap, uv + vec2(slice + 0.0035 + uWake * 0.006, 0.0));
    vec4 blue = texture2D(uMap, uv - vec2(0.0035 + uWake * 0.006, 0.0));
    base.r = mix(base.r, red.r, 0.20 + uWake * 0.22);
    base.b = mix(base.b, blue.b, 0.18 + uWake * 0.20);

    float luma = dot(base.rgb, vec3(0.299, 0.587, 0.114));
    float creature = max(smoothstep(0.06, 0.42, luma), apparition * 0.72);
    float scan = sin((uv.y + uTime * 0.014) * 860.0) * 0.018;
    float noise = (hash(uv * vec2(720.0, 1280.0) + floor(uTime * 28.0)) - 0.5) * 0.042;
    float vein = sin((uv.y * 17.0) + sin(uv.x * 19.0 + uTime * 0.8) + uTime * 1.15) * 0.5 + 0.5;
    vec3 plasma = mix(vec3(0.22, 0.10, 0.46), vec3(0.92, 0.30, 0.62), vein);
    vec3 ghost = plasma * creature * (0.40 + uWake * 0.58);
    vec3 glow = vec3(0.55, 0.49, 1.0) * creature * (0.14 + uWake * 0.30);
    vec3 color = mix(base.rgb * 0.34, ghost, 0.76) + glow + scan + noise;

    float vignette = smoothstep(0.96, 0.22, distance(uv, vec2(0.5, 0.48)));
    color *= mix(0.68, 1.18, vignette);
    color += gate * creature * vec3(0.24, 0.11, 0.38);
    color += vec3(0.035, 0.030, 0.055);
    gl_FragColor = vec4(color, 1.0);
  }
`;

const waitVertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const waitFragmentShader = `
  varying vec2 vUv;
  uniform sampler2D uMap;
  uniform float uTime;
  uniform float uWake;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(113.7, 271.9))) * 43758.5453123);
  }

  void main() {
    vec2 uv = vUv;
    float breathe = 0.5 + 0.5 * sin(uTime * 1.05);
    float mic = clamp(uWake, 0.0, 1.0);
    float drift = sin((uv.y * 9.0) + uTime * 0.92) * (0.0045 + mic * 0.007);
    float edgeMask =
      smoothstep(0.10, 0.0, uv.x) +
      smoothstep(0.90, 1.0, uv.x) +
      smoothstep(0.08, 0.0, uv.y) +
      smoothstep(0.92, 1.0, uv.y);

    vec4 base = texture2D(uMap, uv + vec2(drift, 0.0));
    vec4 red = texture2D(uMap, uv + vec2(0.003 + mic * 0.010, 0.0));
    vec4 blue = texture2D(uMap, uv - vec2(0.003 + mic * 0.009, 0.0));
    float luma = dot(base.rgb, vec3(0.299, 0.587, 0.114));
    float presence = smoothstep(0.08, 0.55, luma);
    float scan = smoothstep(0.955 - mic * 0.045, 1.0, sin((uv.y + uTime * (0.018 + mic * 0.035)) * 720.0) * 0.5 + 0.5);
    float grain = hash(floor(uv * vec2(220.0, 360.0)) + floor(uTime * 10.0)) - 0.5;
    float pulse = 0.18 + breathe * 0.26 + mic * 0.54;
    float glitchGate = step(0.992 - mic * 0.09, hash(vec2(floor(uTime * 14.0), floor(uv.y * 52.0))));

    vec3 chroma = vec3(red.r, base.g, blue.b) - base.rgb;
    vec3 livingGlow = vec3(0.56, 0.42, 1.0) * presence * pulse;
    vec3 edgeColor = vec3(1.0, 0.24, 0.58) * edgeMask * (0.18 + breathe * 0.28 + mic * 0.42);
    vec3 scanColor = vec3(0.78, 0.84, 1.0) * scan * presence * (0.11 + mic * 0.22);
    vec3 color = chroma * (0.82 + edgeMask * 1.4 + mic * 1.2) + livingGlow + edgeColor + scanColor + grain * (0.018 + mic * 0.035);
    color += glitchGate * presence * vec3(0.18, 0.08, 0.30) * mic;

    float alpha = clamp(0.10 + presence * (0.20 + breathe * 0.18 + mic * 0.22) + edgeMask * (0.24 + mic * 0.20) + scan * (0.12 + mic * 0.18), 0.0, 0.72);
    gl_FragColor = vec4(color, alpha);
  }
`;

function setWaitMicLevel(level: number, mode: typeof waitMicMode = waitMicMode) {
  waitMicMode = mode;
  waitMicTarget = Math.max(0, Math.min(1, level || 0));
  window.__daemonhallWaitMicLevel = waitMicTarget;
  waitPortrait?.style.setProperty('--wait-mic', waitMicTarget.toFixed(3));
  waitPortrait?.classList.toggle('mic-reactive', waitMicMode !== 'idle' && waitMicTarget > 0.02);
}

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
  const fitHeight = frustumHeight * 0.94;
  const fitWidth = frustumWidth * 0.94;
  let imageWidth = fitHeight * loadedAspect;
  let imageHeight = fitHeight;
  if (imageWidth > fitWidth) {
    imageWidth = fitWidth;
    imageHeight = imageWidth / loadedAspect;
  }
  mesh.scale.set(imageWidth, imageHeight, 1);
}

function scheduleRevealResize() {
  requestAnimationFrame(() => {
    resize();
    requestAnimationFrame(resize);
  });
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
      new THREE.PlaneGeometry(1, 1, 84, 128),
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
    const imageBitmap = texture.image as { width?: number; height?: number };
    if (imageBitmap.width && imageBitmap.height) loadedAspect = imageBitmap.width / imageBitmap.height;
    if (mesh) mesh.material.uniforms.uMap.value = texture;
    stage.classList.add('webgl-ready');
    resize();
  }, undefined, () => {
    stage.classList.add('webgl-fallback');
  });
}

function resizeWaitPortrait() {
  if (!waitPortrait || !waitRenderer || !waitCamera || !waitMesh) return;
  const rect = waitPortrait.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const width = Math.floor(rect.width);
  const height = Math.floor(rect.height);
  waitRenderer.setSize(width, height, false);
  const aspect = width / height;
  waitCamera.left = -aspect;
  waitCamera.right = aspect;
  waitCamera.top = 1;
  waitCamera.bottom = -1;
  waitCamera.updateProjectionMatrix();

  let imageWidth = 2 * waitLoadedAspect;
  let imageHeight = 2;
  if (imageWidth > aspect * 2) {
    imageWidth = aspect * 2;
    imageHeight = imageWidth / waitLoadedAspect;
  }
  waitMesh.scale.set(imageWidth, imageHeight, 1);
}

function scheduleWaitPortraitResize() {
  requestAnimationFrame(() => {
    resizeWaitPortrait();
    requestAnimationFrame(resizeWaitPortrait);
  });
}

function updateWaitCharacterMotion(time = 0) {
  waitMicLevel += (waitMicTarget - waitMicLevel) * 0.16;
  const autonomousWake = targetWake * (0.72 + Math.sin(time * 0.00105) * 0.12);
  const wakeTarget = waitMicMode === 'idle' ? autonomousWake : Math.max(autonomousWake, waitMicLevel);
  if (waitImage) {
    const t = time * 0.001;
    const breath = 0.5 + Math.sin(t * 1.08) * 0.5;
    const mic = waitMicMode === 'idle' ? 0 : waitMicLevel;
    const scale = 1 + breath * 0.014 + mic * 0.038;
    const lift = -1.5 - breath * 2.4 - mic * 6.0;
    const sway = Math.sin(t * 0.72) * (0.9 + mic * 2.2);
    waitImage.style.transform = `translate3d(${sway.toFixed(2)}px, ${lift.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
  }
  return wakeTarget;
}

function animateWaitCharacter(time = 0) {
  waitCharacterRaf = requestAnimationFrame(animateWaitCharacter);
  if (!waitRenderer) updateWaitCharacterMotion(time);
}

function startWaitCharacterMotion() {
  if (!waitCharacterRaf) waitCharacterRaf = requestAnimationFrame(animateWaitCharacter);
}

function animateWaitPortrait(time = 0) {
  waitRaf = requestAnimationFrame(animateWaitPortrait);
  if (!waitRenderer || !waitScene || !waitCamera || !waitMesh) return;
  waitMesh.material.uniforms.uTime.value = time * 0.001;
  const wakeTarget = updateWaitCharacterMotion(time);
  waitMesh.material.uniforms.uWake.value += (wakeTarget - waitMesh.material.uniforms.uWake.value) * 0.07;
  waitRenderer.render(waitScene, waitCamera);
}

function stopWaitMic() {
  if (waitMicRaf) cancelAnimationFrame(waitMicRaf);
  waitMicRaf = 0;
  waitMicStream?.getTracks().forEach((track) => track.stop());
  waitMicStream = null;
  void waitMicAudioContext?.close?.();
  waitMicAudioContext = null;
  setWaitMicLevel(0, 'idle');
}

async function maybeStartWaitMic() {
  if (waitMicProbeStarted || waitMicStream || !waitPortrait) return;
  waitMicProbeStarted = true;
  if (!navigator.mediaDevices?.getUserMedia) return;

  try {
    const permissions = navigator.permissions;
    if (!permissions?.query) return;
    const status = await permissions.query({ name: 'microphone' as PermissionName });
    if (status.state !== 'granted') {
      waitMicProbeStarted = false;
      return;
    }

    waitMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      stopWaitMic();
      return;
    }
    waitMicAudioContext = new AudioContextCtor();
    const source = waitMicAudioContext.createMediaStreamSource(waitMicStream);
    const analyser = waitMicAudioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    waitPortrait.dataset.mic = 'listening';
    const tick = () => {
      if (!waitMicStream) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }
      setWaitMicLevel(Math.min(1, Math.sqrt(sum / data.length) * 8), 'listening');
      waitMicRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch (_) {
    stopWaitMic();
  }
}

function initWaitPortrait() {
  if (!waitPortrait || waitStarted) return Boolean(waitRenderer);
  waitStarted = true;
  waitPortrait.classList.add('daemon-wait-alive');
  startWaitCharacterMotion();
  try {
    waitRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    waitRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    waitRenderer.setClearColor(0x000000, 0);
    waitRenderer.domElement.className = 'daemon-wait-shader';
    waitRenderer.domElement.setAttribute('aria-hidden', 'true');
    waitPortrait.append(waitRenderer.domElement);
    waitScene = new THREE.Scene();
    waitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    waitCamera.position.z = 2;
    waitLoader = new THREE.TextureLoader();
    waitMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1, 1, 1),
      new THREE.ShaderMaterial({
        uniforms: { uMap: { value: null }, uTime: { value: 0 }, uWake: { value: targetWake } },
        vertexShader: waitVertexShader,
        fragmentShader: waitFragmentShader,
        transparent: true,
        depthWrite: false,
      }),
    );
    waitScene.add(waitMesh);
    scheduleWaitPortraitResize();
    window.addEventListener('resize', scheduleWaitPortraitResize);
    animateWaitPortrait();
    void maybeStartWaitMic();
    waitPortrait.classList.add('webgl-alive');
    return true;
  } catch (error) {
    console.warn('daemon wait portrait webgl unavailable', error);
    waitPortrait.classList.add('css-alive');
    return false;
  }
}

function setWaitImage(image: string) {
  if (!waitPortrait) return;
  waitPortrait.classList.add('daemon-wait-alive');
  if (!initWaitPortrait() || !waitLoader || !waitMesh) return;
  waitLoader.load(image, (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const imageBitmap = texture.image as { width?: number; height?: number };
    if (imageBitmap.width && imageBitmap.height) waitLoadedAspect = imageBitmap.width / imageBitmap.height;
    if (waitMesh) waitMesh.material.uniforms.uMap.value = texture;
    waitPortrait.classList.add('webgl-alive');
    scheduleWaitPortraitResize();
  }, undefined, () => {
    waitPortrait.classList.add('css-alive');
  });
}

window.addEventListener('daemonhall:reveal', (event) => {
  const payload = (event as CustomEvent<RevealPayload>).detail || {};
  targetWake = 0.22 + (Math.abs(hashCode(payload.seed || payload.name || 'daemon')) % 24) / 100;
  if (payload.image) {
    setImage(payload.image);
    setWaitImage(payload.image);
  }
});

const waitView = document.querySelector('#v-wait');
if (waitView && waitPortrait) {
  new MutationObserver(() => {
    if (waitView.classList.contains('active')) {
      scheduleWaitPortraitResize();
      void maybeStartWaitMic();
    }
  }).observe(waitView, { attributes: true, attributeFilter: ['class'] });
}

const revealView = document.querySelector('#v-reveal');
if (revealView && stage) {
  new MutationObserver(() => {
    if (revealView.classList.contains('active')) scheduleRevealResize();
  }).observe(revealView, { attributes: true, attributeFilter: ['class'] });
}

window.__daemonhallSetWaitMicLevelForTest = (level: number) => setWaitMicLevel(level, 'test');
window.addEventListener('daemonhall:wait-mic-level', (event) => {
  setWaitMicLevel((event as CustomEvent<number>).detail, 'test');
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
  if (waitRaf) cancelAnimationFrame(waitRaf);
  if (waitCharacterRaf) cancelAnimationFrame(waitCharacterRaf);
  stopWaitMic();
});

if (fallback?.src) setImage(fallback.getAttribute('src') || fallback.src);
if (waitImage?.src) setWaitImage(waitImage.getAttribute('src') || waitImage.src);
