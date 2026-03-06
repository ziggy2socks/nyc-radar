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
const SWEEP_SPEED = (2 * Math.PI) / 7000;
const TRAIL_ARC = Math.PI * 1.4; // ~252° trailing glow

interface DotInfo {
  key: string;
  complaint: Complaint;
  x: number;
  y: number;
  angle: number;
  dist: number; // distance from center (for range readout)
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

// Pre-render the sweep trail as an offscreen canvas (smooth gradient, no stepping)
const trailCanvas = document.createElement('canvas');
trailCanvas.width = SIZE;
trailCanvas.height = SIZE;

function renderTrail(sweep: number) {
  const tctx = trailCanvas.getContext('2d')!;
  tctx.clearRect(0, 0, SIZE, SIZE);

  // Draw 60 thin slices for smooth conical gradient
  const slices = 60;
  const sliceArc = TRAIL_ARC / slices;
  for (let s = 0; s < slices; s++) {
    const frac = s / slices; // 0=leading, 1=tail
    const alpha = Math.pow(1 - frac, 3) * 0.14; // cubic falloff
    if (alpha < 0.002) continue;

    const a0 = sweep - sliceArc * (s + 1);
    const a1 = sweep - sliceArc * s;

    tctx.beginPath();
    tctx.moveTo(CX, CY);
    tctx.arc(CX, CY, R, a0, a1);
    tctx.closePath();
    tctx.fillStyle = `rgba(0,220,255,${alpha})`;
    tctx.fill();
  }
}

export function RadarCanvas({ complaints, replayTime, dotLifetime, onPing }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const angleRef = useRef(-Math.PI / 2);
  const lastTsRef = useRef(0);
  const dotsRef = useRef<DotInfo[]>([]);
  const replayRef = useRef(replayTime);
  const dotLifeRef = useRef(dotLifetime);
  const onPingRef = useRef(onPing);
  const pingedRef = useRef<Set<string>>(new Set());
  const frameCount = useRef(0);

  replayRef.current = replayTime;
  dotLifeRef.current = dotLifetime;
  onPingRef.current = onPing;

  useMemo(() => {
    const result: DotInfo[] = [];
    for (const c of complaints) {
      const lat = parseFloat(c.latitude ?? '');
      const lon = parseFloat(c.longitude ?? '');
      if (isNaN(lat) || isNaN(lon)) continue;
      const { x, y } = project(lat, lon);
      const dx = x - CX;
      const dy = y - CY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > R) continue;
      const angle = (Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI);
      result.push({
        key: c.unique_key, complaint: c,
        x, y, angle, dist,
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
      frameCount.current++;

      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.save();
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, 2 * Math.PI);
      ctx.clip();

      // ── Background — very dark ──────────────────────
      ctx.fillStyle = '#010408';
      ctx.fillRect(0, 0, SIZE, SIZE);

      // ── Subtle scan lines (CRT effect) ──────────────
      ctx.save();
      ctx.globalAlpha = 0.03;
      for (let y = 0; y < SIZE; y += 3) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, y, SIZE, 1);
      }
      ctx.restore();

      // ── Grid rings with range labels ────────────────
      ctx.strokeStyle = 'rgba(0,180,200,0.06)';
      ctx.lineWidth = 0.5;
      ctx.font = '7px JetBrains Mono, monospace';
      ctx.fillStyle = 'rgba(0,180,200,0.15)';
      const rangeLabels = ['5 MI', '10 MI', '15 MI', '20 MI'];
      for (let i = 1; i <= 4; i++) {
        const r = (R / 4) * i;
        ctx.beginPath();
        ctx.arc(CX, CY, r, 0, 2 * Math.PI);
        ctx.stroke();
        // Label at top of each ring
        ctx.fillText(rangeLabels[i - 1], CX + 3, CY - r + 10);
      }

      // ── Bearing marks around outer ring ─────────────
      ctx.save();
      ctx.font = '7px JetBrains Mono, monospace';
      ctx.fillStyle = 'rgba(0,180,200,0.2)';
      ctx.textAlign = 'center';
      const bearings = [
        { deg: 0, label: 'E' }, { deg: 90, label: 'S' },
        { deg: 180, label: 'W' }, { deg: 270, label: 'N' },
      ];
      for (const b of bearings) {
        const rad = (b.deg * Math.PI) / 180;
        const lx = CX + Math.cos(rad) * (R - 14);
        const ly = CY + Math.sin(rad) * (R - 14) + 3;
        ctx.fillText(b.label, lx, ly);
      }
      // Tick marks every 30°
      ctx.strokeStyle = 'rgba(0,180,200,0.1)';
      ctx.lineWidth = 1;
      for (let deg = 0; deg < 360; deg += 30) {
        const rad = (deg * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(CX + Math.cos(rad) * (R - 6), CY + Math.sin(rad) * (R - 6));
        ctx.lineTo(CX + Math.cos(rad) * R, CY + Math.sin(rad) * R);
        ctx.stroke();
      }
      // Minor ticks every 10°
      ctx.strokeStyle = 'rgba(0,180,200,0.05)';
      for (let deg = 0; deg < 360; deg += 10) {
        if (deg % 30 === 0) continue;
        const rad = (deg * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(CX + Math.cos(rad) * (R - 3), CY + Math.sin(rad) * (R - 3));
        ctx.lineTo(CX + Math.cos(rad) * R, CY + Math.sin(rad) * R);
        ctx.stroke();
      }
      ctx.restore();

      // ── Crosshairs ──────────────────────────────────
      ctx.strokeStyle = 'rgba(0,180,200,0.04)';
      ctx.setLineDash([2, 8]);
      ctx.beginPath();
      ctx.moveTo(CX - R, CY); ctx.lineTo(CX + R, CY);
      ctx.moveTo(CX, CY - R); ctx.lineTo(CX, CY + R);
      ctx.stroke();
      ctx.setLineDash([]);

      // ── Borough outlines — very dim ─────────────────
      ctx.strokeStyle = 'rgba(0,200,220,0.06)';
      ctx.lineWidth = 0.5;
      for (const p of boroughPaths) ctx.stroke(p);

      // ── Sweep trail — smooth via offscreen canvas ───
      renderTrail(sweep);
      ctx.drawImage(trailCanvas, 0, 0);

      // ── Sweep leading edge ──────────────────────────
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

      // ── Borough outlines — illuminated in beam ──────
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.arc(CX, CY, R, sweep - TRAIL_ARC * 0.25, sweep);
      ctx.closePath();
      ctx.clip();
      ctx.strokeStyle = 'rgba(0,200,220,0.2)';
      ctx.lineWidth = 0.8;
      for (const p of boroughPaths) ctx.stroke(p);
      ctx.restore();

      // ── Dots ────────────────────────────────────────
      const dots = dotsRef.current;
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        const age = now - d.createdMs;
        if (age < 0 || age > lifetime) continue;

        if (!pingedRef.current.has(d.key)) {
          pingedRef.current.add(d.key);
          onPingRef.current(d.complaint);
        }

        const freshness = 1 - age / lifetime;
        const isNew = age < 90000;

        // Beam proximity
        const behind = (sweep - d.angle + 2 * Math.PI) % (2 * Math.PI);
        const inBeam = behind < TRAIL_ARC;
        const beamBright = inBeam ? Math.pow(1 - behind / TRAIL_ARC, 3) : 0;

        ctx.save();
        if (isNew) {
          const glow = 1 - age / 90000;
          ctx.globalAlpha = 0.5 + 0.5 * glow;
          ctx.fillStyle = d.color;
          ctx.shadowColor = d.color;
          ctx.shadowBlur = 20 * glow;
          ctx.beginPath();
          ctx.arc(d.x, d.y, 2.5 + 4 * glow, 0, 2 * Math.PI);
          ctx.fill();
          // Ring burst on brand new
          if (glow > 0.7) {
            ctx.strokeStyle = d.color;
            ctx.globalAlpha = (glow - 0.7) * 3;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(d.x, d.y, 6 + (1 - glow) * 20, 0, 2 * Math.PI);
            ctx.stroke();
          }
        } else {
          const alpha = 0.03 + beamBright * 0.45 + freshness * 0.08;
          ctx.globalAlpha = Math.min(alpha, 0.9);
          ctx.fillStyle = d.color;
          if (beamBright > 0.2) {
            ctx.shadowColor = d.color;
            ctx.shadowBlur = 5 * beamBright;
          }
          ctx.beginPath();
          ctx.arc(d.x, d.y, 1.2 + freshness * 0.8 + beamBright * 1.2, 0, 2 * Math.PI);
          ctx.fill();
        }
        ctx.restore();
      }

      // ── HUD: active count + scan rate ───────────────
      ctx.save();
      ctx.font = '8px JetBrains Mono, monospace';
      ctx.fillStyle = 'rgba(0,200,220,0.3)';
      ctx.textAlign = 'left';
      const visCount = dots.filter(d => {
        const a = now - d.createdMs;
        return a >= 0 && a <= lifetime;
      }).length;
      ctx.fillText(`TGT: ${visCount}`, 14, SIZE - 28);
      ctx.fillText(`SWP: ${((frameCount.current / 60) | 0) % 100}`, 14, SIZE - 16);
      ctx.textAlign = 'right';
      const bearing = ((((sweep * 180) / Math.PI) + 90) % 360) | 0;
      ctx.fillText(`BRG: ${String(bearing).padStart(3, '0')}°`, SIZE - 14, SIZE - 28);
      ctx.fillText(`RNG: 20 MI`, SIZE - 14, SIZE - 16);
      ctx.restore();

      // ── Center dot ──────────────────────────────────
      ctx.save();
      ctx.fillStyle = '#00ccff';
      ctx.shadowColor = '#00ccff';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(CX, CY, 2, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();

      ctx.restore(); // end clip

      // ── Outer ring ──────────────────────────────────
      ctx.strokeStyle = 'rgba(0,200,220,0.25)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, 2 * Math.PI);
      ctx.stroke();

      // ── Edge vignette ───────────────────────────────
      ctx.save();
      const vig = ctx.createRadialGradient(CX, CY, R * 0.55, CX, CY, R);
      vig.addColorStop(0, 'rgba(1,4,8,0)');
      vig.addColorStop(0.65, 'rgba(1,4,8,0)');
      vig.addColorStop(1, 'rgba(1,4,8,0.75)');
      ctx.fillStyle = vig;
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
