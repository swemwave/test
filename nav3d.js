import { parseCSV } from "./csv.js";
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js";

const MARKER_NEAR = 2.0;
const MARKER_FAR = 12.0;
const MARKER_SPEED = 2.2; // units per second
const MARKER_RISE = 3.0; // vertical rise from bottom to target
const TRAIL_POINTS = 220;
const TRAIL_COLOR = 0x4bb4ff;
const TRAIL_OPACITY = 0.7;
const TRAIL_SIZE = 0.48;
const TRAIL_TAPER = 1.9;
const TRAIL_JITTER = 0.06;
const PIXEL_RATIO_CAP = 2;
const DEFAULT_PITCH = 0;

async function tryFetchText(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return "";
    return await r.text();
  } catch {
    return "";
  }
}

function normalize180(deg) {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

function bearingDeg(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const rad = Math.atan2(dx, -dy);
  return ((rad * 180 / Math.PI) + 360) % 360;
}

function dirFromYawPitch(yawDeg, pitchDeg) {
  const yaw = THREE.MathUtils.degToRad(yawDeg);
  const pitch = THREE.MathUtils.degToRad(pitchDeg);
  const cosP = Math.cos(pitch);
  return new THREE.Vector3(
    Math.sin(yaw) * cosP,
    Math.sin(pitch),
    -Math.cos(yaw) * cosP
  );
}

function hfovToVfov(hfovDeg, aspect) {
  const hfov = THREE.MathUtils.degToRad(hfovDeg);
  const vfov = 2 * Math.atan(Math.tan(hfov / 2) / aspect);
  return THREE.MathUtils.radToDeg(vfov);
}

function buildMarker() {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x2f8bff,
    roughness: 0.28,
    metalness: 0.18,
    emissive: 0x0b2c4a,
    emissiveIntensity: 0.55,
  });
  const headMat = new THREE.MeshStandardMaterial({
    color: 0x9ad0ff,
    roughness: 0.22,
    metalness: 0.12,
    emissive: 0x164f78,
    emissiveIntensity: 0.7,
  });
  const glowMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.15,
    metalness: 0.0,
    emissive: 0x6ec2ff,
    emissiveIntensity: 1.0,
    transparent: true,
    opacity: 0.65,
  });

  const shaftGeom = new THREE.BoxGeometry(0.22, 0.12, 1.0);
  const shaft = new THREE.Mesh(shaftGeom, bodyMat);
  shaft.position.z = -0.6;

  const headGeom = new THREE.ConeGeometry(0.28, 0.6, 24);
  headGeom.rotateX(-Math.PI / 2);
  const head = new THREE.Mesh(headGeom, headMat);
  head.position.z = -1.3;

  const finGeom = new THREE.BoxGeometry(0.02, 0.18, 0.35);
  const finLeft = new THREE.Mesh(finGeom, bodyMat);
  finLeft.position.set(-0.12, 0, -0.25);

  const finRight = finLeft.clone();
  finRight.position.x = 0.12;

  const stripeGeom = new THREE.BoxGeometry(0.06, 0.02, 0.4);
  const stripe = new THREE.Mesh(stripeGeom, glowMat);
  stripe.position.set(0, 0.05, -0.55);

  group.add(shaft, head, finLeft, finRight, stripe);
  group.scale.setScalar(1.6);
  return group;
}

