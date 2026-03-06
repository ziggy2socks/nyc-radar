import { useEffect, useRef, useCallback } from 'react';
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
const SWEEP_SPEED = (2 * Math.PI) / 6000; // full rotation in 6 seconds
const TRAIL_ANGLE = Math.PI / 2.5;
const PING_FADE_MS = 5000;

interface PingState {
  complaint: Complaint;
  x: number;
  y: number;
  color: string;
  born: number;
}

// Pre-project all borough paths once (loaded async)
const project = makeProjection(CANVAS_SIZE);
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

  const cx = CANVAS_SIZE / 2;
  const cy = CANVAS_SIZE / 2;
  const R = CANVAS_SIZE / 2 - 2;

  const draw = useCallback((timestamp: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    const dt = lastTimeRef.current ? timestamp - lastTimeRef.current : 16;
    lastTimeRef.current = timestamp;

    sweepAngleRef.current = (sweepAngleRef.current + SWEEP_SPEED * dt) % (2 * Math.PI);
    const sweep = sweepAngleRef.current;

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
    ctx.lineWidth = 1;
    for (let r = R / 4; r <= R; r += R / 4) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.stroke();
    }

    // ── Crosshairs ─────────────────────────────────────────
    ctx.strokeStyle = 'rgba(0, 180, 200, 0.08)';
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Borough fills ──────────────────────────────────────
    ctx.fillStyle = 'rgba(0, 160, 190, 0.06)';
    for (const path of BOROUGH_PATHS) ctx.fill(path);

    // ── Borough outlines ───────────────────────────────────
    ctx.strokeStyle = 'rgba(0, 200, 220, 0.3)';
    ctx.lineWidth = 0.8;
    for (const path of BOROUGH_PATHS) ctx.stroke(path);

    // ── Sweep trail ────────────────────────────────────────
    const trailStart = sweep - TRAIL_ANGLE;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, trailStart, sweep);
    ctx.closePath();
    const sweepGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    sweepGrad.addColorStop(0, 'rgba(0, 220, 255, 0.0)');
    sweepGrad.addColorStop(0.5, 'rgba(0, 220, 255, 0.03)');
    sweepGrad.addColorStop(1, 'rgba(0, 220, 255, 0.10)');
    ctx.fillStyle = sweepGrad;
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

    // ── Detect newly swept complaints ──────────────────────
    const now = timestamp;
    for (const c of complaints) {
      if (!activeTypes.has(c.complaint_type)) continue;
      if (sweptRef.current.has(c.unique_key)) continue;
      const lat = parseFloat(c.latitude ?? '');
      const lon = parseFloat(c.longitude ?? '');
      if (isNaN(lat) || isNaN(lon)) continue;

      const { x, y } = project(lat, lon);
      const dx = x - cx;
      const dy = y - cy;
      if (Math.sqrt(dx * dx + dy * dy) > R) continue;

      const dotAngle = (Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI);
      const sweepNorm = (sweep + 2 * Math.PI) % (2 * Math.PI);
      const diff = (sweepNorm - dotAngle + 2 * Math.PI) % (2 * Math.PI);

      if (diff < 0.08) {
        sweptRef.current.add(c.unique_key);
        pingsRef.current.push({ complaint: c, x, y, color: getComplaintColor(c.complaint_type), born: now });
        onPing(c);
      }
    }

    // ── Draw pings ─────────────────────────────────────────
    pingsRef.current = pingsRef.current.filter(p => now - p.born < PING_FADE_MS);
    for (const ping of pingsRef.current) {
      const age = now - ping.born;
      const alpha = Math.max(0, 1 - age / PING_FADE_MS);
      const r = 1.5 + (age / PING_FADE_MS) * 2.5;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = ping.color;
      ctx.shadowColor = ping.color;
      ctx.shadowBlur = 8 * alpha;
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
  }, [complaints, activeTypes, onPing, sweepAngleRef, cx, cy, R]);

  useEffect(() => {
    sweepAngleRef.current = -Math.PI / 2;
    sweptRef.current.clear();
    pingsRef.current = [];
    rafRef.current = requestAnimationFrame(draw);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [draw, sweepAngleRef]);

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
