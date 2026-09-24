import { normalizeAngle } from './sensors'

export type CameraOrientation = {
  heading: number
  elevation: number
  roll: number
  headingAvailable: boolean
}

export type Vector3 = { x: number; y: number; z: number }

export type CameraFrame = {
  forward: Vector3
  right: Vector3
  up: Vector3
  heading: number
  elevation: number
  roll: number
}

const EPSILON = 1e-8

function radians(degrees: number) {
  return degrees * Math.PI / 180
}

function degrees(radiansValue: number) {
  return radiansValue * 180 / Math.PI
}

function rotateDeviceVector(vector: Vector3, alpha: number, beta: number, gamma: number): Vector3 {
  const alphaRadians = radians(-alpha)
  const betaRadians = radians(beta)
  const gammaRadians = radians(gamma)
  const cosAlpha = Math.cos(alphaRadians)
  const sinAlpha = Math.sin(alphaRadians)
  const cosBeta = Math.cos(betaRadians)
  const sinBeta = Math.sin(betaRadians)
  const cosGamma = Math.cos(gammaRadians)
  const sinGamma = Math.sin(gammaRadians)

  const afterGamma = {
    x: cosGamma * vector.x + sinGamma * vector.z,
    y: vector.y,
    z: -sinGamma * vector.x + cosGamma * vector.z,
  }
  const afterBeta = {
    x: afterGamma.x,
    y: cosBeta * afterGamma.y - sinBeta * afterGamma.z,
    z: sinBeta * afterGamma.y + cosBeta * afterGamma.z,
  }
  return {
    x: cosAlpha * afterBeta.x - sinAlpha * afterBeta.y,
    y: sinAlpha * afterBeta.x + cosAlpha * afterBeta.y,
    z: afterBeta.z,
  }
}

function dot(left: Vector3, right: Vector3) {
  return left.x * right.x + left.y * right.y + left.z * right.z
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  }
}

function normalize(vector: Vector3): Vector3 | null {
  const length = Math.hypot(vector.x, vector.y, vector.z)
  if (length < EPSILON) return null
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length }
}

export function deriveCameraOrientation(alpha: number, beta: number, gamma: number): CameraOrientation {
  const forward = normalize(rotateDeviceVector({ x: 0, y: 0, z: -1 }, alpha, beta, gamma))!
  const screenUp = normalize(rotateDeviceVector({ x: 0, y: 1, z: 0 }, alpha, beta, gamma))!
  const horizontalMagnitude = Math.hypot(forward.x, forward.y)
  const headingAvailable = horizontalMagnitude > 0.01
  const heading = headingAvailable ? normalizeAngle(degrees(Math.atan2(forward.x, forward.y))) : normalizeAngle(alpha)
  const elevation = degrees(Math.asin(Math.max(-1, Math.min(1, forward.z))))

  const worldUp: Vector3 = { x: 0, y: 0, z: 1 }
  const projectedWorldUp = normalize({
    x: worldUp.x - forward.x * dot(worldUp, forward),
    y: worldUp.y - forward.y * dot(worldUp, forward),
    z: worldUp.z - forward.z * dot(worldUp, forward),
  })
  const roll = projectedWorldUp
    ? degrees(Math.atan2(dot(cross(projectedWorldUp, screenUp), forward), dot(projectedWorldUp, screenUp)))
    : 0

  return { heading, elevation, roll, headingAvailable }
}

export function cameraFrameFromAngles(heading: number, elevation: number, roll: number): CameraFrame {
  const headingRadians = radians(heading)
  const elevationRadians = radians(elevation)
  const rollRadians = radians(roll)
  const forward = normalize({
    x: Math.cos(elevationRadians) * Math.sin(headingRadians),
    y: Math.cos(elevationRadians) * Math.cos(headingRadians),
    z: Math.sin(elevationRadians),
  })!
  const levelRight = normalize({ x: Math.cos(headingRadians), y: -Math.sin(headingRadians), z: 0 })!
  const levelUp = normalize(cross(levelRight, forward))!
  const right = normalize({
    x: levelRight.x * Math.cos(rollRadians) - levelUp.x * Math.sin(rollRadians),
    y: levelRight.y * Math.cos(rollRadians) - levelUp.y * Math.sin(rollRadians),
    z: levelRight.z * Math.cos(rollRadians) - levelUp.z * Math.sin(rollRadians),
  })!
  const up = normalize(cross(right, forward))!
  return { forward, right, up, heading: normalizeAngle(heading), elevation, roll }
}

export function deriveAnchoredCameraFrame(
  alpha: number,
  beta: number,
  gamma: number,
  compassHeading: number,
): CameraFrame {
  const attitude = deriveCameraOrientation(alpha, beta, gamma)
  return cameraFrameFromAngles(compassHeading, attitude.elevation, attitude.roll)
}
