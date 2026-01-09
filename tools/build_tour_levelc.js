// tools/build_tour_levelc.js
// Full script: reads scenedata/scenes.csv and generates
// - scenedata/edges.csv (sequential)
// - scenedata/nodes.csv (dead-reckoned x/y, then snapped to 5-grid at the end)
// - scenedata/tour.json (Pannellum multires tour)
//
// scenes.csv header must be EXACT:
// id,type,floor,section,notes,filename,heading,moveHeading,stepMeters
//
// Optional files:
// scenedata/manual_edges.csv  (from,to)
// scenedata/blocked_edges.csv (from,to)
//
// Requires:
// scenes/<sceneKey>/config.json  (sceneKey = filename without extension)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SCENES_DIR = path.join(ROOT, "scenes");
const DATA_DIR = path.join(ROOT, "scenedata");

const SCENES_CSV = path.join(DATA_DIR, "scenes.csv");
const MANUAL_EDGES_CSV = path.join(DATA_DIR, "manual_edges.csv");    // optional
const BLOCKED_EDGES_CSV = path.join(DATA_DIR, "blocked_edges.csv");  // optional

const OUT_EDGES = path.join(DATA_DIR, "edges.csv");
const OUT_NODES = path.join(DATA_DIR, "nodes.csv");
const OUT_TOUR  = path.join(DATA_DIR, "tour.json");

// --------- tuning ----------
const DEFAULT_STEP_METERS = 5;

// auto-discovery of extra links
const LINK_RADIUS = 7.0;             // for ~5m spacing, 6.6–7.5 typical
const TURN_TOL = 30;                 // yaw must be within this of 0/±90/180
const MAX_PROX_LINKS_PER_NODE = 4;   // forward/right/back/left max
const REQUIRE_RECIPROCAL = true;     // consistency check reduces bad links
const SNAP_HOTSPOT_YAW = true;

// snap nodes to grid (at the end)
const GRID_STEP = 5;

// --------------- utils ---------------
function ensureDir(p){ fs.mkdirSync(p,{recursive:true}); }
function readText(p){ return fs.readFileSync(p,"utf8"); }
function writeText(p,s){ fs.writeFileSync(p,s,"utf8"); }
function readJson(p){ return JSON.parse(fs.readFileSync(p,"utf8")); }

function parseCsv(text){
  const lines=text.split(/\r?\n/).filter(l=>l.trim().length);
  const header=parseLine(lines.shift()).map(h=>h.trim());
  return lines.map(line=>{
    const cols=parseLine(line);
    const row={};
    header.forEach((h,i)=>row[h]=(cols[i]??"").trim());
    return row;
  });
}
function parseLine(line){
  const out=[]; let cur=""; let inQ=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(inQ && line[i+1]==='"'){ cur+='"'; i++; }
      else inQ=!inQ;
    } else if(ch==="," && !inQ){
      out.push(cur); cur="";
    } else cur+=ch;
  }
  out.push(cur); return out;
}

function toNum(v,f){ const n=Number(v); return Number.isFinite(n)?n:f; }

function normalize180(deg){
  let d=((deg+180)%360+360)%360-180;
  if(d===-180) d=180;
  return d;
}

function headingToDeg(h){
  if(!h) return NaN;
  const s=h.trim().toUpperCase();
  if (/^-?\d+(\.\d+)?$/.test(s)) return ((Number(s)%360)+360)%360;
  const map={ N:0, NE:45, E:90, SE:135, S:180, SW:225, W:270, NW:315 };
  return map[s] ?? NaN;
}

// Bearing 0=N(up), 90=E(right); y decreases going North
function bearingDeg(ax,ay,bx,by){
  const dx=bx-ax, dy=by-ay;
  const rad=Math.atan2(dx,-dy);
  return ((rad*180/Math.PI)+360)%360;
}

function dist(a,b){
  const dx=a.x-b.x, dy=a.y-b.y;
  return Math.sqrt(dx*dx+dy*dy);
}

function nearestCardinalBucket(yaw){
  const cands=[0,90,-90,180,-180];
  let best=null, bestErr=Infinity;
  for(const c of cands){
    const err=Math.abs(normalize180(yaw-c));
    if(err<bestErr){ bestErr=err; best=c; }
  }
  if(bestErr<=TURN_TOL){
    if(best===-180) best=180;
    return best; // 0, 90, -90, 180
  }
  return null;
}
function reciprocalBucket(bucket){
  if(bucket===0) return 180;
  if(bucket===180) return 0;
  if(bucket===90) return -90;
  if(bucket===-90) return 90;
  return null;
}

