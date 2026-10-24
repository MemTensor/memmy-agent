/** Pet idle animation built directly from the supplied start-frame artwork. */
import { useEffect, useRef } from "react";
import { PetIdleRenderer, STAGE_SIZE, loadPetIdleImages, type PetIdleImages } from "./pet-idle-renderer.js";
import { samplePetIdleFrame } from "./pet-idle-timeline.js";

export interface PetIdleAnimationProps {
  /** Rendered width and height in CSS pixels. */
  size: number;
  /** Plays the loop from its first frame; when false the start frame is shown still. */
  playing: boolean;
  className?: string;
}

const FRAME_INTERVAL_MS = 1000 / 30;

let sharedImages: Promise<PetIdleImages> | null = null;

function petIdleImages(): Promise<PetIdleImages> {
  sharedImages ??= loadPetIdleImages().catch((error: unknown) => {
    sharedImages = null;
    throw error;
  });
  return sharedImages;
}

/**
 * Renders the desktop pet idle loop onto a canvas.
 *
 * @param props Size, play state and optional class name.
 * @returns A decorative canvas element.
 */
export function PetIdleAnimation({ size, playing, className }: PetIdleAnimationProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      return;
    }
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const animate = playing && !reduceMotion;
    let disposed = false;
    let frameId = 0;
    let renderer: PetIdleRenderer | null = null;
    let elapsedSeconds = 0;
    let lastDrawAt = -Infinity;

    const draw = (images: PetIdleImages, time: number) => {
      const pixels = Math.max(1, Math.round(size * Math.min(window.devicePixelRatio || 1, 3)));
      if (canvas.width !== pixels || canvas.height !== pixels) {
        canvas.width = pixels;
        canvas.height = pixels;
      }
      const pixelScale = pixels / STAGE_SIZE;
      if (!renderer || renderer.pixelScale !== pixelScale) {
        renderer = new PetIdleRenderer(images, pixelScale);
      }
      renderer.render(ctx, samplePetIdleFrame(time));
    };

    const loop = (images: PetIdleImages) => {
      const tick = (now: number) => {
        if (disposed) {
          return;
        }
        if (now - lastDrawAt >= FRAME_INTERVAL_MS - 1) {
          if (lastDrawAt !== -Infinity) {
            elapsedSeconds += Math.min(Math.max((now - lastDrawAt) / 1000, 0), 0.1);
          }
          lastDrawAt = now;
          draw(images, elapsedSeconds);
        }
        frameId = window.requestAnimationFrame(tick);
      };
      window.cancelAnimationFrame(frameId);
      lastDrawAt = -Infinity;
      frameId = window.requestAnimationFrame(tick);
    };

    let loadedImages: PetIdleImages | null = null;
    const handleVisibility = () => {
      if (!loadedImages || disposed) {
        return;
      }
      if (document.hidden) {
        window.cancelAnimationFrame(frameId);
      } else {
        loop(loadedImages);
      }
    };

    void petIdleImages()
      .then((images) => {
        if (disposed) {
          return;
        }
        loadedImages = images;
        draw(images, 0);
        if (animate) {
          document.addEventListener("visibilitychange", handleVisibility);
          if (!document.hidden) {
            loop(images);
          }
        }
      })
      .catch((error: unknown) => {
        console.warn("pet idle animation unavailable", error);
      });

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [playing, size]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" style={{ width: size, height: size, display: "block" }} />;
}
