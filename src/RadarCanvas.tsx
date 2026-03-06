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
const TRAIL_ARC = Math.PI * 1.4;

interface DotInfo {
  key: string;
  complaint: Complaint;
  x: number;
  y: number;
  angle: number;
  dist: number;
  color: string;
  createdMs: number;
}

// A dot that has been "discovered" by the beam
interface ActiveDot {
  dot: DotInfo;
  discoveredAt: number; // replay time when beam first passed it
}

const project = makeProjection(SIZE);

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

// Offscreen trail canvas
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
    const alpha = Math.pow(1 - frac, 3) * 0.14;
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
  const frameCount = useRef(0);

  // All complaint dots (pre-computed positions)
  const allDotsRef = useRef<DotInfo[]>([]);
  // Dots waiting to be discovered (created_date <= replayTime, not yet swept)
  const pendingRef = useRef<Map<string, DotInfo>>(new Map());
  // Discovered dots (beam has passed them)
  const activeRef = useRef<Map<string, ActiveDot>>(new Map());

  const replayRef = useRef(replayTime);
  const dotLifeRef = useRef(dotLifetime);
  const onPingRef = useRef(onPing);

  replayRef.current = replayTime;
  dotLifeRef.current = dotLifetime;
  onPingRef.current = onPing;

  // Pre-compute all dot positions when complaints change
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
    allDotsRef.current = result;
    pendingRef.current.clear();
    activeRef.current.clear();
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

      // ── Move newly eligible dots into pending ───────
      // (created_date <= replay time, not already pending or active)
      for (const d of allDotsRef.current) {
        if (d.createdMs > now) continue; // not yet in replay timeline
        if (pendingRef.current.has(d.key)) continue;
        if (activeRef.current.has(d.key)) continue;
        pendingRef.current.set(d.key, d);
      }

      // ── Beam discovery: pending dots under the beam become active ──
      for (const [key, d] of pendingRef.current) {
        const behind = (sweep - d.angle + 2 * Math.PI) % (2 * Math.PI);
        if (behind < 0.15) { // beam is passing this dot (~8.5°)
          pendingRef.current.delete(key);
          activeRef.current.set(key, { dot: d, discoveredAt: now });
          onPingRef.current(d.complaint);
        }
      }

      // ── Expire old active dots ──────────────────────
      for (const [key, ad] of activeRef.current) {
        if (now - ad.discoveredAt > lifetime) {
          activeRef.current.delete(key);
        }
      }

      // ── DRAW ────────────────────────────────────────
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.save();
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, 2 * Math.PI);
      ctx.clip();

      // Background
      ctx.fillStyle = '#010408';
      ctx.fillRect(0, 0, SIZE, SIZE);

      // CRT scanlines
      ctx.save();
      ctx.globalAlpha = 0.03;
      for (let y = 0; y < SIZE; y += 3) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, y, SIZE, 1);
      }
      ctx.restore();

      // Grid rings + range labels
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
        ctx.fillText(rangeLabels[i - 1], CX + 3, CY - r + 10);
      }

      // Bearing marks
      ctx.save();
      ctx.font = '7px JetBrains Mono, monospace';
      ctx.fillStyle = 'rgba(0,180,200,0.2)';
      ctx.textAlign = 'center';
      for (const b of [
        { deg: 0, label: 'E' }, { deg: 90, label: 'S' },
        { deg: 180, label: 'W' }, { deg: 270, label: 'N' },
      ]) {
        const rad = (b.deg * Math.PI) / 180;
        ctx.fillText(b.label, CX + Math.cos(rad) * (R - 14), CY + Math.sin(rad) * (R - 14) + 3);
      }
      ctx.strokeStyle = 'rgba(0,180,200,0.1)';
      ctx.lineWidth = 1;
      for (let deg = 0; deg < 360; deg += 30) {
        const rad = (deg * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(CX + Math.cos(rad) * (R - 6), CY + Math.sin(rad) * (R - 6));
        ctx.lineTo(CX + Math.cos(rad) * R, CY + Math.sin(rad) * R);
        ctx.stroke();
      }
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

      // Crosshairs
      ctx.strokeStyle = 'rgba(0,180,200,0.04)';
      ctx.setLineDash([2, 8]);
      ctx.beginPath();
      ctx.moveTo(CX - R, CY); ctx.lineTo(CX + R, CY);
      ctx.moveTo(CX, CY - R); ctx.lineTo(CX, CY + R);
      ctx.stroke();
      ctx.setLineDash([]);

      // Borough outlines — dim
      ctx.strokeStyle = 'rgba(0,200,220,0.06)';
      ctx.lineWidth = 0.5;
      for (const p of boroughPaths) ctx.stroke(p);

      // Sweep trail
      renderTrail(sweep);
      ctx.drawImage(trailCanvas, 0, 0);

      // Sweep line
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

      // Borough outlines illuminated in beam
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

      // ── Draw active (discovered) dots ───────────────
      // Lifecycle:
      //   0–2s:    "flash" phase — 100% bright, 2x size, ring burst
      //   2s–3s:   settle — shrink to 1x, drop to 50% brightness
      //   3s+:     fade — 50% → 0% linearly over `lifetime` ms, then gone
      //   beam re-pass: +10% brightness bump (brief)

      const FLASH_MS = 2000;   // full bright discovery
      const SETTLE_MS = 1000;  // transition to settled state
      const BASE_SIZE = 2;     // settled dot radius

      for (const [, ad] of activeRef.current) {
        const d = ad.dot;
        const age = now - ad.discoveredAt;

        // Beam re-pass brightness bump
        const behind = (sweep - d.angle + 2 * Math.PI) % (2 * Math.PI);
        const beamBump = behind < 0.2 ? 0.10 * (1 - behind / 0.2) : 0; // +10% when beam is right on it

        let alpha: number;
        let radius: number;
        let glowBlur = 0;
        let ringBurst = false;
        let ringAlpha = 0;
        let ringRadius = 0;

        if (age < FLASH_MS) {
          // Flash phase: 100% bright, 2x size
          const t = age / FLASH_MS;
          alpha = 1.0;
          radius = BASE_SIZE * 2;
          glowBlur = 18 * (1 - t);
          // Ring burst in first 500ms
          if (age < 500) {
            ringBurst = true;
            ringAlpha = 1 - (age / 500);
            ringRadius = 6 + (age / 500) * 20;
          }
        } else if (age < FLASH_MS + SETTLE_MS) {
          // Settle phase: shrink 2x→1x, brightness 100%→50%
          const t = (age - FLASH_MS) / SETTLE_MS;
          alpha = 1.0 - 0.5 * t; // 1.0 → 0.5
          radius = BASE_SIZE * (2 - t); // 2x → 1x
          glowBlur = 4 * (1 - t);
        } else {
          // Fade phase: 50% → 0% over lifetime
          const fadeAge = age - FLASH_MS - SETTLE_MS;
          const fadeTotal = lifetime - FLASH_MS - SETTLE_MS;
          const fadeFrac = Math.min(fadeAge / fadeTotal, 1);
          alpha = 0.5 * (1 - fadeFrac); // 0.5 → 0.0
          radius = BASE_SIZE;
          glowBlur = 0;
        }

        // Add beam re-pass bump
        alpha = Math.min(alpha + beamBump, 1.0);
        if (beamBump > 0.02) {
          glowBlur = Math.max(glowBlur, 4 * (beamBump / 0.10));
        }

        if (alpha < 0.005) continue; // invisible, skip draw

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = d.color;
        if (glowBlur > 0) {
          ctx.shadowColor = d.color;
          ctx.shadowBlur = glowBlur;
        }
        ctx.beginPath();
        ctx.arc(d.x, d.y, radius, 0, 2 * Math.PI);
        ctx.fill();

        if (ringBurst) {
          ctx.globalAlpha = ringAlpha;
          ctx.strokeStyle = d.color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(d.x, d.y, ringRadius, 0, 2 * Math.PI);
          ctx.stroke();
        }
        ctx.restore();
      }

      // HUD
      ctx.save();
      ctx.font = '8px JetBrains Mono, monospace';
      ctx.fillStyle = 'rgba(0,200,220,0.3)';
      ctx.textAlign = 'left';
      ctx.fillText(`TGT: ${activeRef.current.size}`, 14, SIZE - 28);
      ctx.fillText(`PND: ${pendingRef.current.size}`, 14, SIZE - 16);
      ctx.textAlign = 'right';
      const bearing = ((((sweep * 180) / Math.PI) + 90) % 360) | 0;
      ctx.fillText(`BRG: ${String(bearing).padStart(3, '0')}°`, SIZE - 14, SIZE - 28);
      ctx.fillText(`RNG: 20 MI`, SIZE - 14, SIZE - 16);
      ctx.restore();

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
      ctx.strokeStyle = 'rgba(0,200,220,0.25)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, 2 * Math.PI);
      ctx.stroke();

      // Edge vignette
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
