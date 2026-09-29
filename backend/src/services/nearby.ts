import { repo } from '../db/index.js';
import type { Complaint, IssueType } from '../db/types.js';

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const OPEN = new Set(['drafted', 'submitting', 'submitted', 'submission_failed', 'escalated']);

/** Complaints near a point, nearest first. Excludes ones still being analyzed. */
export async function findNearby(
  lat: number,
  lng: number,
  radiusM: number,
  opts: { issueType?: IssueType; openOnly?: boolean; limit?: number } = {},
) {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.2));
  const rows = await repo.listComplaintsInBox({ minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng }, 500);
  const recentResolved = Date.now() - 30 * 86_400_000;
  return rows
    .filter((c) => c.status !== 'analyzing')
    .filter((c) => (opts.openOnly ? OPEN.has(c.status) : OPEN.has(c.status) || (c.status === 'resolved' && new Date(c.resolved_at ?? c.updated_at).getTime() > recentResolved)))
    .filter((c) => !opts.issueType || c.issue_type === opts.issueType)
    .map((c) => ({ c, distance: distanceMeters(lat, lng, c.latitude!, c.longitude!) }))
    .filter((x) => x.distance <= radiusM)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, opts.limit ?? 200);
}

/** What any signed-in resident may see about someone else's complaint: no names, phones or letter text. */
export function publicView(c: Complaint, viewer: { userId: string; supported: Set<string> }, distance?: number) {
  return {
    id: c.id,
    issue_type: c.issue_type,
    status: c.status,
    severity: c.severity,
    description: c.description,
    photo_url: c.photo_url,
    latitude: c.latitude,
    longitude: c.longitude,
    address: c.address,
    jurisdiction_department: c.jurisdiction_department,
    tracking_id: c.tracking_id,
    supporters_count: c.supporters_count ?? 0,
    created_at: c.created_at,
    submitted_at: c.submitted_at,
    resolved_at: c.resolved_at,
    distance_m: distance != null ? Math.round(distance) : null,
    is_mine: c.user_id === viewer.userId,
    supported_by_me: viewer.supported.has(c.id),
  };
}

export async function supportedSet(userId: string) {
  return new Set((await repo.listSupportedComplaints(userId)).map((c) => c.id));
}
