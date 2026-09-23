import { calculatePositions, type PositioningInput } from './positioning'

self.onmessage = (event: MessageEvent<PositioningInput>) => {
  self.postMessage(calculatePositions(event.data))
}

export {}
