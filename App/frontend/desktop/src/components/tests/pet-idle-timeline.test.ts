import { describe, expect, it } from "vitest";
import { PET_IDLE_DURATION, samplePetIdleFrame } from "../mascot/pet-idle/pet-idle-timeline.js";

describe("Memmy pet idle loop", () => {
  it("starts on the supplied art with the bubble visible", () => {
    const first = samplePetIdleFrame(0);
    expect(first.blink).toBe(0);
    expect(first.spoon).toEqual({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    expect(first.thought).toEqual({ x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 });
    expect(samplePetIdleFrame(PET_IDLE_DURATION).spoon).toEqual(first.spoon);
    expect(samplePetIdleFrame(PET_IDLE_DURATION).blink).toBe(0);
  });

  it("pops the thought bubble once and keeps it gone", () => {
    expect(samplePetIdleFrame(0.12).thought.opacity).toBe(1);
    expect(samplePetIdleFrame(0.28).thought.scale).toBeLessThan(0.9);
    expect(samplePetIdleFrame(0.64).thought.opacity).toBeGreaterThan(0);
    expect(samplePetIdleFrame(0.9).thought.opacity).toBe(0);
    expect(samplePetIdleFrame(3.85).thought.opacity).toBe(0);
    expect(samplePetIdleFrame(PET_IDLE_DURATION + 0.2).thought.opacity).toBe(0);
  });

  it("keeps the visible lift and landing motion independent of the bubble", () => {
    const lift = samplePetIdleFrame(3.85);
    const landing = samplePetIdleFrame(4.22);
    expect(lift.spoon.y).toBeLessThan(-15);
    expect(landing.spoon.y).toBeGreaterThan(0);
    expect(lift.thought.opacity).toBe(0);
  });

  it("blinks briefly between the larger motions", () => {
    expect(samplePetIdleFrame(1.25).blink).toBe(1);
    expect(samplePetIdleFrame(5.75).blink).toBe(1);
    expect(samplePetIdleFrame(10.35).blink).toBe(1);
    expect(samplePetIdleFrame(1.5).blink).toBe(0);
  });

  it("moves continuously, including the loop boundary", () => {
    let previous = samplePetIdleFrame(0);
    for (let time = 1 / 240; time <= PET_IDLE_DURATION; time += 1 / 240) {
      const next = samplePetIdleFrame(time);
      expect(Math.abs(next.spoon.y - previous.spoon.y)).toBeLessThan(0.55);
      expect(Math.abs(next.spoon.rotation - previous.spoon.rotation)).toBeLessThan(0.002);
      expect(Math.abs(next.thought.y - previous.thought.y)).toBeLessThan(0.55);
      expect(Math.abs(next.thought.opacity - previous.thought.opacity)).toBeLessThan(0.04);
      previous = next;
    }
  });
});
