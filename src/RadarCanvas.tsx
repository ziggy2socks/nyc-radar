import { useEffect, useRef, useMemo } from 'react';
import type { Complaint } from './complaints';
import { getComplaintColor } from './complaints';
import { makeProjection } from './coordinates';

interface Props {
  complaints: Complaint[];
  activeTypes: Set<string>;
  onPing: (complaint: Complaint) => void;
}

const SIZE = 600;
const R = SIZE / 2 - 2;
const CX = SIZE / 2;
const CY = SIZE / 2;
const ROTATION_MS = 7000;
const SWEEP_SPEED = (2 * Math.PI) / ROTATION_MS;
const TRAIL_ARC = Math.PI / 2.2;
const PING_LIFE = 5000;
const DETECT_ARC = 0.12; // ~7 degrees

interface DotInfo {
  key: string;
  complaint: Complaint;
  x: number;
  y: number;
  angle: number;
  color: string;
}

interface Ping {
  x: number;
  y: number;
  color: string;
  born: number;
}

const project = makeProjection(SIZE);

// Borough paths — loaded once
let boroughPaths: Path2D[] = [];
fetch('/boroughs.geojson')
  .then(r => r.json())
  .then((geo: any) => {
    for (const f of geo.features) {
      const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
      for (const poly of polys) {
        const p = new Path2D();
        for (const ring of poly) {
          ring.forEach(([lon, lat]: number[], i: number) => {
            const { x, y } = project(lat, lon);
            i === 0 ? p.moveTo(x, y) : p.lineTo(x, y);
          });
          p.closePath();
        }
        boroughPaths.push(p);
      }
    }
  })
  .catch(console.error);

export function RadarCanvas({ complaints, activeTypes, onPing }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // All mutable state in refs — NO dependency on React state in the draw loop
  const dotsRef = useRef<DotInfo[]>([]);
  const pingsRef = useRef<Ping[]>([]);
  const sweptRef = useRef<Set<string>>(new Set());
  const angleRef = useRef(-Math.PI / 2);
  const lastTsRef = useRef(0);
  const onPingRef = useRef(onPing);

  // Keep onPing ref current
  onPingRef.current = onPing;

  // Pre-compute dots when data/filters change — write to ref, no RAF restart
  useMemo(() => {
    const result: DotInfo[] = [];
    for (const c of complaints) {
      if (!activeTypes.has(c.complaint_type)) continue;
      const lat = parseFloat(c.latitude ?? '');
      const lon = parseFloat(c.longitude ?? '');
      if (isNaN(lat) || isNaN(lon)) continue;
      const { x, y } = project(lat, lon);
      const dx = x - CX;
      const dy = y - CY;
      if (dx * dx + dy * dy > R * R) continue;
      const angle = (Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI);
      result.push({ key: c.unique_key, complaint: c, x, y, angle, color: getComplaintColor(c.complaint_type) });
    }
    dotsRef.current = result;
    sweptRef.current.clear();
  }, [complaints, activeTypes]);

  // Single RAF loop — started once, never restarted
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;

    function draw(ts: number) {
      const dt = lastTsRef.current ? Math.min(ts - lastTsRef.current, 50) : 16;
      lastTsRef.current = ts;

      const prev = angleRef.current;
      angleRef.current = (prev + SWEEP_SPEED * dt) % (2 * Math.PI);
      const sweep = angleRef.current;

      // Clear on wrap
      if (sweep < prev) sweptRef.current.clear();

      // ── Draw ─────────────────────────────────────────
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.save();
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, 2 * Math.PI);
      ctx.clip();

      // Background
      ctx.fillStyle = '#020810';
      ctx.fillRect(0, 0, SIZE, SIZE);

      // Grid rings
      ctx.strokeStyle = 'rgba(0,180,200,0.12)';
      ctx.lineWidth = 0.5;
      for (let r = R / 4; r <= R; r += R / 4) {
        ctx.beginPath();
        ctx.arc(CX, CY, r, 0, 2 * Math.PI);
        ctx.stroke();
      }

      // Crosshairs
      ctx.strokeStyle = 'rgba(0,180,200,0.07)';
      ctx.setLineDash([3, 8]);
      ctx.beginPath();
      ctx.moveTo(CX - R, CY); ctx.lineTo(CX + R, CY);
      ctx.moveTo(CX, CY - R); ctx.lineTo(CX, CY + R);
      ctx.stroke();
      ctx.setLineDash([]);

      // Borough fills + outlines
      ctx.fillStyle = 'rgba(0,160,190,0.05)';
      for (const p of boroughPaths) ctx.fill(p);
      ctx.strokeStyle = 'rgba(0,200,220,0.25)';
      ctx.lineWidth = 0.8;
      for (const p of boroughPaths) ctx.stroke(p);

      // Sweep trail
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.arc(CX, CY, R, sweep - TRAIL_ARC, sweep);
      ctx.closePath();
      const g = ctx.createRadialGradient(CX, CY, 0, CX, CY, R);
      g.addColorStop(0, 'rgba(0,220,255,0)');
      g.addColorStop(0.6, 'rgba(0,220,255,0.04)');
      g.addColorStop(1, 'rgba(0,220,255,0.13)');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();

      // Sweep leading edge
      ctx.save();
      ctx.strokeStyle = 'rgba(0,255,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.shadowColor = '#0ff';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.lineTo(CX + Math.cos(sweep) * R, CY + Math.sin(sweep) * R);
      ctx.stroke();
      ctx.restore();

      // Dim dots (always visible)
      const dots = dotsRef.current;
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        ctx.fillStyle = d.color;
        ctx.globalAlpha = 0.12;
        ctx.beginPath();
        ctx.arc(d.x, d.y, 1.5, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Sweep detection
      const now = ts;
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        if (sweptRef.current.has(d.key)) continue;
        const diff = (sweep - d.angle + 2 * Math.PI) % (2 * Math.PI);
        if (diff < DETECT_ARC) {
          sweptRef.current.add(d.key);
          pingsRef.current.push({ x: d.x, y: d.y, color: d.color, born: now });
          onPingRef.current(d.complaint);
        }
      }

      // Draw pings (bright, fading)
      const alive: Ping[] = [];
      for (let i = 0; i < pingsRef.current.length; i++) {
        const p = pingsRef.current[i];
        const age = now - p.born;
        if (age >= PING_LIFE) continue;
        alive.push(p);
        const alpha = 1 - age / PING_LIFE;
        const r = 1.5 + (age / PING_LIFE) * 3;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 10 * alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
      }
      pingsRef.current = alive;

      // Center dot
      ctx.save();
      ctx.fillStyle = '#00ccff';
      ctx.shadowColor = '#00ccff';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(CX, CY, 3, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();

      ctx.restore(); // end clip

      // Outer ring
      ctx.strokeStyle = 'rgba(0,200,220,0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, 2 * Math.PI);
      ctx.stroke();

      raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []); // ← EMPTY DEPS — never restarts

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      className="radar-canvas"
    />
  );
}
