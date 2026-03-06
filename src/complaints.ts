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
 * Fetch a full day of complaints for a given date string (YYYY-MM-DD).
 * Returns sorted by created_date ASC (chronological for replay).
 */
export async function fetchComplaintsForDate(dateStr: string): Promise<Complaint[]> {
  // NOTE: Never use URLSearchParams — encodes '$' as '%24' breaking Socrata
  const nextDay = new Date(new Date(dateStr + 'T00:00:00').getTime() + 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];

  const qs = `$where=latitude+IS+NOT+NULL+AND+longitude+IS+NOT+NULL+AND+created_date>='${dateStr}'+AND+created_date<'${nextDay}'&$order=created_date+ASC&$limit=12000`;

  const res = await fetch(`/api/311?${qs}`, { cache: 'no-store' });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`311 API error: ${res.status} — ${txt.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Get the best available date (yesterday, or 2 days ago if yesterday has <500 records).
 */
export async function fetchComplaints(): Promise<{ data: Complaint[]; date: string }> {
  // Try yesterday first
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const data = await fetchComplaintsForDate(yesterday);
  if (data.length >= 500) return { data, date: yesterday };

  // Fall back to 2 days ago
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const fallback = await fetchComplaintsForDate(twoDaysAgo);
  return { data: fallback.length > data.length ? fallback : data, date: fallback.length > data.length ? twoDaysAgo : yesterday };
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
