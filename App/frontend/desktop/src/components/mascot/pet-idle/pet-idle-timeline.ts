/** A quiet, twelve-second idle motion with a one-time thought-bubble pop. */
export const PET_IDLE_DURATION = 12;

export interface PetIdleFrame {
  time: number;
  blink: number;
  spoon: { x: number; y: number; rotation: number; scaleX: number; scaleY: number };
  thought: { x: number; y: number; rotation: number; scale: number; opacity: number };
}

type Key = readonly [time: number, value: number];

/** Cosine interpolation stops at each pose, so the little character never jerks. */
function track(time: number, keys: readonly Key[]): number {
  for (let index = 1; index < keys.length; index += 1) {
    const next = keys[index]!;
    if (time <= next[0]) {
      const previous = keys[index - 1]!;
      const progress = (time - previous[0]) / (next[0] - previous[0]);
      const eased = (1 - Math.cos(Math.PI * progress)) / 2;
      return previous[1] + (next[1] - previous[1]) * eased;
    }
  }
  return keys[keys.length - 1]![1];
}

const spoonX: Key[] = [[0, 0], [2.1, 0], [2.9, -3], [3.8, 1], [4.7, 0], [7.1, 0], [7.8, 3], [8.7, -1], [9.5, 0], [12, 0]];
const spoonY: Key[] = [[0, 0], [1.15, 0], [1.95, 2], [2.4, 0], [3.0, 1], [3.48, -16], [3.85, -20], [4.22, 3], [4.75, 0], [6.8, 0], [7.5, 2], [8.05, -6], [8.55, 1], [9.3, 0], [12, 0]];
const spoonRotation: Key[] = [[0, 0], [2.15, 0], [2.85, -0.035], [3.55, 0.048], [4.2, -0.025], [4.9, 0], [7.05, 0], [7.75, 0.035], [8.4, -0.032], [9.25, 0], [12, 0]];
const spoonScaleX: Key[] = [[0, 1], [1.2, 1], [1.9, 1.012], [2.4, 1], [3.25, 0.985], [3.8, 0.99], [4.22, 1.028], [4.85, 1], [7.4, 1], [8.05, 0.99], [8.55, 1.018], [9.3, 1], [12, 1]];
const spoonScaleY: Key[] = [[0, 1], [1.2, 1], [1.9, 0.989], [2.4, 1], [3.25, 1.01], [3.8, 1.025], [4.22, 0.974], [4.85, 1], [7.4, 1], [8.05, 1.012], [8.55, 0.987], [9.3, 1], [12, 1]];

// The supplied first frame includes the bubble. It pops once, then stays gone
// while the spoon continues its quiet idle loop.
const thoughtX: Key[] = [[0, 0], [0.16, 0], [0.34, 2], [0.56, -3], [0.78, -8], [12, -8]];
const thoughtY: Key[] = [[0, 0], [0.16, -4], [0.34, -13], [0.56, -22], [0.78, -27], [12, -27]];
const thoughtRotation: Key[] = [[0, 0], [0.18, -0.04], [0.42, 0.08], [0.68, -0.08], [0.78, -0.08], [12, -0.08]];
const thoughtScale: Key[] = [[0, 1], [0.12, 1.08], [0.28, 0.86], [0.46, 0.48], [0.64, 0.14], [0.78, 0], [12, 0]];

function thoughtOpacityAt(elapsed: number): number {
  if (elapsed <= 0.12) return 1;
  if (elapsed >= 0.78) return 0;
  const progress = (elapsed - 0.12) / (0.78 - 0.12);
  return (1 + Math.cos(Math.PI * progress)) / 2;
}

function blinkAt(time: number): number {
  let openness = 0;
  for (const center of [1.25, 5.75, 10.35]) {
    const distance = Math.abs(time - center);
    if (distance < 0.14) {
      openness = Math.max(openness, (1 + Math.cos(Math.PI * distance / 0.14)) / 2);
    }
  }
  return openness;
}

export function samplePetIdleFrame(time: number): PetIdleFrame {
  const elapsed = Math.max(0, time);
  const t = ((elapsed % PET_IDLE_DURATION) + PET_IDLE_DURATION) % PET_IDLE_DURATION;
  return {
    time: t,
    blink: blinkAt(t),
    spoon: {
      x: track(t, spoonX),
      y: track(t, spoonY),
      rotation: track(t, spoonRotation),
      scaleX: track(t, spoonScaleX),
      scaleY: track(t, spoonScaleY)
    },
    thought: {
      x: track(elapsed, thoughtX),
      y: track(elapsed, thoughtY),
      rotation: track(elapsed, thoughtRotation),
      scale: track(elapsed, thoughtScale),
      opacity: thoughtOpacityAt(elapsed)
    }
  };
}
