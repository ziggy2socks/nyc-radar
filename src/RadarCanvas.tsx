import { useEffect, useRef, useMemo } from 'react';
import type { Complaint } from './complaints';
import { getComplaintColor } from './complaints';
import { makeProjection } from './coordinates';

interface Props {
  complaints: Complaint[];  // ALL complaints for the day (type-filtered)
  replayTime: number;       // current replay clock (ms timestamp)
  dotLifetime: number;      // 10 min in ms
  onPing: (complaint: Complaint) => void;
}

const SIZE = 600;
const R = SIZE / 2 - 2;
const CX = SIZE / 2;
const CY = SIZE / 2;

interface DotInfo {
  key: string;
  complaint: Complaint;
  x: number;
  y: number;
  color: string;
  createdMs: number;
}

const project = makeProjection(SIZE);

// Borough paths
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

export function RadarCanvas({ complaints, replayTime, dotLifetime, onPing }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  // Pre-compute dot positions — only changes when complaints array ref changes
  const dotsRef = useRef<DotInfo[]>([]);
  const pingedRef = useRef<Set<string>>(new Set());

  useMemo(() => {
    const result: DotInfo[] = [];
    for (const c of complaints) {
      const lat = parseFloat(c.latitude ?? '');
      const lon = parseFloat(c.longitude ?? '');
      if (isNaN(lat) || isNaN(lon)) continue;
      const { x, y } = project(lat, lon);
      const dx = x - CX;
      const dy = y - CY;
      if (dx * dx + dy * dy > R * R) continue;
      result.push({
        key: c.unique_key,
        complaint: c,
        x, y,
        color: getComplaintColor(c.complaint_type),
        createdMs: new Date(c.created_date).getTime(),
      });
    }
    // Sort by created time so binary search works
    result.sort((a, b) => a.createdMs - b.createdMs);
    dotsRef.current = result;
    pingedRef.current.clear();
  }, [complaints]);

  // Keep replayTime in a ref so the RAF loop can read it without restart
  const replayRef = useRef(replayTime);
  const lifetimeRef = useRef(dotLifetime);
  const onPingRef = useRef(onPing);
  replayRef.current = replayTime;
  lifetimeRef.current = dotLifetime;
  onPingRef.current = onPing;

  // Single RAF loop — reads refs, never restarts
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    function draw() {
      const now = replayRef.current;
      const lifetime = lifetimeRef.current;
      const dots = dotsRef.current;

      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.save();
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, 2 * Math.PI);
      ctx.clip();

      // Background
      ctx.fillStyle = '#010408';
      ctx.fillRect(0, 0, SIZE, SIZE);

      // Grid rings
      ctx.strokeStyle = 'rgba(0,180,200,0.08)';
      ctx.lineWidth = 0.5;
      for (let r = R / 4; r <= R; r += R / 4) {
        ctx.beginPath();
        ctx.arc(CX, CY, r, 0, 2 * Math.PI);
        ctx.stroke();
      }

      // Crosshairs
      ctx.strokeStyle = 'rgba(0,180,200,0.05)';
      ctx.setLineDash([3, 8]);
      ctx.beginPath();
      ctx.moveTo(CX - R, CY); ctx.lineTo(CX + R, CY);
      ctx.moveTo(CX, CY - R); ctx.lineTo(CX, CY + R);
      ctx.stroke();
      ctx.setLineDash([]);

      // Borough outlines
      ctx.strokeStyle = 'rgba(0,200,220,0.15)';
      ctx.lineWidth = 0.7;
      for (const p of boroughPaths) ctx.stroke(p);
      ctx.fillStyle = 'rgba(0,160,190,0.03)';
      for (const p of boroughPaths) ctx.fill(p);

      // ── Draw dots ─────────────────────────────────
      // Visible window: (now - lifetime) to now
      const windowStart = now - lifetime;

      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        // Skip if not in window
        if (d.createdMs > now) continue;        // future — not yet
        if (d.createdMs < windowStart) continue; // expired

        // Fire ping for newly visible dots (feed)
        if (!pingedRef.current.has(d.key)) {
          pingedRef.current.add(d.key);
          onPingRef.current(d.complaint);
        }

        // All visible dots: 50% brightness, 2px radius
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = d.color;
        ctx.beginPath();
        ctx.arc(d.x, d.y, 2, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
      }

      // Center dot
      ctx.save();
      ctx.fillStyle = '#00ccff';
      ctx.shadowColor = '#00ccff';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(CX, CY, 2, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();

      ctx.restore(); // end clip

      // Outer ring
      ctx.strokeStyle = 'rgba(0,200,220,0.3)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, 2 * Math.PI);
      ctx.stroke();

      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []); // never restarts

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      className="radar-canvas"
    />
  );
}
