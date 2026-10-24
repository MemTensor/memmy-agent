/** Canvas renderer for the supplied first frame and its two connected art pieces. */
import startFrameUrl from "../../../assets/mascot/memmy-think.png";
import type { PetIdleFrame } from "./pet-idle-timeline.js";

export const STAGE_SIZE = 480;
const SOURCE_WIDTH = 512;
const SOURCE_HEIGHT = 341;
const ART_SCALE = 0.89;
const ART_ORIGIN = { x: 12, y: 94 };
const SPOON_PIVOT = { x: 260, y: 255 };
const THOUGHT_PIVOT = { x: 365, y: 65 };

export interface PetIdleImages {
  spoon: HTMLCanvasElement;
  thought: HTMLCanvasElement;
  blink: HTMLCanvasElement;
}

function canvas(): HTMLCanvasElement {
  const element = document.createElement("canvas");
  element.width = SOURCE_WIDTH;
  element.height = SOURCE_HEIGHT;
  return element;
}

function imageContext(element: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = element.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");
  return context;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load pet start frame: ${src}`));
    image.src = src;
  });
}

/**
 * The bubble is disconnected from the spoon in the user's PNG. Separate the
 * two alpha components once, without redrawing the character or its texture.
 */
export async function loadPetIdleImages(): Promise<PetIdleImages> {
  const image = await loadImage(startFrameUrl);
  if (image.naturalWidth !== SOURCE_WIDTH || image.naturalHeight !== SOURCE_HEIGHT) {
    throw new Error("Unexpected pet start-frame dimensions");
  }

  const source = canvas();
  const sourceContext = imageContext(source);
  sourceContext.drawImage(image, 0, 0);
  const pixels = sourceContext.getImageData(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);
  const labels = new Uint8Array(SOURCE_WIDTH * SOURCE_HEIGHT);
  const queue = new Int32Array(labels.length);

  const markComponent = (seedX: number, seedY: number, label: number) => {
    const seed = seedY * SOURCE_WIDTH + seedX;
    if (pixels.data[seed * 4 + 3]! <= 4) throw new Error("Pet art component seed is transparent");
    let front = 0;
    let back = 0;
    labels[seed] = label;
    queue[back++] = seed;
    while (front < back) {
      const position = queue[front++]!;
      const x = position % SOURCE_WIDTH;
      const y = Math.floor(position / SOURCE_WIDTH);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= SOURCE_WIDTH || ny < 0 || ny >= SOURCE_HEIGHT) continue;
          const neighbor = ny * SOURCE_WIDTH + nx;
          if (labels[neighbor] || pixels.data[neighbor * 4 + 3]! <= 4) continue;
          labels[neighbor] = label;
          queue[back++] = neighbor;
        }
      }
    }
    return back;
  };

  const spoonArea = markComponent(230, 170, 1);
  const thoughtArea = markComponent(360, 50, 2);
  if (spoonArea < 50_000 || thoughtArea < 4_000) {
    throw new Error("Pet start-frame artwork could not be separated");
  }

  const spoon = canvas();
  const thought = canvas();
  const spoonPixels = imageContext(spoon).createImageData(SOURCE_WIDTH, SOURCE_HEIGHT);
  const thoughtPixels = imageContext(thought).createImageData(SOURCE_WIDTH, SOURCE_HEIGHT);
  for (let pixel = 0; pixel < labels.length; pixel += 1) {
    const destination = labels[pixel] === 1 ? spoonPixels.data : labels[pixel] === 2 ? thoughtPixels.data : null;
    if (!destination) continue;
    const offset = pixel * 4;
    destination[offset] = pixels.data[offset]!;
    destination[offset + 1] = pixels.data[offset + 1]!;
    destination[offset + 2] = pixels.data[offset + 2]!;
    destination[offset + 3] = pixels.data[offset + 3]!;
  }
  imageContext(spoon).putImageData(spoonPixels, 0, 0);
  imageContext(thought).putImageData(thoughtPixels, 0, 0);

  const blink = canvas();
  const blinkContext = imageContext(blink);
  for (const eye of [{ x: 201.5, y: 173.5 }, { x: 273.2, y: 159 }]) {
    // Borrow fur immediately above each eye, then feather it over the open eye.
    const patch = document.createElement("canvas");
    patch.width = 46;
    patch.height = 46;
    const patchContext = imageContext(patch);
    patchContext.drawImage(spoon, eye.x - 23, eye.y - 62, 46, 46, 0, 0, 46, 46);
    patchContext.globalCompositeOperation = "destination-in";
    const feather = patchContext.createRadialGradient(23, 23, 12, 23, 23, 23);
    feather.addColorStop(0, "rgba(0,0,0,1)");
    feather.addColorStop(1, "rgba(0,0,0,0)");
    patchContext.fillStyle = feather;
    patchContext.fillRect(0, 0, 46, 46);
    blinkContext.drawImage(patch, eye.x - 23, eye.y - 23);

    blinkContext.beginPath();
    blinkContext.moveTo(eye.x - 10, eye.y + 1);
    blinkContext.quadraticCurveTo(eye.x, eye.y - 6, eye.x + 10, eye.y + 1);
    blinkContext.lineWidth = 3.4;
    blinkContext.lineCap = "round";
    blinkContext.strokeStyle = "#59483d";
    blinkContext.stroke();
  }
  return { spoon, thought, blink };
}

export class PetIdleRenderer {
  constructor(private readonly images: PetIdleImages, readonly pixelScale: number) {}

  render(context: CanvasRenderingContext2D, frame: PetIdleFrame): void {
    const k = this.pixelScale;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, context.canvas.width, context.canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.setTransform(k, 0, 0, k, 0, 0);

    const draw = (image: HTMLCanvasElement, pivot: { x: number; y: number }, x: number, y: number, rotation: number, scaleX: number, scaleY: number, overlay?: HTMLCanvasElement, overlayAlpha = 0, alpha = 1) => {
      if (alpha <= 0) return;
      context.save();
      context.globalAlpha = Math.min(1, Math.max(0, alpha));
      context.translate(ART_ORIGIN.x + pivot.x * ART_SCALE + x, ART_ORIGIN.y + pivot.y * ART_SCALE + y);
      context.rotate(rotation);
      context.scale(scaleX, scaleY);
      context.drawImage(image, -pivot.x * ART_SCALE, -pivot.y * ART_SCALE, SOURCE_WIDTH * ART_SCALE, SOURCE_HEIGHT * ART_SCALE);
      if (overlay && overlayAlpha > 0) {
        context.globalAlpha = overlayAlpha;
        context.drawImage(overlay, -pivot.x * ART_SCALE, -pivot.y * ART_SCALE, SOURCE_WIDTH * ART_SCALE, SOURCE_HEIGHT * ART_SCALE);
      }
      context.restore();
    };

    draw(this.images.spoon, SPOON_PIVOT, frame.spoon.x, frame.spoon.y, frame.spoon.rotation, frame.spoon.scaleX, frame.spoon.scaleY, this.images.blink, frame.blink);
    draw(this.images.thought, THOUGHT_PIVOT, frame.thought.x, frame.thought.y, frame.thought.rotation, frame.thought.scale, frame.thought.scale, undefined, 0, frame.thought.opacity);
  }
}