function addNeighbor(neigh,a,b){
  if(!neigh.has(a)) neigh.set(a,new Set());
  neigh.get(a).add(b);
}
function removeNeighbor(neigh,a,b){
  if(!neigh.has(a)) return;
  neigh.get(a).delete(b);
}

function loadEdgesIfPresent(csvPath){
  if(!fs.existsSync(csvPath)) return [];
  const rows=parseCsv(readText(csvPath));
  return rows
    .map(r=>({from:(r.from??"").trim(),to:(r.to??"").trim()}))
    .filter(e=>e.from&&e.to);
}

function sceneKeyFromFilename(filename){
  return filename.replace(/\.[^.]+$/, "");
}

function verifyScene(sceneKey){
  const cfgPath=path.join(SCENES_DIR, sceneKey, "config.json");
  if(!fs.existsSync(cfgPath)){
    throw new Error(`Missing config.json for ${sceneKey} in ./scenes/${sceneKey}/`);
  }
  return cfgPath;
}

// ---- GRID SNAP (at end) ----
// You want: <2.5 -> down, >=2.5 -> up, works for negatives too.
function roundHalfAwayFromZero(x){
  return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
}
function snapToGrid(value, step = GRID_STEP){
  return roundHalfAwayFromZero(value / step) * step;
}

// ---------------- MAIN ----------------
ensureDir(DATA_DIR);

if(!fs.existsSync(SCENES_CSV)) {
  throw new Error(`Missing scenedata/scenes.csv at: ${SCENES_CSV}`);
}

const rows = parseCsv(readText(SCENES_CSV));

const scenes = rows.map(r=>{
  const id=(r.id??"").trim();
  const filename=(r.filename??"").trim();
  if(!id) throw new Error("scenes.csv: missing id");
  if(!filename) throw new Error(`scenes.csv: missing filename for id=${id}`);

  const headingRaw=(r.heading??"").trim();
  const headingDeg=headingToDeg(headingRaw);
  if(!Number.isFinite(headingDeg)) {
    throw new Error(`scenes.csv: invalid heading "${headingRaw}" for id=${id}`);
  }

  const moveHeadingRaw=(r.moveHeading??"").trim(); // may be blank
  const moveHeadingDeg = moveHeadingRaw ? headingToDeg(moveHeadingRaw) : NaN;

  return {
    id,
    type:(r.type??"gen").trim() || "gen",
    floor:(r.floor??"").trim(),
    section:(r.section??"").trim(),
    notes:(r.notes??"").trim() || sceneKeyFromFilename(filename),
    filename,
    sceneKey: sceneKeyFromFilename(filename),

    headingDeg,
    moveHeadingDeg: Number.isFinite(moveHeadingDeg) ? moveHeadingDeg : null,

    stepMeters: toNum(r.stepMeters, DEFAULT_STEP_METERS),
  };
});

// sort by numeric id
scenes.sort((a,b)=>Number(a.id)-Number(b.id));
const sceneById=new Map(scenes.map(s=>[s.id,s]));

// 1) sequential edges.csv
let edgesCsv="from,to\n";
for(let i=0;i<scenes.length-1;i++){
  edgesCsv += `${scenes[i].id},${scenes[i+1].id}\n`;
}
writeText(OUT_EDGES, edgesCsv);
console.log(`Wrote ${OUT_EDGES}`);

// 2) nodes via dead-reckoning (NO snapping per step)
// Movement for i -> i+1 uses row i's moveHeading (or falls back to heading)
let x=0, y=0;
const nodes=[];
nodes.push({ id: scenes[0].id, x, y, headingDeg: scenes[0].headingDeg });

for(let i=1;i<scenes.length;i++){
  const prev = scenes[i-1];

  const moveDeg = (prev.moveHeadingDeg ?? prev.headingDeg);
  const theta = (moveDeg * Math.PI) / 180;
  const d = prev.stepMeters;

  x += d * Math.sin(theta);
  y -= d * Math.cos(theta);

  nodes.push({ id: scenes[i].id, x, y, headingDeg: scenes[i].headingDeg });
}

// 2b) SNAP AT END (your request)
for (const n of nodes) {
  n.x = snapToGrid(n.x, GRID_STEP);
  n.y = snapToGrid(n.y, GRID_STEP);
}

