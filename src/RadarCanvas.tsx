import { useEffect, useRef, useCallback } from 'react';
import type { Complaint } from './complaints';
import { getComplaintColor } from './complaints';
import { latLonToXY } from './coordinates';

interface Props {
  complaints: Complaint[];
  activeTypes: Set<string>;
  onPing: (complaint: Complaint) => void;
  sweepAngleRef: React.MutableRefObject<number>;
}

const SWEEP_SPEED = (2 * Math.PI) / 6000; // full rotation in 6 seconds (rad/ms)
const TRAIL_ANGLE = Math.PI / 2.5;          // ~72° trailing glow
const PING_FADE_MS = 4000;                  // how long a ping stays visible

interface PingState {
  complaint: Complaint;
  x: number;
  y: number;
  color: string;
  born: number;  // timestamp when sweep hit it
}

export function RadarCanvas({ complaints, activeTypes, onPing, sweepAngleRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pingsRef = useRef<PingState[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const sweptRef = useRef<Set<string>>(new Set());

  const draw = useCallback((timestamp: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) / 2 - 2;

    // Delta time
    const dt = lastTimeRef.current ? timestamp - lastTimeRef.current : 16;
    lastTimeRef.current = timestamp;

    // Advance sweep angle
    sweepAngleRef.current = (sweepAngleRef.current + SWEEP_SPEED * dt) % (2 * Math.PI);
    const sweep = sweepAngleRef.current;

    // ── Clear ──────────────────────────────────────────────
    ctx.clearRect(0, 0, W, H);

    // ── Circular clip ──────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.clip();

    // ── Background ─────────────────────────────────────────
    ctx.fillStyle = '#020810';
    ctx.fillRect(0, 0, W, H);

    // ── Grid rings ─────────────────────────────────────────
    ctx.strokeStyle = 'rgba(0, 180, 200, 0.12)';
    ctx.lineWidth = 1;
    for (let r = R / 4; r <= R; r += R / 4) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.stroke();
    }

    // ── Grid crosshairs ────────────────────────────────────
    ctx.strokeStyle = 'rgba(0, 180, 200, 0.1)';
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();

    // ── NYC borough outlines ───────────────────────────────
    drawBoroughOutlines(ctx, cx, cy);

    // ── Sweep trail ────────────────────────────────────────
    // Draw sweep as filled arc wedge
    ctx.save();
    const trailStart = sweep - TRAIL_ANGLE;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, trailStart, sweep);
    ctx.closePath();
    // Radial gradient for fade
    const sweepGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    sweepGrad.addColorStop(0, 'rgba(0, 220, 255, 0.0)');
    sweepGrad.addColorStop(0.4, 'rgba(0, 220, 255, 0.04)');
    sweepGrad.addColorStop(1, 'rgba(0, 220, 255, 0.12)');
    ctx.fillStyle = sweepGrad;
    ctx.fill();
    ctx.restore();

    // ── Sweep leading edge line ────────────────────────────
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = '#00ffff';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sweep) * R, cy + Math.sin(sweep) * R);
    ctx.stroke();
    ctx.restore();

    // ── Check for newly swept complaints ──────────────────
    const now = timestamp;
    for (const c of complaints) {
      if (!activeTypes.has(c.complaint_type)) continue;
      const lat = parseFloat(c.latitude ?? '');
      const lon = parseFloat(c.longitude ?? '');
      if (isNaN(lat) || isNaN(lon)) continue;
      if (sweptRef.current.has(c.unique_key)) continue;

      const { x, y } = latLonToXY(lat, lon, cx, cy);
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > R) continue; // outside radar circle

      // Angle of this dot
      const dotAngle = (Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI);
      const sweepNorm = (sweep + 2 * Math.PI) % (2 * Math.PI);

      // Is dot within the last ~2° behind the sweep line?
      const diff = (sweepNorm - dotAngle + 2 * Math.PI) % (2 * Math.PI);
      if (diff < 0.06) {
        sweptRef.current.add(c.unique_key);
        const color = getComplaintColor(c.complaint_type);
        pingsRef.current.push({ complaint: c, x, y, color, born: now });
        onPing(c);
      }
    }

    // ── Draw pings ─────────────────────────────────────────
    pingsRef.current = pingsRef.current.filter(p => now - p.born < PING_FADE_MS);
    for (const ping of pingsRef.current) {
      const age = now - ping.born;
      const alpha = Math.max(0, 1 - age / PING_FADE_MS);
      const pulseR = 2 + (age / PING_FADE_MS) * 3; // grows slightly as it fades

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = ping.color;
      ctx.shadowColor = ping.color;
      ctx.shadowBlur = 6 * alpha;
      ctx.beginPath();
      ctx.arc(ping.x, ping.y, pulseR, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();
    }

    // ── Center dot ─────────────────────────────────────────
    ctx.save();
    ctx.fillStyle = '#00ccff';
    ctx.shadowColor = '#00ccff';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();

    ctx.restore(); // end clip

    // ── Outer ring ─────────────────────────────────────────
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 200, 220, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();

    rafRef.current = requestAnimationFrame(draw);
  }, [complaints, activeTypes, onPing, sweepAngleRef]);

  useEffect(() => {
    sweepAngleRef.current = -Math.PI / 2; // start pointing up
    sweptRef.current.clear();
    pingsRef.current = [];
    rafRef.current = requestAnimationFrame(draw);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [draw, sweepAngleRef]);

  // Reset swept set when complaints refresh so dots can ping again
  useEffect(() => {
    sweptRef.current.clear();
  }, [complaints]);

  return (
    <canvas
      ref={canvasRef}
      width={600}
      height={600}
      className="radar-canvas"
    />
  );
}

