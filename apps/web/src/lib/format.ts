/** Display conversions (UI only; the core stays in SI). */
export const P_ATM = 101325;
export const barA = (pa: number): string => (pa / 1e5).toFixed(2);
export const barG = (pa: number): string => ((pa - P_ATM) / 1e5).toFixed(2);
export const degC = (k: number): string => (k - 273.15).toFixed(1);
export const m3h = (m3s: number): string => (m3s * 3600).toFixed(1);
export const kgs = (v: number): string => v.toFixed(2);
export const pct = (v: number): string => (100 * v).toFixed(1);
export const fmtTime = (s: number): string => {
  const tenths = Math.max(0, Math.round(s * 10));
  const m = Math.floor(tenths / 600);
  const r = (tenths - 600 * m) / 10;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
};

export function sensorValueText(kind: string, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'нет данных';
  switch (kind) {
    case 'pressure':
      return `${barA(v)} бар а`;
    case 'temperature':
      return `${degC(v)} °C`;
    case 'massFlow':
      return `${kgs(v)} кг/с`;
    case 'volumeFlow':
      return `${m3h(v)} м³/ч`;
    case 'waterFraction':
      return `${pct(v)} % (об.)`;
    default:
      return String(v);
  }
}

export const STATUS_RU: Record<string, string> = {
  normal: 'норма',
  suspected: 'подозрение',
  confirmed: 'подтверждено',
  ambiguous: 'неоднозначно',
  recovering: 'восстановление',
  unavailable: 'недоступно'
};

export const CAUSE_RU: Record<string, string> = {
  leak: 'утечка',
  operating_change: 'штатное изменение режима',
  sensor_fault: 'неисправность датчика',
  composition_change: 'изменение свойств среды',
  unknown: 'не определена',
  normal: 'норма'
};

/** perceptually ordered sequential palette (viridis-like stops) */
const SEQ = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'];
/** diverging palette (blue - light - red) */
const DIV = ['#2166ac', '#67a9cf', '#f7f7f7', '#ef8a62', '#b2182b'];

function lerpHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i]! - v) * t)).join(',')})`;
}

export function seqColor(t: number): string {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (SEQ.length - 1);
  const i = Math.min(SEQ.length - 2, Math.floor(x));
  return lerpHex(SEQ[i]!, SEQ[i + 1]!, x - i);
}

export function divColor(t: number): string {
  const x = (Math.min(1, Math.max(-1, Number.isFinite(t) ? t : 0)) + 1) / 2 * (DIV.length - 1);
  const i = Math.min(DIV.length - 2, Math.floor(x));
  return lerpHex(DIV[i]!, DIV[i + 1]!, x - i);
}

export const SEQ_GRADIENT = `linear-gradient(90deg, ${SEQ.join(',')})`;
export const DIV_GRADIENT = `linear-gradient(90deg, ${DIV.join(',')})`;

/** point along a display polyline at fraction f of its drawn length */
export function pointAlong(poly: Array<{ x: number; y: number }>, f: number): { x: number; y: number; angle: number } {
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < poly.length; i++) {
    const d = Math.hypot(poly[i]!.x - poly[i - 1]!.x, poly[i]!.y - poly[i - 1]!.y);
    seg.push(d);
    total += d;
  }
  let target = Math.min(1, Math.max(0, f)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i]! || i === seg.length - 1) {
      const a = poly[i]!;
      const b = poly[i + 1]!;
      const t = seg[i]! > 0 ? Math.min(1, target / seg[i]!) : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    target -= seg[i]!;
  }
  const l = poly[poly.length - 1]!;
  return { x: l.x, y: l.y, angle: 0 };
}

/** fraction along a polyline of the closest point to (x,y) */
export function closestFraction(poly: Array<{ x: number; y: number }>, x: number, y: number): { f: number; dist: number } {
  let total = 0;
  const seg: number[] = [];
  for (let i = 1; i < poly.length; i++) {
    const d = Math.hypot(poly[i]!.x - poly[i - 1]!.x, poly[i]!.y - poly[i - 1]!.y);
    seg.push(d);
    total += d;
  }
  let best = { f: 0, dist: Number.POSITIVE_INFINITY };
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / L2));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (d < best.dist) best = { f: (acc + t * seg[i]!) / total, dist: d };
    acc += seg[i]!;
  }
  return best;
}
