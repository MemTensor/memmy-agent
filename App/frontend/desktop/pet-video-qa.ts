import { PetIdleRenderer, loadPetIdleImages } from "./src/components/mascot/pet-idle/pet-idle-renderer.ts";
import { samplePetIdleFrame } from "./src/components/mascot/pet-idle/pet-idle-timeline.ts";
const renderer = new PetIdleRenderer(await loadPetIdleImages(), 0.5);
for (const time of [0, 0.12, 0.28, 0.46, 0.64, 0.78, 1.9, 3.85, 7.75, 11.99]) {
  const card = document.createElement("div");card.className="card";
  const canvas = document.createElement("canvas");canvas.width=canvas.height=240;
  renderer.render(canvas.getContext("2d")!,samplePetIdleFrame(time));
  card.append(canvas,document.createTextNode(`${time}s`));document.body.append(card);
}
