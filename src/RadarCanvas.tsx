import { useEffect, useRef, useMemo } from 'react';
import type { Complaint } from './complaints';
import { getComplaintColor } from './complaints';
import { makeProjection } from './coordinates';

interface Props {
  complaints: Complaint[];
  replayTime: number;
  dotLifetime: number;
  onPing: (complaint: Complaint) => void;
}

const SIZE = 600;
const R = SIZE / 2 - 2;
const CX = SIZE / 2;
const CY = SIZE / 2;
const SWEEP_SPEED = (2 * Math.PI) / 7000; // 7s per rotation
const TRAIL_ARC = Math.PI * 1.2; // ~216° trailing glow

interface DotInfo {
  key: string;
  complaint: Complaint;
  x: number;
  y: number;
  angle: number;
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

// Offscreen canvas for smooth sweep trail
const trailCanvas = document.createElement('canvas');
trailCanvas.width = SIZE;
trailCanvas.height = SIZE;

function renderTrail(sweep: number) {
  const tctx = trailCanvas.getContext('2d')!;
  tctx.clearRect(0, 0, SIZE, SIZE);
  const slices = 60;
  const sliceArc = TRAIL_ARC / slices;
  for (let s = 0; s < slices; s++) {
    const frac = s / slices;
    const alpha = Math.pow(1 - frac, 3) * 0.12;
    if (alpha < 0.002) continue;
    tctx.beginPath();
    tctx.moveTo(CX, CY);
    tctx.arc(CX, CY, R, sweep - sliceArc * (s + 1), sweep - sliceArc * s);
    tctx.closePath();
    tctx.fillStyle = `rgba(0,220,255,${alpha})`;
    tctx.fill();
  }
}

export function RadarCanvas({ complaints, replayTime, dotLifetime, onPing }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const angleRef = useRef(-Math.PI / 2);
  const lastTsRef = useRef(0);
  const dotsRef = useRef<DotInfo[]>([]);
  const pingedRef = useRef<Set<string>>(new Set());
  const replayRef = useRef(replayTime);
  const lifetimeRef = useRef(dotLifetime);
  const onPingRef = useRef(onPing);

  replayRef.current = replayTime;
  lifetimeRef.current = dotLifetime;
  onPingRef.current = onPing;

  // Pre-compute dot positions + angles
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
      const angle = (Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI);
      result.push({
        key: c.unique_key, complaint: c,
        x, y, angle,
        color: getComplaintColor(c.complaint_type),
        createdMs: new Date(c.created_date).getTime(),
      });
    }
    result.sort((a, b) => a.createdMs - b.createdMs);
    dotsRef.current = result;
    pingedRef.current.clear();
  }, [complaints]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    function draw(ts: number) {
      const dt = lastTsRef.current ? Math.min(ts - lastTsRef.current, 50) : 16;
      lastTsRef.current = ts;
      angleRef.current = (angleRef.current + SWEEP_SPEED * dt) % (2 * Math.PI);
      const sweep = angleRef.current;
      const now = replayRef.current;
      const lifetime = lifetimeRef.current;
      const dots = dotsRef.current;
      const windowStart = now - lifetime;

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

      // Sweep trail (smooth gradient)
      renderTrail(sweep);
      ctx.drawImage(trailCanvas, 0, 0);

      // Sweep leading edge
      ctx.save();
      ctx.strokeStyle = 'rgba(0,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#0ff';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.lineTo(CX + Math.cos(sweep) * R, CY + Math.sin(sweep) * R);
      ctx.stroke();
      ctx.restore();

      // ── Dots ────────────────────────────────────
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        if (d.createdMs > now) continue;
        if (d.createdMs < windowStart) continue;

        // Fire ping for feed
        if (!pingedRef.current.has(d.key)) {
          pingedRef.current.add(d.key);
          onPingRef.current(d.complaint);
        }

        // Beam flicker: how close is the sweep line to this dot right now?
        const behind = (sweep - d.angle + 2 * Math.PI) % (2 * Math.PI);
        const flicker = behind < 0.12 ? (1 - behind / 0.12) * 0.4 : 0; // +40% max when beam is right on it

        // Base: 50% brightness, 2px
        const alpha = 0.5 + flicker;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = d.color;
        if (flicker > 0.1) {
          ctx.shadowColor = d.color;
          ctx.shadowBlur = 6 * flicker;
        }
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

      // Edge vignette
      ctx.save();
      const vig = ctx.createRadialGradient(CX, CY, R * 0.55, CX, CY, R);
      vig.addColorStop(0, 'rgba(1,4,8,0)');
      vig.addColorStop(0.65, 'rgba(1,4,8,0)');
      vig.addColorStop(1, 'rgba(1,4,8,0.7)');
      ctx.fillStyle = vig;
      ctx.beginPath();
      ctx.arc(CX, CY, R + 1, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();

      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      className="radar-canvas"
    />
  );
}
