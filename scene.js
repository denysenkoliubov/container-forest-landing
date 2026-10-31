// Container Forest — procedural 3D still render (three.js)
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const params = new URLSearchParams(location.search);
const W = +params.get('w') || 1920, H = +params.get('h') || 1080;
const SAVE = params.get('save');
const statusEl = document.getElementById('status');
const status = (t) => { statusEl.textContent = t; console.log(t); };
const tick = () => new Promise(r => setTimeout(r, 0));

// ---------- random + noise ----------
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let rand = mulberry32(20261026);
const R = (a, b) => a + (b - a) * rand();
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

class Noise {
  constructor(seed) { const r = mulberry32(seed); this.v = new Float32Array(65536); for (let i = 0; i < 65536; i++) this.v[i] = r(); }
  n(x, y, p = 256) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % p) + p) % p, y0 = ((yi % p) + p) % p, x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
    const a = this.v[y0 * 256 + x0], b = this.v[y0 * 256 + x1], c = this.v[y1 * 256 + x0], d = this.v[y1 * 256 + x1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  fbm(x, y, oct = 5, p = 256) {
    let s = 0, a = 0.5, f = 1, nrm = 0;
    for (let i = 0; i < oct; i++) { s += a * this.n(x * f, y * f, Math.min(256, p * f)); nrm += a; a *= 0.5; f *= 2; }
    return s / nrm;
  }
}
const nz = new Noise(11), nz2 = new Noise(23), nz3 = new Noise(37);

// ---------- canvas texture helpers ----------
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function toTex(c, srgb = true, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// ---------- scene constants ----------
const CL = 6.06, CW = 2.44, CH = 2.59;            // 20ft container (m)
const CROT = -2.33;                                // container yaw
const CPOS = new THREE.Vector3(0, -0.09, 0);
const SUN = new THREE.Vector3(0.84, 0.44, -0.24).normalize(); // direction toward sun (low morning sun, upper right)
const FOG = new THREE.Color().setRGB(0.62, 0.68, 0.50, THREE.SRGBColorSpace);

function toLocal(x, z) { const c = Math.cos(CROT), s = Math.sin(CROT); return [x * c - z * s, x * s + z * c]; }
function sdContainer(x, z) {
  const [lx, lz] = toLocal(x - CPOS.x, z - CPOS.z);
  const dx = Math.abs(lx) - CL / 2, dz = Math.abs(lz) - CW / 2;
  return Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0);
}
function heightAt(x, z) {
  let h = (nz.fbm(x * 0.025 + 40, z * 0.025 + 40, 4) - 0.5) * 3.2;
  h += (nz2.fbm(x * 0.15 + 9, z * 0.15 + 9, 3) - 0.5) * 0.35;
  h += Math.max(0, -z - 18) * 0.06;
  const f = smooth(1.5, 10, sdContainer(x, z));
  return h * f;
}

// ---------- renderer / camera ----------
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(FOG, 0.010);
// Device framings: the container sits in the middle and fills `fill` of the frame width.
const FRAMINGS = [
  { name: 'desktop', aspect: 16 / 9, fov: 30, fill: 0.5 },
  { name: 'tablet', aspect: 4 / 3, fov: 34, fill: 0.6 },
  { name: 'tablet-portrait', aspect: 3 / 4, fov: 44, fill: 0.8 },
  { name: 'phone', aspect: 9 / 19.5, fov: 56, fill: 0.92 },
];
const CAM_DIR = new THREE.Vector3(0.05, 0.035, 1).normalize();
const CTARGET = new THREE.Vector3(CPOS.x, 1.35, CPOS.z);
function containerCorners() {
  const out = [], c = Math.cos(CROT), s = Math.sin(CROT);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, CH]) {
    const lx = sx * CL / 2, lz = sz * CW / 2;
    out.push(new THREE.Vector3(lx * c + lz * s + CPOS.x, y, -lx * s + lz * c + CPOS.z));
  }
  return out;
}
function makeCamera(aspect) {
  const fr = FRAMINGS.reduce((b, f) => Math.abs(Math.log(f.aspect / aspect)) < Math.abs(Math.log(b.aspect / aspect)) ? f : b);
  const cam = new THREE.PerspectiveCamera(fr.fov, aspect, 0.1, 3000);
  const corners = containerCorners();
  const place = (d) => {
    cam.position.copy(CTARGET).addScaledVector(CAM_DIR, d); cam.lookAt(CTARGET); cam.updateMatrixWorld();
    let mn = 1e9, mx = -1e9; for (const c of corners) { const q = c.clone().project(cam); mn = Math.min(mn, q.x); mx = Math.max(mx, q.x); }
    return (mx - mn) / 2;
  };
  let lo = 2, hi = 120;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (place(mid) > fr.fill) lo = mid; else hi = mid; }
  place(hi); cam.userData.framing = fr.name; cam.userData.dist = hi;
  // aim so the container's on-screen box is centred
  const look = CTARGET.clone(), tv = Math.tan(THREE.MathUtils.degToRad(fr.fov / 2)), th = tv * aspect;
  for (let it = 0; it < 6; it++) {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const c of corners) { const q = c.clone().project(cam); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), upv = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    look.addScaledVector(right, (x0 + x1) / 2 * th * hi).addScaledVector(upv, ((y0 + y1) / 2 + 0.06) * tv * hi);
    cam.lookAt(look); cam.updateMatrixWorld();
  }
  return cam;
}
const camera = makeCamera(W / H);
const allCams = FRAMINGS.map(f => makeCamera(f.aspect));
console.log('framing', camera.userData.framing, 'distance', camera.userData.dist.toFixed(2));
const sunView = SUN.clone().transformDirection(camera.matrixWorldInverse);

// beams (light shafts) — canopy gets carved along these lines so the dappled light matches
const beams = [];
function addBeam(p, r, k = 1) { beams.push({ p, r, k }); }
const occList = [];   // {obj, mat, occ} for god-ray occlusion pass
const hideInOcc = [];
const black = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false });
function regOcc(obj, occ = black) { occList.push({ obj, mat: obj.material, occ }); }
function beamBlocked(q, pad) {
  for (const b of beams) {
    const v = q.clone().sub(b.p); const t = v.dot(SUN);
    if (t < 0.5) continue;
    const d = v.addScaledVector(SUN, -t).length();
    if (d < b.r + pad) return true;
  }
  return false;
}

// ---------- sky ----------
const skyUniforms = { uSun: { value: SUN }, uFog: { value: new THREE.Vector3(FOG.r, FOG.g, FOG.b) }, uOcc: { value: 0 } };
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyUniforms,
  vertexShader: `varying vec3 vDir; void main(){ vDir = normalize((modelMatrix*vec4(position,1.)).xyz - cameraPosition); gl_Position = projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.); gl_Position.z = gl_Position.w; }`,
  fragmentShader: `uniform vec3 uSun; uniform vec3 uFog; uniform float uOcc; varying vec3 vDir;
  void main(){ vec3 d=normalize(vDir); float s=max(dot(d,uSun),0.);
    float up=clamp(d.y,0.,1.);
    vec3 zen=vec3(0.50,0.66,0.70); vec3 col=mix(uFog*1.1, zen, pow(up,0.6));
    vec3 warm=vec3(1.0,0.86,0.62);
    col += warm*(pow(s,6.)*0.9 + pow(s,64.)*4.0 + pow(s,800.)*30.);
    if(uOcc>0.5){ col = warm*(0.10 + pow(s,4.)*1.2 + pow(s,40.)*3.0); }
    gl_FragColor=vec4(col,1.); }`
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 48, 24), skyMat);
sky.frustumCulled = false;
scene.add(sky);

// environment from sky
{
  const pm = new THREE.PMREMGenerator(renderer);
  const es = new THREE.Scene();
  const s2 = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat.clone());
  s2.material.uniforms = { uSun: skyUniforms.uSun, uFog: skyUniforms.uFog, uOcc: { value: 0 } };
  es.add(s2);
  // green-ish bounce from the forest floor
  const floor = new THREE.Mesh(new THREE.CircleGeometry(90, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(0.12, 0.17, 0.07) }));
  floor.position.y = -2; es.add(floor);
  scene.environment = pm.fromScene(es, 0.02).texture;
  scene.environmentIntensity = 0.5;
}

// ---------- lights ----------
const sunLight = new THREE.DirectionalLight(new THREE.Color().setRGB(1.0, 0.88, 0.70, THREE.SRGBColorSpace), 8.0);
sunLight.position.copy(SUN).multiplyScalar(90);
sunLight.target.position.set(0, 0, 0);
scene.add(sunLight, sunLight.target);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(8192, 8192);
Object.assign(sunLight.shadow.camera, { left: -42, right: 42, top: 42, bottom: -42, near: 1, far: 220 });
sunLight.shadow.bias = -0.00015;
sunLight.shadow.normalBias = 0.025;
const hemi = new THREE.HemisphereLight(new THREE.Color().setRGB(0.72, 0.82, 0.78, THREE.SRGBColorSpace), new THREE.Color().setRGB(0.25, 0.33, 0.14, THREE.SRGBColorSpace), 0.75);
scene.add(hemi);

