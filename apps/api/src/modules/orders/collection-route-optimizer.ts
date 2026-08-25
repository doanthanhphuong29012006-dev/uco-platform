export type RouteOptimizerStop = {
  id: string;
  lat: number;
  lng: number;
  pickup_priority_score: number;
  legacy_priority: number;
  original_index: number;
};

export type RouteOptimizerInput = {
  origin: {
    lat: number;
    lng: number;
  };
  stops: RouteOptimizerStop[];
};

export type RouteOptimizationReasonCode =
  | 'ROUTE_OPTIMIZED'
  | 'ALREADY_OPTIMAL'
  | 'INSUFFICIENT_STOPS'
  | 'INVALID_ORIGIN'
  | 'INVALID_STOP_COORDINATES';

export type RouteOptimizerResult = {
  stops: RouteOptimizerStop[];
  estimated_distance_before_m: number | null;
  estimated_distance_after_m: number | null;
  saved_distance_m: number | null;
  optimization_applied: boolean;
  reason_codes: RouteOptimizationReasonCode[];
};

type ScoreGroup = 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW' | 'INVALID_SCORE';

const EARTH_RADIUS_M = 6_371_000;
const SCORE_GROUP_ORDER: ScoreGroup[] = ['URGENT', 'HIGH', 'NORMAL', 'LOW', 'INVALID_SCORE'];

function isValidCoordinate(point: { lat: number; lng: number }): boolean {
  return Number.isFinite(point.lat)
    && Number.isFinite(point.lng)
    && point.lat >= -90
    && point.lat <= 90
    && point.lng >= -180
    && point.lng <= 180;
}

function scoreGroup(score: number): ScoreGroup {
  if (!Number.isFinite(score) || score < 0) return 'INVALID_SCORE';
  if (score >= 80) return 'URGENT';
  if (score >= 60) return 'HIGH';
  if (score >= 30) return 'NORMAL';
  return 'LOW';
}

function haversineDistanceM(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = toRadians(to.lat - from.lat);
  const longitudeDelta = toRadians(to.lng - from.lng);
  const fromLatitude = toRadians(from.lat);
  const toLatitude = toRadians(to.lat);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
}

function cloneStops(stops: RouteOptimizerStop[]): RouteOptimizerStop[] {
  return stops.map((stop) => ({ ...stop }));
}

function uniqueReasons(reasons: RouteOptimizationReasonCode[]): RouteOptimizationReasonCode[] {
  return [...new Set(reasons)];
}

function roundedDistance(distance: number): number {
  return Math.round(distance);
}

function routeDistance(origin: { lat: number; lng: number }, stops: RouteOptimizerStop[]): number {
  let total = 0;
  let current = origin;
  for (const stop of stops) {
    total += haversineDistanceM(current, stop);
    current = stop;
  }
  return total;
}

function compareTieBreakers(left: RouteOptimizerStop, right: RouteOptimizerStop): number {
  const leftScoreValid = Number.isFinite(left.pickup_priority_score) && left.pickup_priority_score >= 0;
  const rightScoreValid = Number.isFinite(right.pickup_priority_score) && right.pickup_priority_score >= 0;
  const scoreComparison = leftScoreValid && rightScoreValid
    ? right.pickup_priority_score - left.pickup_priority_score
    : 0;
  return scoreComparison
    || right.legacy_priority - left.legacy_priority
    || left.original_index - right.original_index
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function optimizeGroup(current: RouteOptimizerStop | RouteOptimizerInput['origin'], group: RouteOptimizerStop[]): { stops: RouteOptimizerStop[]; current: RouteOptimizerStop | RouteOptimizerInput['origin'] } {
  const validStops = group.filter(isValidCoordinate);
  const invalidStops = group.filter((stop) => !isValidCoordinate(stop));
  const remaining = [...validStops];
  const ordered: RouteOptimizerStop[] = [];
  let position = current;

  while (remaining.length > 0) {
    let nearestIndex = 0;
    let nearestDistance = haversineDistanceM(position, remaining[0]);
    for (let index = 1; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const candidateDistance = haversineDistanceM(position, candidate);
      if (candidateDistance < nearestDistance
        || (candidateDistance === nearestDistance && compareTieBreakers(candidate, remaining[nearestIndex]) < 0)) {
        nearestIndex = index;
        nearestDistance = candidateDistance;
      }
    }
    const [next] = remaining.splice(nearestIndex, 1);
    ordered.push(next);
    position = next;
  }

  return { stops: [...ordered, ...invalidStops], current: ordered.at(-1) ?? current };
}

export function optimizeCollectionRoute(input: RouteOptimizerInput): RouteOptimizerResult {
  const originalStops = cloneStops(input.stops);
  if (!isValidCoordinate(input.origin)) {
    return {
      stops: originalStops,
      estimated_distance_before_m: null,
      estimated_distance_after_m: null,
      saved_distance_m: null,
      optimization_applied: false,
      reason_codes: ['INVALID_ORIGIN'],
    };
  }

  const invalidCoordinateExists = originalStops.some((stop) => !isValidCoordinate(stop));
  const baseReasons: RouteOptimizationReasonCode[] = input.stops.length <= 1 ? ['INSUFFICIENT_STOPS'] : [];
  if (input.stops.length <= 1) {
    const metricsAvailable = !invalidCoordinateExists;
    const distance = metricsAvailable ? roundedDistance(routeDistance(input.origin, originalStops)) : null;
    const reasons = [...baseReasons];
    if (invalidCoordinateExists) reasons.push('INVALID_STOP_COORDINATES');
    return {
      stops: originalStops,
      estimated_distance_before_m: distance,
      estimated_distance_after_m: distance,
      saved_distance_m: distance === null ? null : 0,
      optimization_applied: false,
      reason_codes: uniqueReasons(reasons),
    };
  }

  const groups = new Map<ScoreGroup, RouteOptimizerStop[]>(SCORE_GROUP_ORDER.map((group) => [group, []]));
  for (const stop of originalStops) {
    groups.get(scoreGroup(stop.pickup_priority_score))?.push(stop);
  }

  const optimizedStops: RouteOptimizerStop[] = [];
  let current: RouteOptimizerStop | RouteOptimizerInput['origin'] = input.origin;
  for (const groupName of SCORE_GROUP_ORDER) {
    const group = groups.get(groupName) ?? [];
    const optimizedGroup = optimizeGroup(current, group);
    optimizedStops.push(...optimizedGroup.stops);
    current = optimizedGroup.current;
  }

  const orderChanged = optimizedStops.some((stop, index) => stop.id !== originalStops[index].id);
  const reasons = [orderChanged ? 'ROUTE_OPTIMIZED' : 'ALREADY_OPTIMAL'] as RouteOptimizationReasonCode[];
  if (invalidCoordinateExists) reasons.push('INVALID_STOP_COORDINATES');

  const metricsAvailable = !invalidCoordinateExists;
  const before = metricsAvailable ? roundedDistance(routeDistance(input.origin, originalStops)) : null;
  const after = metricsAvailable ? roundedDistance(routeDistance(input.origin, optimizedStops)) : null;
  return {
    stops: optimizedStops,
    estimated_distance_before_m: before,
    estimated_distance_after_m: after,
    saved_distance_m: before === null || after === null ? null : Math.max(before - after, 0),
    optimization_applied: orderChanged,
    reason_codes: uniqueReasons(reasons),
  };
}
