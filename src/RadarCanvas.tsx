import { useEffect, useRef, useCallback, useMemo } from 'react';
import type { Complaint } from './complaints';
import { getComplaintColor } from './complaints';
import { makeProjection } from './coordinates';

interface Props {
  complaints: Complaint[];
  activeTypes: Set<string>;
  onPing: (complaint: Complaint) => void;
  sweepAngleRef: React.MutableRefObject<number>;
}

const CANVAS_SIZE = 600;
const SWEEP_SPEED = (2 * Math.PI) / 7000; // full rotation in 7s
const TRAIL_ANGLE = Math.PI / 2.2;
const PING_FADE_MS = 5000;

interface DotInfo {
  complaint: Complaint;
  x: number;
  y: number;
  angle: number; // pre-computed angle from center (0–2π)
  color: string;
}

interface PingState {
  x: number;
  y: number;
  color: string;
  born: number;
}

const cx = CANVAS_SIZE / 2;
const cy = CANVAS_SIZE / 2;
const R = CANVAS_SIZE / 2 - 2;
const project = makeProjection(CANVAS_SIZE);

// Borough paths — loaded once async
let BOROUGH_PATHS: Path2D[] = [];
fetch('/boroughs.geojson')
  .then(r => r.json())
  .then((geojson: any) => {
    BOROUGH_PATHS = [];
    for (const feature of geojson.features) {
      const geom = feature.geometry;
      const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
      for (const poly of polys) {
        const path = new Path2D();
        for (const ring of poly) {
          let first = true;
          for (const [lon, lat] of ring) {
            const { x, y } = project(lat, lon);
            if (first) { path.moveTo(x, y); first = false; }
            else path.lineTo(x, y);
          }
          path.closePath();
        }
        BOROUGH_PATHS.push(path);
      }
    }
  })
  .catch(console.error);

export function RadarCanvas({ complaints, activeTypes, onPing, sweepAngleRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pingsRef = useRef<PingState[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const sweptRef = useRef<Set<string>>(new Set());
  const prevSweepRef = useRef<number>(-Math.PI / 2);

  // Pre-compute dot positions + angles once per complaints change — O(n) not O(n×frame)
  const dots = useMemo<DotInfo[]>(() => {
    const result: DotInfo[] = [];
    for (const c of complaints) {
      if (!activeTypes.has(c.complaint_type)) continue;
      const lat = parseFloat(c.latitude ?? '');
      const lon = parseFloat(c.longitude ?? '');
      if (isNaN(lat) || isNaN(lon)) continue;
      const { x, y } = project(lat, lon);
      const dx = x - cx;
      const dy = y - cy;
      if (Math.sqrt(dx * dx + dy * dy) > R) continue;
      const angle = (Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI);
      result.push({ complaint: c, x, y, angle, color: getComplaintColor(c.complaint_type) });
    }
    return result;
  }, [complaints, activeTypes]);

  const draw = useCallback((timestamp: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    const dt = lastTimeRef.current ? Math.min(timestamp - lastTimeRef.current, 50) : 16;
    lastTimeRef.current = timestamp;

    const prevSweep = prevSweepRef.current;
    sweepAngleRef.current = (sweepAngleRef.current + SWEEP_SPEED * dt) % (2 * Math.PI);
    const sweep = sweepAngleRef.current;
    // Clear swept set on each full rotation so dots ping again
    if (sweep < prevSweep) sweptRef.current.clear();
    prevSweepRef.current = sweep;

    // ── Clear ──────────────────────────────────────────────
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // ── Circular clip ──────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.clip();

    // ── Background ─────────────────────────────────────────
    ctx.fillStyle = '#020810';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // ── Grid rings ─────────────────────────────────────────
    ctx.strokeStyle = 'rgba(0, 180, 200, 0.1)';
    ctx.lineWidth = 0.5;
    for (let r = R / 4; r <= R; r += R / 4) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.stroke();
    }

    // ── Crosshairs ─────────────────────────────────────────
    ctx.strokeStyle = 'rgba(0, 180, 200, 0.07)';
    ctx.setLineDash([3, 8]);
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Borough fills ──────────────────────────────────────
    ctx.fillStyle = 'rgba(0, 160, 190, 0.05)';
    for (const path of BOROUGH_PATHS) ctx.fill(path);

    // ── Borough outlines ───────────────────────────────────
    ctx.strokeStyle = 'rgba(0, 200, 220, 0.28)';
    ctx.lineWidth = 0.8;
    for (const path of BOROUGH_PATHS) ctx.stroke(path);

    // ── Sweep trail ────────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, sweep - TRAIL_ANGLE, sweep);
    ctx.closePath();
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0, 'rgba(0, 220, 255, 0.0)');
    grad.addColorStop(0.6, 'rgba(0, 220, 255, 0.04)');
    grad.addColorStop(1, 'rgba(0, 220, 255, 0.12)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // ── Sweep leading edge ─────────────────────────────────
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = '#00ffff';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sweep) * R, cy + Math.sin(sweep) * R);
    ctx.stroke();
    ctx.restore();

    // ── Draw dim background dots (always visible) ──────────
    for (const dot of dots) {
      ctx.save();
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = dot.color;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, 1.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();
    }

    // ── Sweep detection ────────────────────────────────────
    const now = timestamp;
    for (const dot of dots) {
      if (sweptRef.current.has(dot.complaint.unique_key)) continue;
      const diff = (sweep - dot.angle + 2 * Math.PI) % (2 * Math.PI);
      if (diff < 0.12) { // ~7° window
        sweptRef.current.add(dot.complaint.unique_key);
        pingsRef.current.push({ x: dot.x, y: dot.y, color: dot.color, born: now });
        onPing(dot.complaint);
      }
    }

    // ── Draw fading pings ──────────────────────────────────
    pingsRef.current = pingsRef.current.filter(p => now - p.born < PING_FADE_MS);
    for (const ping of pingsRef.current) {
      const age = now - ping.born;
      const alpha = Math.max(0, 1 - age / PING_FADE_MS);
      const r = 1.5 + (age / PING_FADE_MS) * 3;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = ping.color;
      ctx.shadowColor = ping.color;
      ctx.shadowBlur = 10 * alpha;
      ctx.beginPath();
      ctx.arc(ping.x, ping.y, r, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();
    }

    // ── Center dot ─────────────────────────────────────────
    ctx.save();
    ctx.fillStyle = '#00ccff';
    ctx.shadowColor = '#00ccff';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();

    ctx.restore(); // end clip

    // ── Outer ring ─────────────────────────────────────────
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 200, 220, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();

    rafRef.current = requestAnimationFrame(draw);
  }, [dots, onPing, sweepAngleRef]);

  useEffect(() => {
    sweepAngleRef.current = -Math.PI / 2;
    prevSweepRef.current = -Math.PI / 2;
    pingsRef.current = [];
    rafRef.current = requestAnimationFrame(draw);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [draw, sweepAngleRef]);

  // Reset swept dots when data refreshes
  useEffect(() => { sweptRef.current.clear(); }, [complaints]);

  return (
    <canvas
      ref={canvasRef}
      width={CANVAS_SIZE}
      height={CANVAS_SIZE}
      className="radar-canvas"
    />
  );
}
