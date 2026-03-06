import { useEffect, useRef, useMemo } from 'react';
import type { Complaint } from './complaints';
import { getComplaintColor } from './complaints';
import { makeProjection } from './coordinates';

interface Props {
  complaints: Complaint[];  // only currently-visible (filtered by App)
  activeTypes: Set<string>;
  replayTime: number;       // current replay timestamp
  dotLifetime: number;      // 10 min in ms
  newThreshold: number;     // complaints newer than this get ping effect
  onPing: (complaint: Complaint) => void;
}

const SIZE = 600;
const R = SIZE / 2 - 2;
const CX = SIZE / 2;
const CY = SIZE / 2;
const SWEEP_SPEED = (2 * Math.PI) / 7000; // visual sweep, 7s rotation

interface DotInfo {
  key: string;
  complaint: Complaint;
  x: number;
  y: number;
  color: string;
  createdMs: number;
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

export function RadarCanvas({ complaints, replayTime, dotLifetime, newThreshold, onPing }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const angleRef = useRef(-Math.PI / 2);
  const lastTsRef = useRef(0);
  const dotsRef = useRef<DotInfo[]>([]);
  const replayRef = useRef(replayTime);
  const dotLifeRef = useRef(dotLifetime);
  const newThreshRef = useRef(newThreshold);
  const onPingRef = useRef(onPing);
  const pingedRef = useRef<Set<string>>(new Set());

  // Keep refs current without restarting RAF
  replayRef.current = replayTime;
  dotLifeRef.current = dotLifetime;
  newThreshRef.current = newThreshold;
  onPingRef.current = onPing;

  // Pre-compute dot positions (no ping firing here — that happens in draw loop)
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
    dotsRef.current = result;
    pingedRef.current.clear();
  }, [complaints]);

  // Single RAF loop — never restarts
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;

    function draw(ts: number) {
      const dt = lastTsRef.current ? Math.min(ts - lastTsRef.current, 50) : 16;
      lastTsRef.current = ts;
      angleRef.current = (angleRef.current + SWEEP_SPEED * dt) % (2 * Math.PI);
      const sweep = angleRef.current;
      const now = replayRef.current;
      const lifetime = dotLifeRef.current;

      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.save();
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, 2 * Math.PI);
      ctx.clip();

      // Background
      ctx.fillStyle = '#020810';
      ctx.fillRect(0, 0, SIZE, SIZE);

      // Grid rings
      ctx.strokeStyle = 'rgba(0,180,200,0.10)';
      ctx.lineWidth = 0.5;
      for (let r = R / 4; r <= R; r += R / 4) {
        ctx.beginPath();
        ctx.arc(CX, CY, r, 0, 2 * Math.PI);
        ctx.stroke();
      }

      // Crosshairs
      ctx.strokeStyle = 'rgba(0,180,200,0.06)';
      ctx.setLineDash([3, 8]);
      ctx.beginPath();
      ctx.moveTo(CX - R, CY); ctx.lineTo(CX + R, CY);
      ctx.moveTo(CX, CY - R); ctx.lineTo(CX, CY + R);
      ctx.stroke();
      ctx.setLineDash([]);

      // Borough fills + outlines
      ctx.fillStyle = 'rgba(0,160,190,0.05)';
      for (const p of boroughPaths) ctx.fill(p);
      ctx.strokeStyle = 'rgba(0,200,220,0.22)';
      ctx.lineWidth = 0.8;
      for (const p of boroughPaths) ctx.stroke(p);

      // Sweep trail
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.arc(CX, CY, R, sweep - Math.PI / 2.2, sweep);
      ctx.closePath();
      const g = ctx.createRadialGradient(CX, CY, 0, CX, CY, R);
      g.addColorStop(0, 'rgba(0,220,255,0)');
      g.addColorStop(0.6, 'rgba(0,220,255,0.03)');
      g.addColorStop(1, 'rgba(0,220,255,0.10)');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();

      // Sweep line
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

      // Draw dots — brightness based on age + fire pings for newly visible
      const dots = dotsRef.current;
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        const age = now - d.createdMs; // ms since this complaint appeared
        if (age < 0 || age > lifetime) continue;

        // Fire ping when dot first becomes visible
        if (!pingedRef.current.has(d.key)) {
          pingedRef.current.add(d.key);
          onPingRef.current(d.complaint);
        }

        const freshness = 1 - age / lifetime; // 1 = brand new, 0 = about to expire
        const isNew = age < 60000; // appeared in last 1 min of replay time

        ctx.save();
        if (isNew) {
          // Bright ping effect for new complaints
          const pingPhase = age / 60000; // 0–1 over first minute
          const glow = 1 - pingPhase;
          ctx.globalAlpha = 0.6 + 0.4 * glow;
          ctx.fillStyle = d.color;
          ctx.shadowColor = d.color;
          ctx.shadowBlur = 15 * glow;
          ctx.beginPath();
          ctx.arc(d.x, d.y, 3 + 3 * glow, 0, 2 * Math.PI);
          ctx.fill();
        } else {
          // Fading dot
          ctx.globalAlpha = 0.15 + 0.5 * freshness;
          ctx.fillStyle = d.color;
          ctx.shadowColor = d.color;
          ctx.shadowBlur = 4 * freshness;
          ctx.beginPath();
          ctx.arc(d.x, d.y, 1.5 + freshness * 1.5, 0, 2 * Math.PI);
          ctx.fill();
        }
        ctx.restore();
      }

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
  }, []); // empty deps — never restarts

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      className="radar-canvas"
    />
  );
}
