import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const SCENES_CSV = path.join(ROOT, "scenedata", "scenes.csv");
const SCENES_DIR = path.join(ROOT, "scenes");
const OUT_EDGES  = path.join(ROOT, "scenedata", "edges.csv");
const OUT_NODES  = path.join(ROOT, "scenedata", "nodes.csv");
const OUT_TOUR   = path.join(ROOT, "scenedata", "tour.json");

const DEFAULT_STEP = 5;
const LINK_RADIUS = 7;        // meters. Try 6-8 for 5m spacing
const MAX_LINKS_PER_NODE = 6; // prevent hotspot clutter


// --- CSV parsing (supports quotes) ---
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  const header = parseLine(lines.shift()).map(h => h.trim());
  const rows = [];
  for (const line of lines) {
    const cols = parseLine(line);
    const row = {};
    header.forEach((h, i) => row[h] = (cols[i] ?? "").trim());
    rows.push(row);
  }
  return rows;
}
function parseLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function sceneKeyFromFilename(filename) {
  return filename.replace(/\.[^.]+$/, "");
}

function headingToDeg(h) {
  if (!h) return NaN;
  const s = h.trim().toUpperCase();
  // allow raw degrees
  if (/^-?\d+(\.\d+)?$/.test(s)) return ((Number(s) % 360) + 360) % 360;

  const map = {
    N: 0, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
    S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5
  };
  if (map[s] === undefined) return NaN;
  return map[s];
}

function normalize180(deg) {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

function bearingDeg(ax, ay, bx, by) {
  // Our dead-reckoning makes y decrease when going North (Cartesian-ish)
  // Use bearing convention: 0=North(up), 90=East(right)
  const dx = bx - ax;
  const dy = by - ay;
  const rad = Math.atan2(dx, -dy);
  return ((rad * 180 / Math.PI) + 360) % 360;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// --- main ---
if (!fs.existsSync(SCENES_CSV)) throw new Error("Missing data/scenes.csv");

const rows = parseCsv(fs.readFileSync(SCENES_CSV, "utf8"));

// Sort by numeric id (01..)
rows.sort((a, b) => Number(a.id) - Number(b.id));

// Build scene table
const scenes = rows.map(r => {
  const sceneKey = sceneKeyFromFilename(r.filename);
  const headingDeg = headingToDeg(r.heading);
  if (!Number.isFinite(headingDeg)) {
    throw new Error(`Invalid heading "${r.heading}" for id ${r.id}. Use N/NE/E... or degrees.`);
  }
  const stepMeters = toNum(r.stepMeters, DEFAULT_STEP);
  return {
    id: r.id,
    sceneKey,
    notes: r.notes || sceneKey,
    headingDeg,
    stepMeters
  };
});

// 1) edges.csv (sequential + bidirectional handled later in tour build)
let edgesCsv = "from,to\n";
for (let i = 0; i < scenes.length - 1; i++) {
  edgesCsv += `${scenes[i].id},${scenes[i+1].id}\n`;
}
fs.mkdirSync(path.dirname(OUT_EDGES), { recursive: true });
fs.writeFileSync(OUT_EDGES, edgesCsv, "utf8");
console.log(`Wrote ${OUT_EDGES}`);

// 2) nodes.csv (dead-reckoned)
let x = 0, y = 0;
const nodes = [];
nodes.push({ id: scenes[0].id, x, y, headingDeg: scenes[0].headingDeg });

for (let i = 1; i < scenes.length; i++) {
  const prev = scenes[i - 1];
  const cur = scenes[i];

  const theta = (prev.headingDeg * Math.PI) / 180;
  const d = cur.stepMeters; // distance from prev->cur
  x += d * Math.sin(theta);
  y -= d * Math.cos(theta);

  nodes.push({ id: cur.id, x, y, headingDeg: cur.headingDeg });
}

let nodesCsv = "id,x,y,headingDeg\n";
for (const n of nodes) {
  nodesCsv += `${n.id},${n.x.toFixed(3)},${n.y.toFixed(3)},${n.headingDeg}\n`;
}
fs.writeFileSync(OUT_NODES, nodesCsv, "utf8");
console.log(`Wrote ${OUT_NODES}`);

// 3) Build neighbors: sequential + proximity-based (quad-direction friendly)
const neigh = new Map();
function addNeighbor(a, b) {
  if (!neigh.has(a)) neigh.set(a, new Set());
  neigh.get(a).add(b);
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx*dx + dy*dy);
}

// Always keep sequential links
for (let i = 0; i < scenes.length - 1; i++) {
  const a = scenes[i].id;
  const b = scenes[i + 1].id;
  addNeighbor(a, b);
  addNeighbor(b, a);
}

// Add proximity links (intersection/loop closure)
for (let i = 0; i < scenes.length; i++) {
  const aId = scenes[i].id;
  const aNode = nodeById.get(aId);

  // Build list of candidates within radius
  const candidates = [];
  for (let j = 0; j < scenes.length; j++) {
    if (i === j) continue;
    const bId = scenes[j].id;
    const bNode = nodeById.get(bId);

    const d = dist(aNode, bNode);
    if (d <= LINK_RADIUS) {
      candidates.push({ bId, d });
    }
  }

  // Sort nearest first and add until MAX_LINKS_PER_NODE
  candidates.sort((p, q) => p.d - q.d);

  for (const c of candidates) {
    addNeighbor(aId, c.bId);
    addNeighbor(c.bId, aId);

    if (neigh.get(aId).size >= MAX_LINKS_PER_NODE) break;
  }
}


const scenesObj = {};
for (const s of scenes) {
  const cfgPath = path.join(SCENES_DIR, s.sceneKey, "config.json");
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`Missing config.json for ${s.sceneKey} in ./scenes/${s.sceneKey}/`);
  }
  const cfg = readJson(cfgPath);

  const fromNode = nodeById.get(s.id);
  const startYaw = normalize180(-fromNode.headingDeg); // always load facing North

  const nbs = [...(neigh.get(s.id) || [])];

  const hotSpots = nbs.map(toId => {
    const toScene = scenes.find(z => z.id === toId);
    const toNode = nodeById.get(toId);

    const brg = bearingDeg(fromNode.x, fromNode.y, toNode.x, toNode.y);
    const yaw = normalize180(brg - fromNode.headingDeg);

    return {
      type: "scene",
      text: toScene?.notes || `Go to ${toId}`,
      sceneId: toScene.sceneKey,
      pitch: -5,
      yaw
    };
  });

  scenesObj[s.sceneKey] = {
    title: s.notes,
    type: "multires",
    hfov: cfg.hfov ?? 100,
    yaw: startYaw,
    pitch: 0,
    multiRes: {
      basePath: `./scenes/${s.sceneKey}`,
      path: cfg.multiRes.path,
      fallbackPath: cfg.multiRes.fallbackPath,
      extension: cfg.multiRes.extension,
      tileResolution: cfg.multiRes.tileResolution,
      maxLevel: cfg.multiRes.maxLevel,
      cubeResolution: cfg.multiRes.cubeResolution
    },
    hotSpots
  };
}

const firstSceneKey = scenes[0].sceneKey;

const tour = {
  default: { firstScene: firstSceneKey, sceneFadeDuration: 200, autoLoad: true },
  scenes: scenesObj
};

fs.writeFileSync(OUT_TOUR, JSON.stringify(tour, null, 2), "utf8");
console.log(`Wrote ${OUT_TOUR}`);