// ======================================================================
// TEXTURES
// ======================================================================
function paintMetal({ w, h, mx, my, seed, rustTop = 1, grime = 1, moss = 1, base, faded }) {
  const c = makeCanvas(w, h), ctx = c.getContext('2d');
  const rc = makeCanvas(w, h), rctx = rc.getContext('2d');
  const img = ctx.createImageData(w, h), rimg = rctx.createImageData(w, h);
  const N = new Noise(seed), N2 = new Noise(seed + 1);
  for (let y = 0; y < h; y++) {
    const vy = y / h; // 0 top .. 1 bottom
    for (let x = 0; x < w; x++) {
      const px = x / w * mx, py = y / h * my;
      const fade = N.fbm(px * 0.7, py * 0.7, 4);
      const fine = N2.n(px * 60, py * 60);
      let r = mix(base[0], faded[0], smooth(0.35, 0.75, fade));
      let g = mix(base[1], faded[1], smooth(0.35, 0.75, fade));
      let b = mix(base[2], faded[2], smooth(0.35, 0.75, fade));
      let rough = 0.52 + fade * 0.18;
      // vertical streak grime (rain wash)
      const streak = N2.fbm(px * 6, py * 0.35, 4);
      const wash = smooth(0.5, 0.75, streak) * 0.18;
      r = mix(r, 70, wash); g = mix(g, 78, wash); b = mix(b, 62, wash);
      // bottom grime + moss
      const gb = smooth(0.55, 1.0, vy + (N.fbm(px * 2, py * 2, 3) - 0.5) * 0.35) * grime;
      r = mix(r, 66, gb * 0.75); g = mix(g, 70, gb * 0.75); b = mix(b, 50, gb * 0.75);
      const mo = smooth(0.62, 0.78, N2.fbm(px * 1.6 + 7, py * 1.6, 5) + vy * 0.25 - 0.15) * moss * smooth(0.5, 1, vy);
      r = mix(r, 78, mo); g = mix(g, 104, mo); b = mix(b, 46, mo);
      rough = mix(rough, 0.9, Math.max(gb * 0.6, mo));
      // rust patches
      const rs = N.fbm(px * 2.8 + 31, py * 2.8 + 17, 6);
      const ru = smooth(0.66, 0.78, rs + (1 - vy) * 0.04 * rustTop) * 0.8;
      const rcol = mix(70, 112, fine);
      r = mix(r, rcol, ru); g = mix(g, rcol * 0.58, ru); b = mix(b, rcol * 0.38, ru);
      rough = mix(rough, 0.92, ru);
      // micro speckle
      const sp = (fine - 0.5) * 14;
      const i = (y * w + x) * 4;
      img.data[i] = r + sp; img.data[i + 1] = g + sp; img.data[i + 2] = b + sp; img.data[i + 3] = 255;
      const rv = clamp(rough + (fine - 0.5) * 0.08, 0, 1) * 255;
      rimg.data[i] = rv; rimg.data[i + 1] = rv; rimg.data[i + 2] = rv; rimg.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0); rctx.putImageData(rimg, 0, 0);
  // rust run-off streaks from the top edge
  const nStreaks = Math.round(w / 40 * rustTop);
  for (let k = 0; k < nStreaks; k++) {
    const x0 = R(0, w), len = h * R(0.05, 0.55), wd = R(1, 7) * w / 4096 * 2;
    const g = ctx.createLinearGradient(0, 0, 0, len);
    const a = R(0.15, 0.4);
    g.addColorStop(0, `rgba(100,68,44,${a * 0.7})`); g.addColorStop(1, 'rgba(100,68,44,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(x0 - wd, 0); ctx.lineTo(x0 + wd, 0); ctx.lineTo(x0 + wd * 0.3 + R(-2, 2), len); ctx.lineTo(x0 - wd * 0.3, len); ctx.fill();
  }
  // scratches
  ctx.strokeStyle = 'rgba(170,180,165,0.25)'; ctx.lineWidth = 1;
  for (let k = 0; k < w / 60; k++) {
    const x0 = R(0, w), y0 = R(0, h); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + R(-30, 30), y0 + R(-8, 8)); ctx.stroke();
  }
  return { c, ctx, rc };
}
function stencil(ctx, lines, x, y, size, align = 'left', alpha = 0.78) {
  const tc = makeCanvas(ctx.canvas.width, ctx.canvas.height), t = tc.getContext('2d');
  t.fillStyle = '#e8ece4'; t.textAlign = align; t.textBaseline = 'top';
  lines.forEach((ln, i) => { t.font = `bold ${ln.s || size}px "Helvetica Neue", Arial, sans-serif`; t.fillText(ln.t, x, y + i * size * 1.25); });
  // erode
  t.globalCompositeOperation = 'destination-out';
  for (let k = 0; k < 9000; k++) { t.fillStyle = `rgba(0,0,0,${R(0.2, 0.9)})`; t.fillRect(R(x - 600, x + 900), R(y - 20, y + lines.length * size * 1.3 + 20), R(1, 4), R(1, 4)); }
  ctx.globalAlpha = alpha; ctx.drawImage(tc, 0, 0); ctx.globalAlpha = 1;
}

const BASE = [102, 68, 52], FADED = [134, 102, 80];
status('painting container…'); await tick();
const sideP = paintMetal({ w: 4096, h: 1024, mx: CL, my: CH, seed: 101, base: BASE, faded: FADED });
stencil(sideP.ctx, [{ t: 'CFRU 204718 4' }, { t: '22G1', s: 46 }], 3700, 70, 56, 'right');
const sideTex = toTex(sideP.c, true, false), sideRough = toTex(sideP.rc, false, false);
const side2P = paintMetal({ w: 4096, h: 1024, mx: CL, my: CH, seed: 202, base: BASE, faded: FADED });
const side2Tex = toTex(side2P.c, true, false), side2Rough = toTex(side2P.rc, false, false);

const roofP = paintMetal({ w: 4096, h: 1024, mx: CL, my: CW, seed: 303, base: [96, 62, 46], faded: [126, 92, 70], rustTop: 0.4, grime: 0, moss: 0 });
{ // moss, dirt and leaf litter on the roof
  const ctx = roofP.ctx, w = 4096, h = 1024, N = new Noise(77);
  const img = ctx.getImageData(0, 0, w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = x / w * CL, py = y / h * CW, i = (y * w + x) * 4;
    const edge = 1 - Math.min(y / h, 1 - y / h) * 2;           // dirt gathers at edges
    const m = smooth(0.52, 0.68, N.fbm(px * 0.9, py * 0.9, 6) + edge * 0.18 + (x / w) * 0.08);
    const det = N.n(px * 40, py * 40);
    const mr = mix(62, 96, det), mg = mix(88, 122, det), mb = mix(36, 52, det);
    img.data[i] = mix(img.data[i], mr, m); img.data[i + 1] = mix(img.data[i + 1], mg, m); img.data[i + 2] = mix(img.data[i + 2], mb, m);
    const dirt = smooth(0.45, 0.7, N.fbm(px * 2 + 5, py * 2, 4)) * 0.5;
    img.data[i] = mix(img.data[i], 74, dirt); img.data[i + 1] = mix(img.data[i + 1], 70, dirt); img.data[i + 2] = mix(img.data[i + 2], 52, dirt);
  }
  ctx.putImageData(img, 0, 0);
  for (let k = 0; k < 2600; k++) {
    const x = R(0, w), y = R(0, h), s = R(6, 16), a = R(0, Math.PI * 2);
    const hue = R(30, 85), l = R(28, 45);
    ctx.save(); ctx.translate(x, y); ctx.rotate(a); ctx.fillStyle = `hsla(${hue},${R(25, 45)}%,${l}%,0.9)`;
    ctx.beginPath(); ctx.ellipse(0, 0, s, s * 0.45, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
}
const roofTex = toTex(roofP.c, true, false), roofRough = toTex(roofP.rc, false, false);

const doorTexs = [0, 1].map(k => {
  const p = paintMetal({ w: 1024, h: 2048, mx: 1.07, my: 2.23, seed: 400 + k, base: BASE, faded: FADED, rustTop: 1.2 });
  if (k === 1) {
    stencil(p.ctx, [{ t: 'CFRU 204718 4' }, { t: '22G1', s: 40 }], 120, 140, 52);
    stencil(p.ctx, [{ t: 'MAX.GROSS 30.480 KG' }, { t: '67.200 LB' }, { t: 'TARE 2.200 KG' }, { t: '4.850 LB' }, { t: 'NET 28.280 KG' }, { t: 'CU.CAP. 33.2 CU.M' }], 120, 420, 30, 'left', 0.7);
    // CSC plate
    p.ctx.fillStyle = 'rgba(150,152,140,0.85)'; p.ctx.fillRect(130, 1250, 230, 140);
    p.ctx.strokeStyle = 'rgba(60,60,55,0.6)'; p.ctx.lineWidth = 3; p.ctx.strokeRect(130, 1250, 230, 140);
    p.ctx.fillStyle = 'rgba(70,70,64,0.6)'; for (let i = 0; i < 7; i++) p.ctx.fillRect(145, 1265 + i * 17, R(120, 200), 5);
  }
  return { map: toTex(p.c, true, false), rough: toTex(p.rc, false, false) };
});
const endP = paintMetal({ w: 1024, h: 1024, mx: CW, my: CH, seed: 505, base: BASE, faded: FADED });
const endTex = toTex(endP.c, true, false), endRough = toTex(endP.rc, false, false);
const frameP = paintMetal({ w: 1024, h: 1024, mx: 3, my: 3, seed: 606, base: [92, 58, 42], faded: [122, 88, 66], rustTop: 0.5, grime: 0.4, moss: 0.3 });
const frameTex = toTex(frameP.c), frameRough = toTex(frameP.rc, false);

status('painting forest…'); await tick();
// bark
function barkTexture(seed) {
  const w = 512, h = 1024, c = makeCanvas(w, h), ctx = c.getContext('2d'), img = ctx.createImageData(w, h), N = new Noise(seed);
  const bc = makeCanvas(w, h), bctx = bc.getContext('2d'), bimg = bctx.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = x / w * 8, py = y / h * 8;
    const f = N.fbm(px * 1.0, py * 0.18, 5, 8);           // vertical fissures (tileable)
    const ridge = 1 - Math.abs(f - 0.5) * 2;
    const det = N.fbm(px * 4, py * 2, 3, 32);
    const moss = smooth(0.42, 0.62, N.fbm(px * 0.5 + 3, py * 0.5, 4, 4)) * 0.9;
    let r = mix(48, 112, ridge * 0.7 + det * 0.3), g = mix(44, 104, ridge * 0.7 + det * 0.3), b = mix(36, 88, ridge * 0.7 + det * 0.3);
    r = mix(r, 82, moss); g = mix(g, 104, moss); b = mix(b, 50, moss);
    const i = (y * w + x) * 4;
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    const bv = (ridge * 0.8 + det * 0.2) * 255; bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = bv; bimg.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0); bctx.putImageData(bimg, 0, 0);
  const t = toTex(c), bt = toTex(bc, false); t.repeat.set(2, 3); bt.repeat.set(2, 3);
  return { map: t, bump: bt };
}
const bark = barkTexture(808);

// leaf cluster cards
function leafTexture(seed, n, len, spread, hueA, hueB) {
  const S = 512, c = makeCanvas(S, S), ctx = c.getContext('2d'); const r0 = rand; rand = mulberry32(seed);
  ctx.strokeStyle = 'rgba(70,58,40,1)'; ctx.lineCap = 'round';
  const tw = []; // twig ends
  for (let k = 0; k < 6; k++) {
    const a = R(-Math.PI, 0) , l = R(80, spread);
    const ex = S / 2 + Math.cos(a) * l, ey = S * 0.62 + Math.sin(a) * l;
    ctx.lineWidth = R(2, 4); ctx.beginPath(); ctx.moveTo(S / 2, S * 0.95); ctx.quadraticCurveTo(S / 2 + R(-40, 40), S * 0.7, ex, ey); ctx.stroke(); tw.push([ex, ey]);
  }
  for (let k = 0; k < n; k++) {
    const [tx, ty] = tw[k % tw.length];
    const t = R(0, 1);
    const x = mix(S / 2, tx, t) + R(-50, 50), y = mix(S * 0.8, ty, t) + R(-50, 50);
    const L = len * R(0.7, 1.2), Wd = L * R(0.38, 0.5), ang = Math.atan2(y - S * 0.8, x - S / 2) + Math.PI / 2 + R(-0.8, 0.8);
    const hue = R(hueA, hueB), sat = R(30, 48), lig = R(30, 50);
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    const g = ctx.createLinearGradient(-Wd, 0, Wd, 0);
    g.addColorStop(0, `hsl(${hue},${sat}%,${lig - 8}%)`); g.addColorStop(0.5, `hsl(${hue},${sat}%,${lig + 4}%)`); g.addColorStop(1, `hsl(${hue},${sat}%,${lig - 4}%)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.bezierCurveTo(Wd, -L * 0.25, Wd * 0.7, -L * 0.8, 0, -L); ctx.bezierCurveTo(-Wd * 0.7, -L * 0.8, -Wd, -L * 0.25, 0, 0); ctx.fill();
    ctx.strokeStyle = `hsla(${hue},${sat}%,${lig + 18}%,0.5)`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -L * 0.92); ctx.stroke();
    ctx.restore();
  }
  rand = r0;
  const tex = toTex(c, true, false); return tex;
}
const leafTex = leafTexture(5, 70, 62, 210, 78, 102);
const bushTex = leafTexture(9, 110, 40, 200, 85, 110);

function fernTexture() {
  const w = 1024, h = 256, c = makeCanvas(w, h), ctx = c.getContext('2d');
  ctx.strokeStyle = 'hsl(80,35%,30%)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  for (let x = 30; x < w - 10; x += 22) {
    const t = x / w, L = (1 - t) * 0.75 * h / 2 * Math.sin(Math.min(1, t * 4) * Math.PI / 2) + 6;
    for (const sgn of [-1, 1]) {
      const hue = R(80, 98), lig = R(30, 44);
      ctx.fillStyle = `hsl(${hue},40%,${lig}%)`;
      ctx.save(); ctx.translate(x, h / 2); ctx.rotate(sgn * (Math.PI / 2 - 0.35));
      for (let s = 4; s < L; s += 9) { // pinnules
        ctx.beginPath(); ctx.ellipse(s, 0, 6, 5 * (1 - s / L) + 2.5, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillRect(0, -1.5, L, 3);
      ctx.restore();
    }
  }
  return toTex(c, true, false);
}
const fernTex = fernTexture();

function groundTexture() {
  const w = 2048, c = makeCanvas(w, w), ctx = c.getContext('2d'), img = ctx.createImageData(w, w), N = new Noise(909), P = 16;
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const px = x / w * P, py = y / w * P;
    const a = N.fbm(px * 0.5, py * 0.5, 5, 8), d = N.fbm(px * 3, py * 3, 4, 48), fine = N.n(px * 30, py * 30, 256);
    const soil = smooth(0.55, 0.72, a);
    let r = mix(62, 92, d), g = mix(84, 110, d), b = mix(34, 46, d);
    r = mix(r, mix(78, 98, fine), soil); g = mix(g, mix(66, 84, fine), soil); b = mix(b, mix(46, 58, fine), soil);
    const i = (y * w + x) * 4; img.data[i] = r + (fine - .5) * 16; img.data[i + 1] = g + (fine - .5) * 16; img.data[i + 2] = b + (fine - .5) * 10; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  for (let k = 0; k < 5000; k++) { // litter
    const x = R(0, w), y = R(0, w), s = R(4, 11);
    ctx.fillStyle = `hsla(${R(28, 70)},${R(20, 40)}%,${R(26, 42)}%,0.8)`;
    ctx.beginPath(); ctx.ellipse(x, y, s, s * 0.45, R(0, 6.28), 0, 6.28); ctx.fill();
  }
  const t = toTex(c); t.repeat.set(240 / 6, 240 / 6); return t;
}
const groundTex = groundTexture();

function softDot(inner = 0.0) {
  const c = makeCanvas(64, 64), ctx = c.getContext('2d'), g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35 + inner, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64); return toTex(c, false, false);
}

function flowerTexture() {
  const c = makeCanvas(128, 128), ctx = c.getContext('2d');
  ctx.translate(64, 64);
  for (let i = 0; i < 9; i++) { ctx.rotate(Math.PI * 2 / 9); ctx.fillStyle = 'rgba(250,250,244,1)'; ctx.beginPath(); ctx.ellipse(0, -30, 11, 30, 0, 0, 6.28); ctx.fill(); }
  ctx.fillStyle = '#e4c45a'; ctx.beginPath(); ctx.arc(0, 0, 14, 0, 6.28); ctx.fill();
  return toTex(c, true, false);
}
const flowerTex = flowerTexture();

// ======================================================================
// CONTAINER
// ======================================================================
status('building container…'); await tick();
const PH = [0, 0.28, 0.32, 0.38, 0.42, 0.78, 0.82, 0.88, 0.92];
function profileXs(len, period) { const xs = []; for (let k = 0; k * period < len; k++) for (const p of PH) { const x = (k + p) * period; if (x < len) xs.push(x); } xs.push(len); return xs; }
function prof(t) { t -= Math.floor(t); if (t < 0.3) return 0; if (t < 0.4) return (t - 0.3) / 0.1; if (t < 0.8) return 1; if (t < 0.9) return 1 - (t - 0.8) / 0.1; return 0; }
const lin = (len, n) => Array.from({ length: n + 1 }, (_, i) => len * i / n);
function gridPanel(xs, ys, w, h, zfn) {
  const pos = [], uv = [], idx = [], nx = xs.length, ny = ys.length;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { pos.push(xs[i] - w / 2, ys[j] - h / 2, zfn(xs[i], ys[j])); uv.push(xs[i] / w, ys[j] / h); }
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; idx.push(a, b, d, a, d, c); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals(); return g;
}
const dentN = new Noise(55);
const dent = (x, y, s) => (dentN.fbm(x * 0.5 + s, y * 0.5, 3) - 0.5) * 0.03;
function paintMat(map, rough, extra = {}) {
  return new THREE.MeshStandardMaterial({ map, roughnessMap: rough, roughness: 1, metalness: 0.28, bumpMap: rough, bumpScale: 0.6, envMapIntensity: 0.8, ...extra });
}
const cont = new THREE.Group();
const frameMat = paintMat(frameTex, frameRough, { color: 0xd8d8d8 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x15140f, roughness: 0.9 });
const steelMat = new THREE.MeshStandardMaterial({ map: frameTex, roughnessMap: frameRough, color: 0xbfc6bc, metalness: 0.55, roughness: 1 });
function box(w, h, d, x, y, z, mat = frameMat) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); cont.add(m); return m; }
{
  const hw = CH - 0.26, wl = CL - 0.3;
  const wallXs = profileXs(wl, 0.278), wallYs = lin(hw, 14);
  for (const s of [1, -1]) {
    const g = gridPanel(wallXs, wallYs, wl, hw, (x, y) => -0.036 * prof(x / 0.278) + dent(x, y, s * 10));
    const m = new THREE.Mesh(g, s > 0 ? paintMat(sideTex, sideRough) : paintMat(side2Tex, side2Rough));
    m.position.set(0, 0.16 + hw / 2, s * (CW / 2 - 0.035)); if (s < 0) m.rotation.y = Math.PI; cont.add(m);
  }
  // roof
  const rg = gridPanel(profileXs(CL - 0.2, 0.32), lin(CW - 0.18, 6), CL - 0.2, CW - 0.18, (x, y) => -0.014 * prof(x / 0.32) + dent(x, y, 3) * 0.6);
  rg.rotateX(-Math.PI / 2);
  const roof = new THREE.Mesh(rg, paintMat(roofTex, roofRough)); roof.position.set(0, CH - 0.035, 0); cont.add(roof);
  // back end
  const eg = gridPanel(profileXs(CW - 0.3, 0.28), lin(hw, 10), CW - 0.3, hw, (x, y) => -0.036 * prof(x / 0.28) + dent(x, y, 7));
  eg.rotateY(-Math.PI / 2);
  const end = new THREE.Mesh(eg, paintMat(endTex, endRough)); end.position.set(-CL / 2 + 0.035, 0.16 + hw / 2, 0); cont.add(end);
  // doors
  const dw = (CW - 0.3) / 2 - 0.006, dh = CH - 0.36;
  for (const k of [0, 1]) {
    const zc = (k === 0 ? 1 : -1) * (dw / 2 + 0.003);
    const dg = gridPanel(lin(dw, 6), profileXs(dh, dh / 5), dw, dh, (x, y) => -0.028 * prof(y / (dh / 5) + 0.15) + dent(x, y, 20 + k) * 0.4);
    dg.rotateY(Math.PI / 2);
    const dm = new THREE.Mesh(dg, paintMat(doorTexs[k].map, doorTexs[k].rough)); dm.position.set(CL / 2 - 0.03, 0.16 + dh / 2 + 0.02, zc); cont.add(dm);
    // leaf frame
    box(0.04, dh, 0.06, CL / 2 - 0.01, 0.18 + dh / 2, zc + dw / 2 - 0.03);
    box(0.04, dh, 0.06, CL / 2 - 0.01, 0.18 + dh / 2, zc - dw / 2 + 0.03);
    box(0.04, 0.09, dw, CL / 2 - 0.01, 0.18 + dh - 0.045, zc);
    box(0.04, 0.09, dw, CL / 2 - 0.01, 0.18 + 0.045, zc);
    // locking bars, brackets, handles, cams
    const sgn = k === 0 ? 1 : -1;
    for (const off of [0.28, 0.8]) {
      const z = sgn * off;
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, CH - 0.22, 12), steelMat); bar.position.set(CL / 2 + 0.035, CH / 2, z); cont.add(bar);
      for (const y of [0.42, 1.32, 2.1]) box(0.05, 0.07, 0.085, CL / 2 + 0.03, y, z, steelMat);
      box(0.075, 0.11, 0.1, CL / 2 + 0.035, CH - 0.17, z, steelMat);
      box(0.075, 0.11, 0.1, CL / 2 + 0.035, 0.18, z, steelMat);
      const hd = box(0.03, 0.04, 0.34, CL / 2 + 0.07, 1.02, z - sgn * 0.17 * (off < 0.5 ? -1 : 1), steelMat); hd.rotation.x = 0.05;
      box(0.03, 0.08, 0.05, CL / 2 + 0.05, 1.02, z - sgn * 0.33 * (off < 0.5 ? -1 : 1), steelMat);
    }
    for (const y of [0.42, 1.05, 1.68, 2.25]) {
      const hg = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.14, 10), steelMat); hg.position.set(CL / 2 + 0.02, y, sgn * (CW / 2 - 0.13)); cont.add(hg);
    }
  }
  box(0.02, dh, 0.012, CL / 2 - 0.015, 0.18 + dh / 2, 0, darkMat); // gasket gap
  // frame: posts, rails
  for (const sx of [1, -1]) for (const sz of [1, -1]) box(0.15, CH - 0.236, 0.15, sx * (CL / 2 - 0.075), CH / 2, sz * (CW / 2 - 0.075));
  for (const sz of [1, -1]) { box(CL - 0.356, 0.16, 0.1, 0, 0.08, sz * (CW / 2 - 0.05)); box(CL - 0.356, 0.1, 0.1, 0, CH - 0.05, sz * (CW / 2 - 0.05)); }
  for (const sx of [1, -1]) { box(0.15, 0.2, CW - 0.324, sx * (CL / 2 - 0.075), CH - 0.1, 0); box(0.15, 0.16, CW - 0.324, sx * (CL / 2 - 0.075), 0.08, 0); }
  // corner castings with holes
  const castMat = paintMat(frameTex, frameRough, { color: 0xb8b8b0 });
  for (const sx of [1, -1]) for (const sz of [1, -1]) for (const top of [0, 1]) {
    const x = sx * (CL / 2 - 0.089), y = top ? CH - 0.059 : 0.059, z = sz * (CW / 2 - 0.081);
    box(0.182, 0.12, 0.166, x, y, z, castMat);
    box(0.1, 0.05, 0.006, x, y, z + sz * 0.084, darkMat);
    box(0.006, 0.05, 0.07, x + sx * 0.092, y, z, darkMat);
    if (top) box(0.11, 0.006, 0.06, x, y + 0.061, z, darkMat);
  }
}
cont.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; regOcc(o); } });
cont.position.copy(CPOS);
cont.rotation.set(0.008, CROT, -0.012);
scene.add(cont);
cont.updateMatrixWorld(true);
const cLocal = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(cont.matrixWorld);

// beams falling onto the container and the clearing
const gp = (x, z) => new THREE.Vector3(x, heightAt(x, z), z);
addBeam(cLocal(1.1, 1.7, -CW / 2 - 0.04), 0.55, 1.0);
addBeam(cLocal(-1.6, 1.1, -CW / 2 - 0.04), 0.35, 0.9);
addBeam(cLocal(0.2, CH, 0.1), 0.6, 1.0);
addBeam(gp(4.5, -5), 1.0, 0.9);
addBeam(gp(-4, -7.5), 1.0, 0.8);
addBeam(gp(8, -1), 0.9, 0.8);
addBeam(gp(1, -10), 1.1, 0.8);
addBeam(gp(-9, 1), 0.8, 0.6);

// ======================================================================
// GROUND
// ======================================================================
status('growing ground…'); await tick();
{
  const g = new THREE.PlaneGeometry(240, 240, 360, 360); g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, heightAt(p.getX(i), p.getZ(i)));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1, color: 0xe8eadc }));
  m.receiveShadow = true; scene.add(m); regOcc(m);
}

// placement is tested against every framing so all device versions show the same scene
const camTan = (c) => { const tv = Math.tan(THREE.MathUtils.degToRad(c.fov / 2)); return [tv * c.aspect, tv]; };
function inView(p, margin = 1.15) {
  return allCams.some(c => {
    const v = p.clone().applyMatrix4(c.matrixWorldInverse), d = -v.z, [th, tv] = camTan(c);
    return d > 0.2 && Math.abs(v.x / d) < th * margin && Math.abs(v.y / d) < tv * margin;
  });
}
// inside the open view corridor between a camera and the container
function inCorridor(p, mx, extra = 3) {
  return allCams.some(c => {
    const v = p.clone().applyMatrix4(c.matrixWorldInverse), d = -v.z, [th] = camTan(c);
    return d > -2 && d < c.userData.dist + extra && Math.abs(v.x / Math.max(d, 0.1)) < th * mx;
  });
}
const nearCam = (x, z, r) => allCams.some(c => Math.hypot(x - c.position.x, z - c.position.z) < r);
const mainCam = allCams[0];
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3();
const col = new THREE.Color();

// grass blades
{
  const segs = 5, pos = [], colr = [], nrm = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, w = 0.5 * Math.pow(1 - t, 0.8) + 0.02, z = t * t * 0.35;
    pos.push(-w, t, z, w, t, z);
    const c = mix(0.45, 1.15, t); colr.push(c, c, c, c, c, c);
    nrm.push(0, 1, 0.35, 0, 1, 0.35);
    if (i < segs) { const a = i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  }
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  bg.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  bg.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  bg.setIndex(idx);
  const mats = [], cols = [];
  const addBlade = (x, y, z, hgt, wid, dry = 0) => {
    tmpP.set(x, y, z);
    tmpE.set(R(-0.35, 0.35), R(0, Math.PI * 2), R(-0.3, 0.3)); tmpQ.setFromEuler(tmpE);
    tmpS.set(wid, hgt, hgt); tmpM.compose(tmpP, tmpQ, tmpS); mats.push(tmpM.clone());
    const hcl = R(0.2, 0.27), s = R(0.32, 0.5), l = R(0.24, 0.40);
    col.setHSL(dry ? R(0.13, 0.17) : hcl, dry ? 0.3 : s, dry ? 0.45 : l, THREE.SRGBColorSpace); cols.push(col.clone());
  };
  let placed = 0;
  for (let a = 0; a < 4000000 && placed < 750000; a++) {
    const x = R(-42, 32), z = R(-34, 20);
    tmpP.set(x, 0, z);
    const dcam = Math.hypot(x - mainCam.position.x, z - mainCam.position.z);
    const sd = sdContainer(x, z);
    if (sd < -0.02) continue;
    const y = heightAt(x, z); tmpP.y = y + 0.2;
    if (!inView(tmpP, 1.08)) continue;
    const clump = nz3.fbm(x * 0.35, z * 0.35, 4);
    const dens = clamp(1.4 - dcam / 32, 0.12, 1) * (0.4 + 0.6 * smooth(0.25, 0.55, clump));
    if (rand() > dens) continue;
    const nearC = sd < 0.9;
    const hgt = (nearC ? R(0.15, 0.42) : R(0.1, 0.3) * (0.6 + clump)) * (0.55 + dcam / 25);
    addBlade(x, y - 0.02, z, hgt, R(0.022, 0.04) * (1 + dcam / 40), rand() < 0.06);
    placed++;
  }
  // tufts and moss grass on the roof
  for (let k = 0; k < 9000; k++) {
    const lx = R(-CL / 2 + 0.2, CL / 2 - 0.2), lz = R(-CW / 2 + 0.1, CW / 2 - 0.1);
    const v = nz3.fbm(lx * 0.8 + 50, lz * 0.8 + 50, 4) + (Math.abs(lz) / CW) * 0.4 + (lx / CL) * 0.1;
    if (v < 0.7) continue;
    const p = cLocal(lx, CH - 0.03, lz);
    addBlade(p.x, p.y, p.z, R(0.04, 0.14), R(0.02, 0.035));
  }
  const im = new THREE.InstancedMesh(bg, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.75, envMapIntensity: 0.6 }), mats.length);
  mats.forEach((m, i) => { im.setMatrixAt(i, m); im.setColorAt(i, cols[i]); });
  im.receiveShadow = true; im.frustumCulled = false; scene.add(im); regOcc(im);
  console.log('grass', mats.length);
}

// ======================================================================
// TREES / FOLIAGE
// ======================================================================
status('growing trees…'); await tick();
function translucent(mat, k) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSunView = { value: sunView }; sh.uniforms.uTrans = { value: k };
    sh.fragmentShader = 'uniform vec3 uSunView; uniform float uTrans;\n' + sh.fragmentShader.replace('#include <opaque_fragment>',
      'outgoingLight += diffuseColor.rgb * vec3(1.0,0.93,0.62) * pow(max(dot(-normalize(vViewPosition), uSunView),0.0),4.0) * uTrans;\n#include <opaque_fragment>');
  };
  return mat;
}
const trunkGeos = [], branchGeos = [], leafMs = [], leafCs = [], bushMs = [], bushCs = [];
function cyl(a, b, r0, r1, seg) {
  const d = b.clone().sub(a), L = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, L, seg, 1, true); g.translate(0, L / 2, 0);
  tmpQ.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); g.applyQuaternion(tmpQ); g.translate(a.x, a.y, a.z); return g;
}
function addCard(list, cl, c, size, hue) {
  tmpE.set(R(0, 6.28), R(0, 6.28), R(0, 6.28)); tmpQ.setFromEuler(tmpE);
  tmpS.set(size, size, size); list.push(new THREE.Matrix4().compose(c, tmpQ, tmpS));
  col.setHSL(hue + R(-0.02, 0.02), R(0.38, 0.56), R(0.4, 0.62), THREE.SRGBColorSpace); cl.push(col.clone());
}
function intrudes(q) {
  return allCams.some(c => {
    const v = q.clone().applyMatrix4(c.matrixWorldInverse), d = -v.z, [th, tv] = camTan(c);
    return d > 0 && d < c.userData.dist - 1 && Math.abs(v.x / d) < th * 0.8 && v.y / d < tv * 0.2;
  });
}
const trees = [];
const sunH = new THREE.Vector2(SUN.x, SUN.z).normalize();
for (let a = 0; a < 20000 && trees.length < 210; a++) {
  const ang = R(0, Math.PI * 2), rad = 7 + 85 * Math.pow(rand(), 0.8);
  const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad - 4;
  if (sdContainer(x, z) < 4.5) continue;
  const p = new THREE.Vector3(x, heightAt(x, z), z);
  if (inCorridor(p, 0.7)) continue;   // keep the view to the container open
  if (trees.some(t => Math.hypot(t.x - x, t.z - z) < 2.6)) continue;
  if (nearCam(x, z, 6)) continue;
  const sector = new THREE.Vector2(x, z).normalize().dot(sunH);
  if (rand() > 0.45 + 0.55 * smooth(-0.2, 0.7, sector)) continue;
  let blocked = false;
  for (let hh = 0; hh < 26; hh += 2) if (beamBlocked(new THREE.Vector3(x, p.y + hh, z), 0.6)) { blocked = true; break; }
  if (blocked) continue;
  trees.push(p);
}
{
  const fwd = new THREE.Vector3(), right = new THREE.Vector3();
  mainCam.getWorldDirection(fwd); right.crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const [th] = camTan(mainCam);
  for (const [side, depth, k] of [[1, 6.5, 0.92], [-1, 9.5, 0.9], [1, 17, 0.62]]) {
    const p = mainCam.position.clone().addScaledVector(fwd, depth).addScaledVector(right, side * th * depth * k);
    p.y = heightAt(p.x, p.z); p.big = true; trees.push(p);
  }
}
const saplings = [];
for (let a = 0; a < 8000 && saplings.length < 160; a++) {
  const ang = R(0, Math.PI * 2), rad = R(8, 50), x = Math.cos(ang) * rad, z = Math.sin(ang) * rad - 4;
  if (sdContainer(x, z) < 4) continue;
  const p = new THREE.Vector3(x, heightAt(x, z), z);
  if (inCorridor(p, 0.7)) continue;
  if (beamBlocked(p.clone().setY(p.y + 4), 0.8)) continue;
  if (nearCam(x, z, 6)) continue;
  p.small = true; saplings.push(p);
}
for (const p of [...trees, ...saplings]) {
  const h = p.small ? R(5, 10) : R(17, 30), rb = p.small ? R(0.06, 0.12) : p.big ? R(0.62, 0.8) : R(0.28, 0.62), lean = new THREE.Vector2(R(-0.6, 0.6), R(-0.6, 0.6));
  const g = new THREE.CylinderGeometry(rb * 0.35, rb, h, 16, 24); g.translate(0, h / 2, 0);
  const pa = g.attributes.position, ph = R(0, 100);
  const axis = (y) => new THREE.Vector3(lean.x * (y / h) * (y / h) * 1.5, y, lean.y * (y / h) * (y / h) * 1.5);
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), y = pa.getY(i), zz = pa.getZ(i), ang = Math.atan2(zz, x);
    const flare = 1 + 0.9 * Math.exp(-y * 1.6) * (0.7 + 0.3 * Math.sin(ang * 5 + ph));
    const bump = 1 + (nz.n(ang * 3 + ph, y * 0.8) - 0.5) * 0.12;
    const ax = axis(y);
    pa.setXYZ(i, x * flare * bump + ax.x, y, zz * flare * bump + ax.z);
  }
  g.computeVertexNormals(); g.translate(p.x, p.y - 0.4, p.z); trunkGeos.push(g);
  const far = Math.hypot(p.x, p.z) > 50;
  const clusters = [];
  const nb = far ? 4 : Math.round(R(7, 12)) + (p.big ? 4 : 0);
  for (let b = 0; b < nb; b++) {
    const hb = h * R(0.3, 0.9), az = R(0, 6.28), el = R(0.3, 0.9), L = R(2.2, 5.5) * (1.1 - hb / h * 0.5) * (p.small ? 0.4 : 1);
    const a0 = axis(hb).add(new THREE.Vector3(p.x, p.y - 0.4, p.z));
    const dir = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
    const a1 = a0.clone().addScaledVector(dir, L);
    if (!far && !intrudes(a1) && !intrudes(a0.clone().lerp(a1, 0.5))) branchGeos.push(cyl(a0, a1, rb * 0.22, rb * 0.07, 6));
    const cs = p.small ? 0.55 : 1;
    clusters.push([a1, R(1.5, 2.8) * cs], [a0.clone().lerp(a1, 0.55), R(1.0, 1.7) * cs]);
  }
  clusters.push([axis(h).add(new THREE.Vector3(p.x, p.y - 0.4, p.z)), R(2.2, 3.4) * (p.small ? 0.5 : 1)]);
  const hue = R(0.2, 0.25);
  for (const [c, r] of clusters) {
    const n = Math.round(r * r * (far ? 3 : p.small ? 9 : 5.5));
    for (let i = 0; i < n; i++) {
      const q = c.clone().add(new THREE.Vector3(R(-1, 1), R(-0.7, 0.8), R(-1, 1)).multiplyScalar(r));
      const s = R(0.9, 1.7) * (p.small ? 0.7 : 1);
      if (beamBlocked(q, s * 0.7) || nearCam(q.x, q.z, 5) || intrudes(q)) continue;
      addCard(leafMs, leafCs, q, s, hue);
    }
  }
}

// invisible canopy (outside the frame, toward the sun) that only casts dappled shadows
{
  const u = new THREE.Vector3(0, 1, 0).cross(SUN).normalize(), w = SUN.clone().cross(u).normalize();
  const Ms = [];
  for (let i = 0; i < 26000 && Ms.length < 11000; i++) {
    const t = R(13, 38), ox = R(-18, 18), oy = R(-18, 18);
    if (nz3.fbm(ox * 0.12 + t * 0.05 + 70, oy * 0.12 + 70, 4) < 0.45) continue;
    const c = new THREE.Vector3(0, 1.3, 0).addScaledVector(SUN, t).addScaledVector(u, ox).addScaledVector(w, oy);
    if (c.y < 5 || beamBlocked(c, 0.15)) continue;
    tmpE.set(R(0, 6.28), R(0, 6.28), R(0, 6.28)); tmpQ.setFromEuler(tmpE); const sz = R(1.1, 2.0); tmpS.set(sz, sz, sz);
    Ms.push(new THREE.Matrix4().compose(c, tmpQ, tmpS));
  }
  const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: leafTex, alphaTest: 0.42, side: THREE.DoubleSide, colorWrite: false, depthWrite: false }), Ms.length);
  Ms.forEach((m, i) => im.setMatrixAt(i, m)); im.castShadow = true; im.frustumCulled = false; scene.add(im);
}
// understory bushes
for (let k = 0, made = 0; k < 6000 && made < 300; k++) {
  const ang = R(0, 6.28), rad = R(5, 45), x = Math.cos(ang) * rad, z = Math.sin(ang) * rad - 3;
  const sd = sdContainer(x, z); if (sd < 2.4) continue;
  const p = new THREE.Vector3(x, heightAt(x, z), z);
  if (inCorridor(p, 0.5, -1)) continue;
  if (nearCam(x, z, 5)) continue;
  const r = R(0.7, 1.6), hue = R(0.2, 0.27);
  const c = p.clone().add(new THREE.Vector3(0, r * 0.6, 0));
  for (let i = 0; i < r * r * 22; i++) {
    const q = c.clone().add(new THREE.Vector3(R(-1, 1), R(-0.6, 0.7), R(-1, 1)).multiplyScalar(r));
    addCard(bushMs, bushCs, q, R(0.45, 0.85), hue);
  }
  made++;
}
{
  const bark1 = new THREE.MeshStandardMaterial({ map: bark.map, bumpMap: bark.bump, bumpScale: 3, roughness: 0.95, color: 0xd6d6cc });
  const tm = new THREE.Mesh(mergeGeometries(trunkGeos), bark1); tm.castShadow = tm.receiveShadow = true; scene.add(tm); regOcc(tm);
  const bm = new THREE.Mesh(mergeGeometries(branchGeos), bark1); bm.castShadow = bm.receiveShadow = true; scene.add(bm); regOcc(bm);
  const mk = (tex, Ms, Cs, k) => {
    const mat = translucent(new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.42, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.72, envMapIntensity: 0.7 }), k);
    const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, Ms.length);
    Ms.forEach((m, i) => { im.setMatrixAt(i, m); im.setColorAt(i, Cs[i]); });
    im.castShadow = im.receiveShadow = true; im.frustumCulled = false; scene.add(im);
    regOcc(im, new THREE.MeshBasicMaterial({ color: 0, map: tex, alphaTest: 0.42, side: THREE.DoubleSide, fog: false }));
  };
  mk(leafTex, leafMs, leafCs, 1.6); mk(bushTex, bushMs, bushCs, 1.0);
  console.log('trees', trees.length, 'leaf cards', leafMs.length, 'bush cards', bushMs.length);
}

// ferns
{
  const g = new THREE.PlaneGeometry(1, 0.32, 10, 2); g.rotateX(-Math.PI / 2); g.translate(0.5, 0, 0);
  const pa = g.attributes.position;
  for (let i = 0; i < pa.count; i++) { const x = pa.getX(i), z = pa.getZ(i); pa.setY(i, 0.75 * x - 0.85 * x * x - Math.abs(z) * 0.25 * x); }
  g.computeVertexNormals();
  const Ms = [], Cs = [];
  for (let k = 0, made = 0; k < 20000 && made < 700; k++) {
    const near = rand() < 0.5, x = near ? R(-5, 5) : R(-30, 26), z = near ? R(-4, 5) : R(-26, 14), sd = sdContainer(x, z);
    if (sd < 0.15) continue;
    const want = sd < 2.2 ? 0.35 : 0.12 * smooth(0.4, 0.7, nz3.fbm(x * 0.2 + 9, z * 0.2, 3));
    if (rand() > want) continue;
    const y = heightAt(x, z);
    if (!inView(new THREE.Vector3(x, y, z), 1.1)) continue;
    const sc = sd < 2.2 ? R(1.0, 1.7) : R(0.6, 1.3), n = Math.round(R(8, 12)), hue = R(0.2, 0.26);
    for (let f = 0; f < n; f++) {
      tmpE.set(R(-0.15, 0.15), f / n * 6.28 + R(-0.2, 0.2), R(-0.25, 0.1), 'YXZ'); tmpQ.setFromEuler(tmpE);
      const s = sc * R(0.75, 1.1); tmpS.set(s, s, s);
      Ms.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), tmpQ, tmpS));
      col.setHSL(hue, R(0.32, 0.45), R(0.42, 0.58), THREE.SRGBColorSpace); Cs.push(col.clone());
    }
    made++;
  }
  const mat = translucent(new THREE.MeshStandardMaterial({ map: fernTex, alphaTest: 0.4, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.7 }), 0.8);
  const im = new THREE.InstancedMesh(g, mat, Ms.length);
  Ms.forEach((m, i) => { im.setMatrixAt(i, m); im.setColorAt(i, Cs[i]); });
  im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; scene.add(im); regOcc(im);
}

// little white flowers
{
  const Ms = [], Cs = [];
  for (let k = 0; k < 40000 && Ms.length < 900; k++) {
    const x = R(-20, 18), z = R(-14, 15); if (sdContainer(x, z) < 0.3) continue;
    if (nz3.fbm(x * 0.4 + 3, z * 0.4 + 3, 3) < 0.55) continue;
    const y = heightAt(x, z); const p = new THREE.Vector3(x, y + R(0.12, 0.3), z);
    if (!inView(p)) continue;
    tmpE.set(-Math.PI / 2 + R(-0.4, 0.4), R(0, 6.28), 0, 'YXZ'); tmpQ.setFromEuler(tmpE); const s = R(0.03, 0.055); tmpS.set(s, s, s);
    Ms.push(new THREE.Matrix4().compose(p, tmpQ, tmpS));
    const t = rand(); col.setRGB(t < 0.7 ? 0.95 : 0.93, t < 0.7 ? 0.95 : 0.9, t < 0.7 ? 0.9 : 0.7, THREE.SRGBColorSpace); Cs.push(col.clone());
  }
  const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ map: flowerTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6 }), Ms.length);
  Ms.forEach((m, i) => { im.setMatrixAt(i, m); im.setColorAt(i, Cs[i]); }); im.receiveShadow = true; im.frustumCulled = false; scene.add(im); regOcc(im);
}

// mossy rocks
{
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const spots = [[0.5, -1.9, 0.5], [2.2, -1.75, 0.35], [-2.4, -1.8, 0.45], [3.6, -0.9, 0.4], [3.5, 0.9, 0.3], [-3.6, 0.6, 0.5], [1.0, 1.9, 0.6]]
    .map(([lx, lz, s]) => { const q = cLocal(lx, 0, lz); return [q.x, q.z, s]; });
  spots.push([-4.5, 4.5, 0.35], [5.5, 3.0, 0.5], [-6, -3, 0.6]);
  for (const [x, z, s] of spots) {
    const g = new THREE.IcosahedronGeometry(1, 5), pa = g.attributes.position, cl = [];
    for (let i = 0; i < pa.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pa, i); const n = nz2.fbm(v.x * 1.5 + x, v.y * 1.5 + v.z * 1.3 + z, 5);
      v.multiplyScalar(0.75 + n * 0.5); v.y *= 0.45; pa.setXYZ(i, v.x, v.y, v.z);
      const mossy = smooth(-0.3, 0.3, v.y + (n - 0.5));
      col.setRGB(mix(0.42, 0.33, mossy), mix(0.42, 0.42, mossy), mix(0.38, 0.2, mossy), THREE.SRGBColorSpace); cl.push(col.r, col.g, col.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cl, 3)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, rockMat); m.scale.setScalar(s); m.position.set(x, heightAt(x, z) - s * 0.15, z); m.rotation.y = R(0, 6);
    m.castShadow = m.receiveShadow = true; scene.add(m); regOcc(m);
  }
}


// ======================================================================
// IVY, LEAF LITTER, STICKS
// ======================================================================
status('growing ivy…'); await tick();
function singleLeafTexture(lobed) {
  const S = 128, c = makeCanvas(S, S), ctx = c.getContext('2d');
  ctx.translate(S / 2, S * 0.92);
  ctx.fillStyle = '#dcdcd4';
  ctx.beginPath();
  if (lobed) { // ivy-like, three soft lobes
    ctx.moveTo(0, 0); ctx.bezierCurveTo(-60, -10, -62, -55, -30, -62); ctx.bezierCurveTo(-26, -86, -8, -104, 0, -112);
    ctx.bezierCurveTo(8, -104, 26, -86, 30, -62); ctx.bezierCurveTo(62, -55, 60, -10, 0, 0);
  } else {
    ctx.moveTo(0, 0); ctx.bezierCurveTo(46, -20, 36, -86, 0, -112); ctx.bezierCurveTo(-36, -86, -46, -20, 0, 0);
  }
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,120,110,0.7)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -104);
  for (const a of [-1, 1]) for (const y of [-30, -55, -78]) { ctx.moveTo(0, y); ctx.lineTo(a * 26, y - 16); }
  ctx.stroke();
  return toTex(c, true, false);
}
const ivyTex = singleLeafTexture(true), litterTex = singleLeafTexture(false);
{
  const Ms = [], Cs = [], stems = [];
  const Z = new THREE.Vector3(0, 0, 1);
  const leafAt = (p, n, sz, hue, droop = 0.5) => {
    const nn = n.clone().add(new THREE.Vector3(R(-0.5, 0.5), R(-droop, 0.3), R(-0.5, 0.5))).normalize();
    tmpQ.setFromUnitVectors(Z, nn);
    const spin = new THREE.Quaternion().setFromAxisAngle(nn, R(-0.9, 0.9) + Math.PI); // leaf tips hang down
    tmpQ.premultiply(spin);
    tmpS.set(sz, sz, sz); Ms.push(new THREE.Matrix4().compose(p.clone().addScaledVector(nn, 0.01), tmpQ, tmpS));
    col.setHSL(hue + R(-0.015, 0.015), R(0.38, 0.55), R(0.28, 0.46), THREE.SRGBColorSpace); Cs.push(col.clone());
  };
  // faces in container-local space: origin of the face's top edge, along-face direction, outward normal
  const faces = {
    side: { at: (u, y) => cLocal(u, y, -CW / 2 - 0.045), n: cLocal(0, 0, -1).sub(cLocal(0, 0, 0)).normalize(), u0: -CL / 2, u1: CL / 2 },
    door: { at: (u, y) => cLocal(CL / 2 + 0.06, y, u), n: cLocal(1, 0, 0).sub(cLocal(0, 0, 0)).normalize(), u0: -CW / 2, u1: CW / 2 },
  };
  const strand = (face, u, y0, len, dirY, hue) => {
    const f = faces[face], pts = [];
    let uu = u, y = y0; const ph = R(0, 100);
    for (let t = 0; t < len; t += 0.035) {
      y += dirY * 0.035; uu += (nz.n(ph, t * 2.5) - 0.5) * 0.05;
      if (y < 0.05 || y > CH - 0.02) break;
      const p = f.at(clamp(uu, f.u0 + 0.05, f.u1 - 0.05), y); pts.push(p);
      const taper = 1 - 0.5 * t / len;
      for (let k = 0; k < 2; k++) leafAt(p.clone().add(new THREE.Vector3(R(-0.04, 0.04), R(-0.03, 0.03), R(-0.04, 0.04))), f.n, R(0.07, 0.12) * taper, hue);
    }
    if (pts.length > 3) stems.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length, 0.006, 4));
  };
  const hue = 0.25;
  // curtain over the right part of the long side, a few in the middle, door corner on the left
  for (let i = 0; i < 22; i++) strand('side', R(0.9, 2.95), CH - 0.02, R(0.5, 2.5), -1, hue);
  for (let i = 0; i < 7; i++) strand('side', R(-0.8, 0.6), CH - 0.02, R(0.2, 1.1), -1, hue);
  for (let i = 0; i < 12; i++) strand('side', R(-2.9, 2.9), 0.06, R(0.3, 1.6), 1, hue);
  for (let i = 0; i < 9; i++) strand('door', R(-1.15, -0.5), CH - 0.02, R(0.3, 1.9), -1, hue);
  for (let i = 0; i < 6; i++) strand('door', R(-1.2, 1.2), 0.06, R(0.2, 1.2), 1, hue);
  // mats of ivy spilling over the roof edges
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 1500; i++) {
    const zone = rand();
    const lx = zone < 0.55 ? R(0.8, CL / 2 - 0.05) : zone < 0.8 ? R(-1, 0.6) : R(CL / 2 - 0.7, CL / 2 - 0.05);
    const lz = zone < 0.8 ? -CW / 2 + Math.pow(rand(), 2) * 1.1 : R(-CW / 2, 0.2);
    if (nz3.fbm(lx * 1.5 + 9, lz * 1.5, 3) < 0.42) continue;
    leafAt(cLocal(lx, CH + 0.015, lz), up, R(0.07, 0.13), hue, 0.2);
  }
  const mat = translucent(new THREE.MeshStandardMaterial({ map: ivyTex, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.55, envMapIntensity: 0.8 }), 1.0);
  const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, Ms.length);
  Ms.forEach((m, i) => { im.setMatrixAt(i, m); im.setColorAt(i, Cs[i]); });
  im.castShadow = im.receiveShadow = true; im.frustumCulled = false; scene.add(im);
  regOcc(im, new THREE.MeshBasicMaterial({ color: 0, map: ivyTex, alphaTest: 0.5, side: THREE.DoubleSide, fog: false }));
  const sm = new THREE.Mesh(mergeGeometries(stems), new THREE.MeshStandardMaterial({ color: 0x3d3524, roughness: 0.9 }));
  sm.castShadow = true; scene.add(sm); regOcc(sm);
  console.log('ivy leaves', Ms.length);
}
// fallen leaves around the container
{
  const Ms = [], Cs = [];
  for (let i = 0; i < 30000 && Ms.length < 7000; i++) {
    const x = R(-9, 9), z = R(-7, 9), sd = sdContainer(x, z);
    if (sd < 0.02 || rand() > Math.exp(-sd * 0.45)) continue;
    const p = new THREE.Vector3(x, heightAt(x, z) + 0.012, z);
    if (!inView(p)) continue;
    tmpE.set(-Math.PI / 2 + R(-0.3, 0.3), R(0, 6.28), R(-0.3, 0.3), 'YXZ'); tmpQ.setFromEuler(tmpE);
    const sz = R(0.06, 0.12); tmpS.set(sz, sz, sz); Ms.push(new THREE.Matrix4().compose(p, tmpQ, tmpS));
    col.setHSL(R(0.05, 0.11), R(0.3, 0.5), R(0.25, 0.42), THREE.SRGBColorSpace); Cs.push(col.clone());
  }
  const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ map: litterTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85 }), Ms.length);
  Ms.forEach((m, i) => { im.setMatrixAt(i, m); im.setColorAt(i, Cs[i]); });
  im.receiveShadow = true; im.frustumCulled = false; scene.add(im); regOcc(im);
}
// fallen sticks
{
  const geos = [];
  for (const [x, z, a, L] of [[-1.5, 3.2, 0.4, 1.6], [2.2, 4.0, -0.9, 1.1], [-3.4, 1.8, 1.4, 2.2], [0.8, 5.5, 2.4, 0.9], [3.8, 2.0, 0.1, 1.4]]) {
    const p0 = new THREE.Vector3(x, heightAt(x, z) + 0.03, z), d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const p1 = p0.clone().addScaledVector(d, L); p1.y = heightAt(p1.x, p1.z) + 0.02;
    geos.push(cyl(p0, p1, 0.035, 0.015, 6));
    const mid = p0.clone().lerp(p1, 0.5), tw = mid.clone().add(new THREE.Vector3(R(-0.3, 0.3), 0.06, R(-0.3, 0.3)));
    geos.push(cyl(mid, tw, 0.012, 0.005, 5));
  }
  const m = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ map: bark.map, roughness: 0.95, color: 0xb8b0a0 }));
  m.castShadow = m.receiveShadow = true; scene.add(m); regOcc(m);
}

// ======================================================================
// LIGHT SHAFTS + DUST
// ======================================================================
{
  const shaftMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uColor: { value: new THREE.Color().setRGB(1.0, 0.88, 0.66) }, uK: { value: 1 } },
    vertexShader: `varying vec3 vN; varying vec3 vV; varying float vT; varying float vD;
      void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); vN = normalize(normalMatrix*normal); vV = -mv.xyz; vT = uv.y; vD = length(mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uK; varying vec3 vN; varying vec3 vV; varying float vT; varying float vD;
      void main(){ float e = abs(dot(normalize(vN), normalize(vV))); e = pow(e, 2.2);
        float along = smoothstep(0.0, 0.05, vT) * (1.0 - smoothstep(0.35, 1.0, vT));
        float a = e * along * uK * 0.13 * exp(-vD*0.010) * smoothstep(5.0, 13.0, vD);
        gl_FragColor = vec4(uColor * a, 1.0); }`
  });
  for (const b of beams) {
    const len = 48;
    const g = new THREE.CylinderGeometry(b.r * 1.15, b.r * 0.95, len, 32, 1, true); g.translate(0, len / 2, 0);
    const m = new THREE.Mesh(g, shaftMat.clone()); m.material.uniforms.uK.value = b.k;
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), SUN); m.position.copy(b.p).addScaledVector(SUN, -0.3);
    scene.add(m); hideInOcc.push(m);
  }
  // dust motes drifting in the beams
  const pts = [];
  for (const b of beams) for (let i = 0; i < 700 * b.r; i++) {
    const t = R(0.3, 14), ang = R(0, 6.28), rr = b.r * Math.sqrt(rand());
    const u = new THREE.Vector3(1, 0, 0).cross(SUN).normalize(), w = SUN.clone().cross(u);
    const p = b.p.clone().addScaledVector(SUN, t).addScaledVector(u, Math.cos(ang) * rr).addScaledVector(w, Math.sin(ang) * rr);
    pts.push(p.x, p.y, p.z);
  }
  const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const pm = new THREE.PointsMaterial({ map: softDot(), size: 0.022, color: new THREE.Color().setRGB(1, 0.92, 0.75), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const dust = new THREE.Points(pg, pm); scene.add(dust); hideInOcc.push(dust);
}

// ======================================================================
// POST: god rays (occlusion + radial blur), bloom, grade
// ======================================================================
status('rendering…'); await tick();
const occRT = new THREE.WebGLRenderTarget(W / 2, H / 2, { type: THREE.HalfFloatType });
const raysRT = new THREE.WebGLRenderTarget(W / 2, H / 2, { type: THREE.HalfFloatType });
const sunScreen = SUN.clone().multiplyScalar(500).add(camera.position).project(camera);
const sunUV = new THREE.Vector2(sunScreen.x * 0.5 + 0.5, sunScreen.y * 0.5 + 0.5);
console.log('sun uv', sunUV.x.toFixed(2), sunUV.y.toFixed(2));
const raysQuad = new FullScreenQuad(new THREE.ShaderMaterial({
  uniforms: { tOcc: { value: occRT.texture }, uSun: { value: sunUV }, uDensity: { value: 0.32 }, uDecay: { value: 0.988 }, uWeight: { value: 0.022 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }',
  fragmentShader: `uniform sampler2D tOcc; uniform vec2 uSun; uniform float uDensity, uDecay, uWeight; varying vec2 vUv;
    void main(){ vec2 tc=vUv; vec2 dlt=(tc-uSun)*uDensity/160.; float il=1.; vec3 c=vec3(0.);
      for(int i=0;i<160;i++){ tc-=dlt; vec3 s=texture2D(tOcc, clamp(tc,0.001,0.999)).rgb; c+=s*il*uWeight; il*=uDecay; }
      gl_FragColor=vec4(c,1.); }`
}));

const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 8 });
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(1); composer.setSize(W, H);
composer.addPass(new RenderPass(scene, camera));
const raysPass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, tRays: { value: raysRT.texture }, uColor: { value: new THREE.Vector3(1.0, 0.86, 0.62) }, uK: { value: 1.25 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
  fragmentShader: `uniform sampler2D tDiffuse, tRays; uniform vec3 uColor; uniform float uK; varying vec2 vUv;
    void main(){ vec4 c=texture2D(tDiffuse,vUv); vec3 r=texture2D(tRays,vUv).rgb; gl_FragColor=vec4(c.rgb + r*uColor*uK, c.a); }`
});
raysPass.uniforms.tRays.value = raysRT.texture;
composer.addPass(raysPass);
composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), 0.22, 0.7, 0.92));
composer.addPass(new OutputPass());
composer.addPass(new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uRes: { value: new THREE.Vector2(W, H) } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uRes; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
    void main(){ vec3 c=texture2D(tDiffuse,vUv).rgb;
      float l=dot(c,vec3(0.299,0.587,0.114)); c=mix(vec3(l),c,0.97);           // soften saturation
      c = c*0.97 + vec3(0.018,0.024,0.014);                                     // gentle matte lift
      c = mix(c, c*vec3(1.03,1.0,0.94), smoothstep(0.4,1.0,l));               // warm highlights
      vec2 q=vUv-0.5; q.x*=uRes.x/uRes.y; c*=1.0-0.28*smoothstep(0.35,1.05,length(q));  // vignette
      c += (h(vUv*uRes)-0.5)*0.018;                                            // fine grain
      gl_FragColor=vec4(c,1.); }`
}));

function renderFrame() {
  // occlusion pass
  for (const o of occList) o.obj.material = o.occ;
  for (const o of hideInOcc) o.visible = false;
  skyUniforms.uOcc.value = 1; const fog = scene.fog; scene.fog = null; const env = scene.environment; scene.environment = null;
  renderer.setRenderTarget(occRT); renderer.render(scene, camera);
  renderer.setRenderTarget(raysRT); raysQuad.render(renderer);
  renderer.setRenderTarget(null);
  for (const o of occList) o.obj.material = o.mat;
  for (const o of hideInOcc) o.visible = true;
  skyUniforms.uOcc.value = 0; scene.fog = fog; scene.environment = env;
  composer.render();
}
renderFrame();
await new Promise(r => requestAnimationFrame(r));
renderFrame();
status('done');
window.__done = true;
if (SAVE) {
  renderer.domElement.toBlob(async (b) => {
    await fetch('/save?name=' + encodeURIComponent(SAVE), { method: 'POST', body: b });
    status('saved ' + SAVE); window.__saved = true;
  }, 'image/png');
}
