export function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];
  const header = splitCSVLine(lines.shift()).map(s => s.trim());
  return lines.map(line => {
    const cols = splitCSVLine(line);
    const row = {};
    header.forEach((h, i) => row[h] = (cols[i] ?? "").trim());
    return row;
  });
}

function splitCSVLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
