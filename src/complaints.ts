// NYC 311 complaint data via NYC Open Data
// Dataset: 311 Service Requests from 2020 to Present (erm2-nwe9)

export interface Complaint {
  unique_key: string;
  complaint_type: string;
  descriptor?: string;
  created_date: string;
  latitude?: string;
  longitude?: string;
  borough?: string;
  status?: string;
}

// Top complaint categories with colors
export const COMPLAINT_COLORS: Record<string, string> = {
  'Noise - Residential':     '#00ccff',
  'Noise - Commercial':      '#00aadd',
  'Noise - Street/Sidewalk': '#0088bb',
  'Noise':                   '#00ccff',
  'HEAT/HOT WATER':          '#ff6b35',
  'Illegal Parking':         '#ffe600',
  'Blocked Driveway':        '#ffaa00',
  'Street Light Condition':  '#aaffcc',
  'PAINT/PLASTER':           '#cc88ff',
  'PLUMBING':                '#88aaff',
  'Rodent':                  '#ff4466',
  'Sanitation Condition':    '#88ff88',
  'Graffiti':                '#ff88cc',
  'Street Condition':        '#ffcc44',
  'Building/Use':            '#44ccff',
  'Dead/Dying Tree':         '#44ff88',
  'Derelict Vehicle':        '#ff8844',
  'Drug Activity':           '#ff4488',
  'Homeless Person Assistance': '#88ccff',
  'Encampment':              '#ffaa66',
};

export const DEFAULT_COLOR = '#00ccff';

export function getComplaintColor(type: string): string {
  if (COMPLAINT_COLORS[type]) return COMPLAINT_COLORS[type];
  const key = Object.keys(COMPLAINT_COLORS).find(k =>
    type.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(type.toLowerCase())
  );
  return key ? COMPLAINT_COLORS[key] : DEFAULT_COLOR;
}

/**
 * Fetch a full day of complaints (yesterday).
 * Returns sorted by created_date ASC (chronological order for replay).
 */
export async function fetchComplaints(): Promise<Complaint[]> {
  // NOTE: Never use URLSearchParams — encodes '$' as '%24' breaking Socrata
  const now = new Date();
  // Yesterday: full day
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const dayStart = yesterday.toISOString().split('T')[0]; // "2026-03-05"
  const dayEnd = now.toISOString().split('T')[0];         // "2026-03-06"

  const qs = `$where=latitude+IS+NOT+NULL+AND+longitude+IS+NOT+NULL+AND+created_date>='${dayStart}'+AND+created_date<'${dayEnd}'&$order=created_date+ASC&$limit=10000`;

  const res = await fetch(`/api/311?${qs}`, { cache: 'no-store' });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`311 API error: ${res.status} — ${txt.slice(0, 200)}`);
  }
  return res.json();
}

export function getTopComplaintTypes(complaints: Complaint[], n = 12): string[] {
  const counts = new Map<string, number>();
  for (const c of complaints) {
    counts.set(c.complaint_type, (counts.get(c.complaint_type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(e => e[0]);
}
