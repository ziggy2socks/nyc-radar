import { useEffect, useRef, useMemo } from 'react';
import type { Complaint } from './complaints';
import { getComplaintColor } from './complaints';
import { makeProjection } from './coordinates';

interface Props {
  complaints: Complaint[];
  activeTypes: Set<string>;
  replayTime: number;
  dotLifetime: number;
  newThreshold: number;
  onPing: (complaint: Complaint) => void;
}

const SIZE = 600;
const R = SIZE / 2 - 2;
const CX = SIZE / 2;
const CY = SIZE / 2;
const SWEEP_SPEED = (2 * Math.PI) / 7000; // 7s per rotation
const TRAIL_ARC = Math.PI * 1.2; // ~216° trailing visibility gradient

interface DotInfo {
  key: string;
  complaint: Complaint;
  x: number;
  y: number;
  angle: number; // from center
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
  const angleRef = useRef(-Math.PI / 2);
  const lastTsRef = useRef(0);
  const dotsRef = useRef<DotInfo[]>([]);
  const replayRef = useRef(replayTime);
  const dotLifeRef = useRef(dotLifetime);
  const onPingRef = useRef(onPing);
  const pingedRef = useRef<Set<string>>(new Set());

  replayRef.current = replayTime;
  dotLifeRef.current = dotLifetime;
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
    dotsRef.current = result;
    pingedRef.current.clear();
  }, [complaints]);

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

      // ── Deep dark background ─────────────────────────
      ctx.fillStyle = '#010509';
      ctx.fillRect(0, 0, SIZE, SIZE);

      // ── Borough outlines — very dim, just structure ──
      ctx.strokeStyle = 'rgba(0,200,220,0.08)';
      ctx.lineWidth = 0.6;
      for (const p of boroughPaths) ctx.stroke(p);

      // ── Grid rings — barely visible ──────────────────
      ctx.strokeStyle = 'rgba(0,180,200,0.05)';
      ctx.lineWidth = 0.5;
      for (let r = R / 4; r <= R; r += R / 4) {
        ctx.beginPath();
        ctx.arc(CX, CY, r, 0, 2 * Math.PI);
        ctx.stroke();
      }

      // ── Crosshairs ───────────────────────────────────
      ctx.strokeStyle = 'rgba(0,180,200,0.04)';
      ctx.setLineDash([3, 10]);
      ctx.beginPath();
      ctx.moveTo(CX - R, CY); ctx.lineTo(CX + R, CY);
      ctx.moveTo(CX, CY - R); ctx.lineTo(CX, CY + R);
      ctx.stroke();
      ctx.setLineDash([]);

      // ── Sweep beam — the "light source" ──────────────
      // Wide trailing glow that illuminates the area behind the beam
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.arc(CX, CY, R, sweep - TRAIL_ARC, sweep);
      ctx.closePath();

      // Conical gradient — brightest at leading edge, fades to black
      // We approximate with multiple arc fills at decreasing opacity
      const steps = 12;
      for (let s = 0; s < steps; s++) {
        const frac = s / steps; // 0 = leading edge, 1 = tail
        const a0 = sweep - TRAIL_ARC * frac - TRAIL_ARC / steps;
        const a1 = sweep - TRAIL_ARC * frac;
        const alpha = (1 - frac) * (1 - frac) * 0.12; // quadratic falloff

        ctx.beginPath();
        ctx.moveTo(CX, CY);
        ctx.arc(CX, CY, R, a0, a1);
        ctx.closePath();
        ctx.fillStyle = `rgba(0,220,255,${alpha})`;
        ctx.fill();
      }
      ctx.restore();

      // ── Sweep leading edge — bright line ─────────────
      ctx.save();
      ctx.strokeStyle = 'rgba(0,255,255,0.95)';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#0ff';
      ctx.shadowBlur = 15;
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.lineTo(CX + Math.cos(sweep) * R, CY + Math.sin(sweep) * R);
      ctx.stroke();
      ctx.restore();

      // ── Borough outlines — brighter in beam path ─────
      // Re-draw boroughs in the illuminated zone
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.arc(CX, CY, R, sweep - TRAIL_ARC * 0.3, sweep);
      ctx.closePath();
      ctx.clip();
      ctx.strokeStyle = 'rgba(0,200,220,0.25)';
      ctx.lineWidth = 0.8;
      for (const p of boroughPaths) ctx.stroke(p);
      ctx.fillStyle = 'rgba(0,160,190,0.03)';
      for (const p of boroughPaths) ctx.fill(p);
      ctx.restore();

      // ── Draw dots ────────────────────────────────────
      const dots = dotsRef.current;
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        const age = now - d.createdMs;
        if (age < 0 || age > lifetime) continue;

        // Fire ping when first visible
        if (!pingedRef.current.has(d.key)) {
          pingedRef.current.add(d.key);
          onPingRef.current(d.complaint);
        }

        const freshness = 1 - age / lifetime; // 1=new, 0=expiring
        const isNew = age < 90000; // first 1.5 min = "new"

        // How close is this dot to the beam? (angular distance behind sweep)
        const behindSweep = (sweep - d.angle + 2 * Math.PI) % (2 * Math.PI);
        const inBeam = behindSweep < TRAIL_ARC;
        const beamBrightness = inBeam ? Math.pow(1 - behindSweep / TRAIL_ARC, 2) : 0;

        // Base visibility: very dim in the dark, brighter near beam
        const baseAlpha = 0.04 + beamBrightness * 0.35;

        ctx.save();
        if (isNew) {
          // New dot: always bright, glowing
          const pingPhase = age / 90000;
          const glow = 1 - pingPhase;
          ctx.globalAlpha = Math.max(0.5 + 0.5 * glow, baseAlpha);
          ctx.fillStyle = d.color;
          ctx.shadowColor = d.color;
          ctx.shadowBlur = 18 * glow;
          ctx.beginPath();
          ctx.arc(d.x, d.y, 2.5 + 3.5 * glow, 0, 2 * Math.PI);
          ctx.fill();
        } else {
          // Existing dot: dim in dark, lights up when beam passes
          ctx.globalAlpha = baseAlpha + freshness * 0.15;
          ctx.fillStyle = d.color;
          if (beamBrightness > 0.3) {
            ctx.shadowColor = d.color;
            ctx.shadowBlur = 6 * beamBrightness;
          }
          ctx.beginPath();
          ctx.arc(d.x, d.y, 1.5 + freshness * 1 + beamBrightness * 1, 0, 2 * Math.PI);
          ctx.fill();
        }
        ctx.restore();
      }

      // ── Center dot ───────────────────────────────────
      ctx.save();
      ctx.fillStyle = '#00ccff';
      ctx.shadowColor = '#00ccff';
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(CX, CY, 2.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();

      ctx.restore(); // end clip

      // ── Outer ring ───────────────────────────────────
      ctx.strokeStyle = 'rgba(0,200,220,0.3)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, 2 * Math.PI);
      ctx.stroke();

      // ── Edge vignette — darken the outer 25% ────────
      ctx.save();
      const vignette = ctx.createRadialGradient(CX, CY, R * 0.6, CX, CY, R);
      vignette.addColorStop(0, 'rgba(1,5,9,0)');
      vignette.addColorStop(0.7, 'rgba(1,5,9,0)');
      vignette.addColorStop(1, 'rgba(1,5,9,0.7)');
      ctx.fillStyle = vignette;
      ctx.beginPath();
      ctx.arc(CX, CY, R + 1, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();

      raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
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
