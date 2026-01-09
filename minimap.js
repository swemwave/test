import { parseCSV } from "./csv.js";

async function tryFetchText(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return "";
    return await r.text();
  } catch {
    return "";
  }
}

function getBounds(nodes) {
  const xs = nodes.map(n => n.x);
  const ys = nodes.map(n => n.y);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

function worldToScreen(n, bounds, scale, pad, w, h) {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return {
    sx: (n.x - cx) * scale + w / 2,
    sy: (n.y - cy) * scale + h / 2,
  };
}

export async function createMinimap(opts) {
  const {
    canvas,
    nodesUrl,
    edgesUrl,
    manualEdgesUrl,
    scenesUrl,
    onNodeClick,
  } = opts;

  const ctx = canvas.getContext("2d");
  let nodes = [];
  let edges = [];
  let selectedId = null;
  let idBySceneKey = new Map();
  let sceneKeyById = new Map();

  const [nodesTxt, edgesTxt, manualTxt, scenesTxt] = await Promise.all([
    tryFetchText(nodesUrl),
    tryFetchText(edgesUrl),
    tryFetchText(manualEdgesUrl),
    tryFetchText(scenesUrl),
  ]);

  nodes = parseCSV(nodesTxt).map(r => ({
    id: r.id,
    x: Number(r.x),
    y: Number(r.y),
    headingDeg: Number(r.headingDeg),
  })).filter(n => n.id && Number.isFinite(n.x) && Number.isFinite(n.y));

  const scenesRows = parseCSV(scenesTxt);
  idBySceneKey = new Map(scenesRows.map(r => [
    r.filename.replace(/\.[^.]+$/, ""), r.id
  ]));
  sceneKeyById = new Map(scenesRows.map(r => [
    r.id, r.filename.replace(/\.[^.]+$/, "")
  ]));

  const edgeRows = [
    ...parseCSV(edgesTxt),
    ...parseCSV(manualTxt),
  ];
  if (edgeRows.length) {
    edges = edgeRows
      .map(e => ({ from: (e.from ?? "").trim(), to: (e.to ?? "").trim() }))
      .filter(e => e.from && e.to);
  } else {
    const sorted = [...nodes].sort((a,b) => Number(a.id) - Number(b.id));
    edges = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      edges.push({ from: sorted[i].id, to: sorted[i + 1].id });
    }
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function draw() {
    if (!nodes.length) return;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const pad = 10;
    const bounds = getBounds(nodes);

    const spanX = Math.max(1, bounds.maxX - bounds.minX);
    const spanY = Math.max(1, bounds.maxY - bounds.minY);
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);

    ctx.clearRect(0, 0, w, h);

    const pos = new Map();
    for (const n of nodes) {
      pos.set(n.id, worldToScreen(n, bounds, scale, pad, w, h));
    }

    ctx.strokeStyle = "#bbb";
    ctx.lineWidth = 2;
    for (const e of edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }

    for (const n of nodes) {
      const p = pos.get(n.id);
      const isSel = n.id === selectedId;
      ctx.fillStyle = isSel ? "#111" : "#666";
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, isSel ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function nearestNode(mx, my) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const pad = 10;
    const bounds = getBounds(nodes);

    const spanX = Math.max(1, bounds.maxX - bounds.minX);
    const spanY = Math.max(1, bounds.maxY - bounds.minY);
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);

    let best = null, bestD = Infinity;
    for (const n of nodes) {
      const p = worldToScreen(n, bounds, scale, pad, w, h);
      const dx = p.sx - mx;
      const dy = p.sy - my;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) { bestD = d; best = n; }
    }
    return bestD <= 12 ? best : null;
  }

  canvas.addEventListener("click", (ev) => {
    if (!onNodeClick) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const n = nearestNode(mx, my);
    if (!n) return;
    const sceneKey = sceneKeyById.get(n.id);
    if (sceneKey) onNodeClick(sceneKey);
  });

  function setSelectedByScene(sceneKey) {
    selectedId = idBySceneKey.get(sceneKey) || null;
    draw();
  }

  window.addEventListener("resize", resize);
  resize();

  return { setSelectedByScene };
}