export async function createNav3D(opts) {
  const {
    viewer,
    nodesUrl,
    edgesUrl,
    manualEdgesUrl,
    scenesUrl,
  } = opts;

  const container = viewer.getContainer ? viewer.getContainer() : document.getElementById("panorama");
  const canvas = document.createElement("canvas");
  canvas.className = "nav3d-canvas";
  container.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  camera.position.set(0, 0, 0);
  camera.rotation.order = "YXZ";

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(1, 1, 1);
  scene.add(dirLight);

  const marker = buildMarker();
  scene.add(marker);
  const markerBaseScale = marker.scale.x;
  let markerDir = null;
  let markerStartTime = performance.now();
  let lastSize = { w: 0, h: 0, dpr: 0 };

  const trailPositions = new Float32Array(TRAIL_POINTS * 3);
  const trailColors = new Float32Array(TRAIL_POINTS * 3);
  const trailSizes = new Float32Array(TRAIL_POINTS);
  const trailGeometry = new THREE.BufferGeometry();
  trailGeometry.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
  trailGeometry.setAttribute("color", new THREE.BufferAttribute(trailColors, 3));
  trailGeometry.setAttribute("size", new THREE.BufferAttribute(trailSizes, 1));
  const trailMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uSize: { value: TRAIL_SIZE },
      uOpacity: { value: TRAIL_OPACITY },
    },
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      float s = size * 70.0 / -mvPosition.z;
        gl_PointSize = s;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      varying vec3 vColor;
      void main() {
        vec2 uv = gl_PointCoord.xy - vec2(0.5);
        float d = dot(uv, uv);
        float alpha = smoothstep(0.25, 0.0, d) * uOpacity;
        gl_FragColor = vec4(vColor, alpha);
      }
    `,
  });
  const trailPoints = new THREE.Points(trailGeometry, trailMaterial);
  trailPoints.visible = false;
  trailPoints.frustumCulled = false;
  scene.add(trailPoints);
  const trail = [];
  const jitterSeed = Array.from({ length: TRAIL_POINTS }, () => ({
    x: Math.random() - 0.5,
    y: Math.random() - 0.5,
    z: Math.random() - 0.5,
  }));

  const [nodesTxt, edgesTxt, manualTxt, scenesTxt] = await Promise.all([
    tryFetchText(nodesUrl),
    tryFetchText(edgesUrl),
    tryFetchText(manualEdgesUrl),
    tryFetchText(scenesUrl),
  ]);

  const nodes = parseCSV(nodesTxt).map(r => ({
    id: r.id,
    x: Number(r.x),
    y: Number(r.y),
    headingDeg: Number(r.headingDeg),
  })).filter(n => n.id && Number.isFinite(n.x) && Number.isFinite(n.y));
  const nodesById = new Map(nodes.map(n => [n.id, n]));

  const scenesRows = parseCSV(scenesTxt);
  const idBySceneKey = new Map(scenesRows.map(r => [
    r.filename.replace(/\.[^.]+$/, ""), r.id,
  ]));
  const sceneKeyById = new Map(scenesRows.map(r => [
    r.id, r.filename.replace(/\.[^.]+$/, ""),
  ]));

  const edgeRows = [
    ...parseCSV(edgesTxt),
    ...parseCSV(manualTxt),
  ].map(e => ({
    from: (e.from ?? "").trim(),
    to: (e.to ?? "").trim(),
  })).filter(e => e.from && e.to);

  const nextById = new Map();
  for (const e of edgeRows) {
    if (!nextById.has(e.from)) nextById.set(e.from, e.to);
  }

  function updateMarker(sceneKey) {
    const id = idBySceneKey.get(sceneKey);
    const nextId = nextById.get(id);
    if (!id || !nextId) {
      marker.visible = false;
      trailPoints.visible = false;
      return;
    }

    const fromNode = nodesById.get(id);
    const toNode = nodesById.get(nextId);
    if (!fromNode || !toNode) {
      marker.visible = false;
      trailPoints.visible = false;
      return;
    }

    const brg = bearingDeg(fromNode.x, fromNode.y, toNode.x, toNode.y);
    const yaw = normalize180(brg - fromNode.headingDeg);
    const dir = dirFromYawPitch(yaw, DEFAULT_PITCH).normalize();
    markerDir = dir;
    markerStartTime = performance.now();

    marker.position.copy(dir).multiplyScalar(MARKER_NEAR);
    marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
    marker.visible = true;
    trail.length = 0;
    trailPoints.visible = true;
  }

  function syncSize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP);
    if (w === lastSize.w && h === lastSize.h && dpr === lastSize.dpr) return;
    lastSize = { w, h, dpr };
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
  }

  function syncCamera() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    const aspect = w / h;
    camera.aspect = aspect;

    const hfov = viewer.getHfov ? viewer.getHfov() : 90;
    if (!Number.isFinite(hfov)) return;
    camera.fov = hfovToVfov(hfov, aspect);

    const yaw = viewer.getYaw ? viewer.getYaw() : 0;
    const pitch = viewer.getPitch ? viewer.getPitch() : 0;
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    const lookDir = dirFromYawPitch(yaw, pitch);
    camera.up.set(0, 1, 0);
    camera.lookAt(lookDir);
    camera.updateProjectionMatrix();
  }

  window.addEventListener("resize", syncSize);
  window.addEventListener("orientationchange", syncSize);
  document.addEventListener("fullscreenchange", syncSize);
  syncSize();

  viewer.on("scenechange", (sceneKey) => {
    updateMarker(sceneKey);
  });

  const initialScene = viewer.getScene ? viewer.getScene() : null;
  if (initialScene) updateMarker(initialScene);

  function render() {
    syncSize();
    syncCamera();

    if (marker.visible && markerDir) {
      const elapsed = (performance.now() - markerStartTime) / 1000;
      const span = Math.max(0.1, MARKER_FAR - MARKER_NEAR);
      const travel = (elapsed * MARKER_SPEED) % span;
      const dist = MARKER_NEAR + travel;
      const t = (dist - MARKER_NEAR) / span;
      const ease = 1 - Math.cos(t * Math.PI * 0.5);

      const rise = -MARKER_RISE * (1 - ease);
      marker.position.copy(markerDir).multiplyScalar(dist);
      marker.position.y += rise;

      const scale = markerBaseScale * (0.85 + 0.25 * Math.sin(t * Math.PI));
      marker.scale.setScalar(scale);

      trail.push(marker.position.clone());
      if (trail.length > TRAIL_POINTS) trail.shift();
      const last = trail[trail.length - 1];
      const baseColor = new THREE.Color(TRAIL_COLOR);
      for (let i = 0; i < TRAIL_POINTS; i++) {
        const p = trail[i] || last;
        const idx = i * 3;
        const fadeRaw = i / Math.max(1, TRAIL_POINTS - 1);
        const fade = Math.pow(fadeRaw, TRAIL_TAPER);
        const jitter = (1 - fadeRaw) * TRAIL_JITTER;
        const seed = jitterSeed[i];
        trailPositions[idx] = p.x + seed.x * jitter;
        trailPositions[idx + 1] = p.y + seed.y * jitter;
        trailPositions[idx + 2] = p.z + seed.z * jitter;
        trailColors[idx] = baseColor.r * fade;
        trailColors[idx + 1] = baseColor.g * fade;
        trailColors[idx + 2] = baseColor.b * fade;
        trailSizes[i] = TRAIL_SIZE * (0.55 + fade * 0.9);
      }
      trailGeometry.setDrawRange(0, Math.max(2, trail.length));
      trailGeometry.attributes.position.needsUpdate = true;
      trailGeometry.attributes.color.needsUpdate = true;
      trailGeometry.attributes.size.needsUpdate = true;
    }

    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }
  render();
}