// ── Borough outline paths (simplified polygons) ──────────────────────────────
function drawBoroughOutlines(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 180, 200, 0.25)';
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(0, 180, 200, 0.04)';

  // Each borough as an array of [lat, lon] points
  const boroughs = [MANHATTAN, BROOKLYN, QUEENS, BRONX, STATEN_ISLAND];
  for (const poly of boroughs) {
    ctx.beginPath();
    for (let i = 0; i < poly.length; i++) {
      const { x, y } = latLonToXY(poly[i][0], poly[i][1], cx, cy);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// Simplified borough polygons (lat, lon)
const MANHATTAN: [number, number][] = [
  [40.8789, -73.9330], [40.8737, -73.9104], [40.8480, -73.9295],
  [40.8200, -73.9503], [40.7966, -73.9717], [40.7794, -73.9795],
  [40.7685, -73.9797], [40.7550, -73.9707], [40.7479, -74.0082],
  [40.7016, -74.0183], [40.7002, -74.0198], [40.7128, -74.0207],
  [40.7308, -74.0078], [40.7529, -74.0020], [40.7694, -73.9958],
  [40.7960, -73.9720], [40.8243, -73.9484], [40.8506, -73.9284],
];

const BROOKLYN: [number, number][] = [
  [40.7394, -74.0052], [40.7200, -74.0135], [40.6501, -74.0341],
  [40.5724, -74.0168], [40.5765, -73.9450], [40.5929, -73.9199],
  [40.6283, -73.8952], [40.6625, -73.8804], [40.7005, -73.9037],
  [40.7191, -73.9303], [40.7351, -73.9526],
];

const QUEENS: [number, number][] = [
  [40.7351, -73.9526], [40.7191, -73.9303], [40.7005, -73.9037],
  [40.6625, -73.8804], [40.6283, -73.8952], [40.5929, -73.9199],
  [40.5765, -73.9450], [40.5724, -74.0168], [40.5569, -73.7680],
  [40.5766, -73.7121], [40.6028, -73.7108], [40.7328, -73.7004],
  [40.7597, -73.7010], [40.7958, -73.7122], [40.7887, -73.8000],
  [40.7880, -73.8310], [40.7700, -73.8650], [40.7513, -73.9096],
];

const BRONX: [number, number][] = [
  [40.8789, -73.9330], [40.8506, -73.9284], [40.8243, -73.9484],
  [40.8097, -73.9277], [40.8049, -73.9171], [40.8080, -73.9019],
  [40.8155, -73.8875], [40.8302, -73.8683], [40.8431, -73.8513],
  [40.8556, -73.8355], [40.8687, -73.8107], [40.8946, -73.8219],
  [40.9156, -73.8451], [40.9152, -73.8993], [40.8981, -73.9128],
  [40.8917, -73.9226],
];

const STATEN_ISLAND: [number, number][] = [
  [40.7002, -74.0198], [40.6501, -74.0341], [40.6000, -74.0750],
  [40.5777, -74.1445], [40.4961, -74.2551], [40.4774, -74.2578],
  [40.4783, -74.1856], [40.5088, -74.1325], [40.5490, -74.0879],
  [40.5916, -74.0563], [40.6287, -74.0396],
];
