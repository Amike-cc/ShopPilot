export interface OrbPoint { x: number; y: number }

/** Match the orb's pointer gesture threshold: movement must exceed about six CSS pixels. */
export function isOrbDrag(dx: number, dy: number, threshold = 6): boolean {
  return Math.hypot(dx, dy) > threshold
}

export function clampOrbPoint(point: OrbPoint, max: OrbPoint): OrbPoint {
  return {
    x: Math.min(Math.max(Number.isFinite(point.x) ? point.x : 0, 0), Math.max(0, max.x)),
    y: Math.min(Math.max(Number.isFinite(point.y) ? point.y : 0, 0), Math.max(0, max.y))
  }
}

/**
 * Snap to the closest window edge while preserving the position along that edge.
 * This keeps the orb docked without forcing it into one of four corners.
 */
export function snapOrbToNearestEdge(point: OrbPoint, max: OrbPoint): OrbPoint {
  const clamped = clampOrbPoint(point, max)
  const distances = [
    { distance: clamped.x, point: { x: 0, y: clamped.y } },
    { distance: Math.max(0, max.x) - clamped.x, point: { x: Math.max(0, max.x), y: clamped.y } },
    { distance: clamped.y, point: { x: clamped.x, y: 0 } },
    { distance: Math.max(0, max.y) - clamped.y, point: { x: clamped.x, y: Math.max(0, max.y) } }
  ]
  return distances.reduce((nearest, candidate) => candidate.distance < nearest.distance ? candidate : nearest).point
}

/** @deprecated Kept for callers outside the Agent UI; new behavior uses edge docking. */
export function snapOrbToNearestCorner(point: OrbPoint, max: OrbPoint): OrbPoint {
  const corners = [{ x: 0, y: 0 }, { x: max.x, y: 0 }, { x: 0, y: max.y }, { x: max.x, y: max.y }]
  return corners.reduce((nearest, corner) => Math.hypot(corner.x - point.x, corner.y - point.y) < Math.hypot(nearest.x - point.x, nearest.y - point.y) ? corner : nearest)
}
