// NYC 311 complaint data via NYC Open Data
// Dataset: 311 Service Requests (erm6-by3h)

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

// Top complaint categories with colors (cyan palette variants)
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
  // Try exact match first
  if (COMPLAINT_COLORS[type]) return COMPLAINT_COLORS[type];
  // Try partial match
  const key = Object.keys(COMPLAINT_COLORS).find(k =>
    type.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(type.toLowerCase())
  );
  return key ? COMPLAINT_COLORS[key] : DEFAULT_COLOR;
}

export async function fetchComplaints(): Promise<Complaint[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const query = [
    `$where=created_date >= '${since}' AND latitude IS NOT NULL AND longitude IS NOT NULL`,
    `$order=created_date DESC`,
    `$limit=2000`,
  ].map(p => p.replace(/ /g, '+')).join('&');

  const res = await fetch(`/api/311?${query}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`311 API error: ${res.status}`);
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
