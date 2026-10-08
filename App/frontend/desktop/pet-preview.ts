import { PetIdleRenderer, loadPetIdleImages } from "./src/components/mascot/pet-idle/pet-idle-renderer.ts";
import { PET_IDLE_DURATION, samplePetIdleFrame } from "./src/components/mascot/pet-idle/pet-idle-timeline.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#pet")!;
const context = canvas.getContext("2d")!;
const smallCanvas = document.querySelector<HTMLCanvasElement>("#pet-small")!;
const smallContext = smallCanvas.getContext("2d")!;
const seek = document.querySelector<HTMLInputElement>("#seek")!;
const play = document.querySelector<HTMLButtonElement>("#play")!;
const timeLabel = document.querySelector<HTMLOutputElement>("#time")!;
const status = document.querySelector<HTMLDivElement>("#status")!;

const selectedTime = Number(new URLSearchParams(location.search).get("t"));
let currentTime = Number.isFinite(selectedTime) ? Math.max(0, Math.min(selectedTime, PET_IDLE_DURATION)) : 0;
let playing = !new URLSearchParams(location.search).has("t");
let lastTick = performance.now();
play.textContent = playing ? "暂停" : "播放";

seek.addEventListener("input", () => {
  currentTime = Number(seek.value);
  playing = false;
  play.textContent = "播放";
});
play.addEventListener("click", () => {
  playing = !playing;
  play.textContent = playing ? "暂停" : "播放";
  lastTick = performance.now();
});

try {
  const images = await loadPetIdleImages();
  const renderer = new PetIdleRenderer(images, 1);
  const smallRenderer = new PetIdleRenderer(images, 0.25);
  status.textContent = "首帧保留你提供的气泡；开场轻轻破灭，之后气泡保持消失，木勺与饭团继续轻晃、眨眼和短短弹起。";
  const tick = (now: number) => {
    if (playing) currentTime += Math.min((now - lastTick) / 1000, 0.1);
    lastTick = now;
    const frame = samplePetIdleFrame(currentTime);
    renderer.render(context, frame);
    smallRenderer.render(smallContext, frame);
    const loopTime = ((currentTime % PET_IDLE_DURATION) + PET_IDLE_DURATION) % PET_IDLE_DURATION;
    seek.value = String(loopTime);
    timeLabel.textContent = `${loopTime.toFixed(1)} 秒`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
} catch (error) {
  status.textContent = `加载失败：${error instanceof Error ? error.message : String(error)}`;
}