// write nodes.csv
let nodesCsv="id,x,y,headingDeg\n";
for(const n of nodes){
  nodesCsv += `${n.id},${n.x.toFixed(3)},${n.y.toFixed(3)},${n.headingDeg}\n`;
}
writeText(OUT_NODES, nodesCsv);
console.log(`Wrote ${OUT_NODES}`);

const nodeById=new Map(nodes.map(n=>[n.id,n]));

// 3) neighbors: sequential + manual + proximity(90° bucket) - blocked
const neigh=new Map();

// sequential
for(let i=0;i<scenes.length-1;i++){
  const a=scenes[i].id, b=scenes[i+1].id;
  addNeighbor(neigh,a,b);
  addNeighbor(neigh,b,a);
}

// manual (optional)
const manualEdges = loadEdgesIfPresent(MANUAL_EDGES_CSV);
for(const e of manualEdges){
  if(!sceneById.has(e.from) || !sceneById.has(e.to)) continue;
  addNeighbor(neigh,e.from,e.to);
  addNeighbor(neigh,e.to,e.from);
}

// proximity (auto extra exits)
for(const s of scenes){
  const aId=s.id;
  const aNode=nodeById.get(aId);

  const bestByBucket=new Map(); // bucket -> {bId,d,bucket}
  for(const t of scenes){
    const bId=t.id;
    if(aId===bId) continue;

    const bNode=nodeById.get(bId);
    const d=dist(aNode,bNode);
    if(d>LINK_RADIUS) continue;

    const brg=bearingDeg(aNode.x,aNode.y,bNode.x,bNode.y);
    const yaw=normalize180(brg - aNode.headingDeg);
    const bucket=nearestCardinalBucket(yaw);
    if(bucket===null) continue;

    const prev=bestByBucket.get(bucket);
    if(!prev || d<prev.d){
      bestByBucket.set(bucket,{bId,d,bucket});
    }
  }

  const winners=[...bestByBucket.values()]
    .sort((p,q)=>p.d-q.d)
    .slice(0,MAX_PROX_LINKS_PER_NODE);

  for(const w of winners){
    const bId=w.bId;

    if(REQUIRE_RECIPROCAL){
      const bNode=nodeById.get(bId);
      const brgBA=bearingDeg(bNode.x,bNode.y,aNode.x,aNode.y);
      const yawBA=normalize180(brgBA - bNode.headingDeg);
      const bucketBA=nearestCardinalBucket(yawBA);
      const expected=reciprocalBucket(w.bucket);
      if(bucketBA===null || expected===null || bucketBA!==expected) continue;
    }

    addNeighbor(neigh,aId,bId);
    addNeighbor(neigh,bId,aId);
  }
}

// blocked (optional)
const blockedEdges = loadEdgesIfPresent(BLOCKED_EDGES_CSV);
for(const e of blockedEdges){
  removeNeighbor(neigh,e.from,e.to);
  removeNeighbor(neigh,e.to,e.from);
}

// 4) tour.json
const scenesObj={};

for(const s of scenes){
  const cfgPath=verifyScene(s.sceneKey);
  const cfg=readJson(cfgPath);

  const fromNode=nodeById.get(s.id);
  const startYaw=normalize180(-fromNode.headingDeg); // always load facing North

  const neighbors=[...(neigh.get(s.id)||[])];

  const hotSpots = neighbors.map(toId=>{
    const toScene=sceneById.get(toId);
    const toNode=nodeById.get(toId);

    const brg=bearingDeg(fromNode.x,fromNode.y,toNode.x,toNode.y);
    let yaw=normalize180(brg - fromNode.headingDeg);

    if(SNAP_HOTSPOT_YAW){
      const b=nearestCardinalBucket(yaw);
      if(b!==null) yaw=b;
    }
    const travelBrg = bearingDeg(fromNode.x, fromNode.y, toNode.x, toNode.y);
    const targetYaw = normalize180(travelBrg - toScene.headingDeg);

    return {
      type:"scene",
      text: toScene?.notes || `Go to ${toId}`,
      sceneId: toScene.sceneKey,
      pitch: -5,
      yaw,
      targetYaw
    };
  });

  scenesObj[s.sceneKey]={
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

const tour={
  default:{ firstScene: scenes[0].sceneKey, sceneFadeDuration: 200, autoLoad: true },
  scenes: scenesObj
};

writeText(OUT_TOUR, JSON.stringify(tour,null,2));
console.log(`Wrote ${OUT_TOUR}`);
