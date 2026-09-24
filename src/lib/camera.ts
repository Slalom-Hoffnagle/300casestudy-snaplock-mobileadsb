export type FieldOfView = { horizontal: number; vertical: number }

function croppedAngle(fullAngleDegrees: number, visibleFraction: number) {
  const halfAngle = fullAngleDegrees * Math.PI / 360
  return 2 * Math.atan(Math.tan(halfAngle) * visibleFraction) * 180 / Math.PI
}

export function effectiveCoverFov(
  configured: FieldOfView,
  sourceWidth: number | null,
  sourceHeight: number | null,
  viewportWidth: number,
  viewportHeight: number,
): FieldOfView {
  if (!sourceWidth || !sourceHeight || viewportWidth <= 0 || viewportHeight <= 0) return configured
  const sourceAspect = sourceWidth / sourceHeight
  const viewportAspect = viewportWidth / viewportHeight
  const horizontalFraction = sourceAspect > viewportAspect ? viewportAspect / sourceAspect : 1
  const verticalFraction = sourceAspect < viewportAspect ? sourceAspect / viewportAspect : 1
  return {
    horizontal: croppedAngle(configured.horizontal, horizontalFraction),
    vertical: croppedAngle(configured.vertical, verticalFraction),
  }
}
