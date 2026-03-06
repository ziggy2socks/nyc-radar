// Coordinate system for NYC radar
// Maps lat/lon to canvas pixel coordinates
// Center: roughly Midtown/LIC border — keeps all 5 boroughs in frame

export const CENTER_LAT = 40.730;
export const CENTER_LON = -73.935;

// Scale: how many pixels per degree
// NYC spans ~0.35° lat and ~0.4° lon
// We want the city to fill roughly 80% of the radar circle
const PX_PER_DEG_LAT = 1800;
const PX_PER_DEG_LON = 1800 * Math.cos(CENTER_LAT * Math.PI / 180);

export function latLonToXY(
  lat: number,
  lon: number,
  canvasCx: number,
  canvasCy: number
): { x: number; y: number } {
  const x = canvasCx + (lon - CENTER_LON) * PX_PER_DEG_LON;
  const y = canvasCy - (lat - CENTER_LAT) * PX_PER_DEG_LAT;
  return { x, y };
}
