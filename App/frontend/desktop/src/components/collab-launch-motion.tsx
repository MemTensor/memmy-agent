/**
 * The moving stage of the one-time project-collaboration announcement.
 *
 * The picture is a pure function of elapsed time: one `requestAnimationFrame` loop advances a clock and calls
 * `render(t)` once per frame, and `render` only writes `style` and attribute values on nodes the JSX already built -
 * it never creates elements, measures layout or asks React for a render. React owns the structure and a single piece
 * of state: the caption currently on screen, which is reported through `onSceneChange` only when the scene changes.
 *
 * Geometry, timing, camera keyframes and colours are the ones the design prototype fixed; where a number looks odd it
 * is the prototype's, not a mistake here.
 */
import { useEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import memmyAppIconUrl from "../assets/memmy-app-icon.png";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentSourceLogoUrl } from "../pages/agent-source-logos.js";

const STAGE_WIDTH = 928;
const STAGE_HEIGHT = 420;

/** How many captions the stage has, one per scene. */
export const COLLAB_LAUNCH_SCENES = 6;

/** The caption of each scene; the third one is a single line. */
export const COLLAB_LAUNCH_CAPTIONS: ReadonlyArray<{ main: MessageKey; sub: MessageKey | null }> = [
  { main: "collabLaunch.scene1Main", sub: "collabLaunch.scene1Sub" },
  { main: "collabLaunch.scene2Main", sub: "collabLaunch.scene2Sub" },
  { main: "collabLaunch.scene3Main", sub: null },
  { main: "collabLaunch.scene4Main", sub: "collabLaunch.scene4Sub" },
  { main: "collabLaunch.scene5Main", sub: "collabLaunch.scene5Sub" },
  { main: "collabLaunch.scene6Main", sub: "collabLaunch.scene6Sub" }
];

/** Scene boundaries; `done` is the closing frame the animation stops on. */
const TIMELINE = { s1: 0, s2: 4.8, s2b: 9.0, s3: 12.2, s4: 18.8, s5: 25.4, done: 27.6 } as const;
const SCENE_STARTS = [TIMELINE.s1, TIMELINE.s2, TIMELINE.s3, TIMELINE.s4, TIMELINE.s5, TIMELINE.done];
const CAPTION_STARTS = [TIMELINE.s1, TIMELINE.s2, TIMELINE.s2b, TIMELINE.s3, TIMELINE.s4, TIMELINE.s5];

/**
 * The five pieces of the progress indicator sit on the five acts of the timeline, not on the six captions: the shared
 * agent follows the hand-relay act without a piece of its own, so act three starts at caption four.
 */
const ACT_CAPTIONS = [0, 1, 3, 4, 5];

/** [time, centre x, centre y, zoom]; the camera eases between frames, a repeated frame is a hold. */
const CAMERA: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 163, 232, 1.62],
  [2.3, 163, 232, 1.62],
  [3.7, 464, 210, 1.03],
  [4.9, 464, 210, 1.03],
  [9.0, 464, 204, 1.04],
  [11.9, 464, 199, 1.065],
  [12.9, 464, 210, 1.0],
  [15.2, 464, 210, 1.0],
  [16.2, 640, 205, 1.38],
  [18.3, 640, 205, 1.38],
  [19.0, 464, 210, 1.03],
  [19.1, 464, 210, 1.03],
  [20.5, 652, 204, 1.42],
  [22.95, 652, 204, 1.42],
  [24.4, 464, 210, 1.03],
  [24.9, 464, 210, 1.03],
  [26.8, 464, 210, 0.86]
];

/** World positions of the people, their agents and the project. */
const SPOT = {
  personA: [92, 210] as const,
  agentA: [232, 210] as const,
  agentB: [696, 210] as const,
  personB: [836, 210] as const,
  project: [464, 210] as const,
  personC: [464, 38] as const,
  agentC: [464, 100] as const,
  agentD: [464, 320] as const,
  personD: [464, 382] as const,
  stackA: [163, 305] as const,
  stackB: [765, 305] as const,
  apex: [464, 72] as const
};

/** Avatar tints: [background, figure, document stripe]. */
const TINT = {
  A: ["#e0dffc", "#8f8bdc", "#aeaaee"],
  B: ["#fdf2b8", "#d0ae3a", "#e6cc62"],
  C: ["#ffd3db", "#de8496"],
  D: ["#d6e7fb", "#7aa5db"]
} as const;

const EMBER_RGB = [236, 132, 74];
const HOT_RGB = [214, 72, 38];
const GRAY_RGB = [112, 124, 121];
const MINT_RGB = [42, 152, 132];

/** One relay of work between two people: the label, the lane it travels on and its progress along it. */
interface RelayTrip {
  key: MessageKey;
  lane: number;
  t0: number;
  t1: number;
  u0: number;
  u1: number;
}

/** Hand relays between the two people, then hand relays into the shared agent. Arriving counts once. */
const RELAYS: ReadonlyArray<RelayTrip> = [
  { key: "collabLaunch.relay1", lane: 0, t0: 5.25, t1: 6.15, u0: 0, u1: 1 },
  { key: "collabLaunch.relay2", lane: 0, t0: 6.15, t1: 6.9, u0: 1, u1: 0 },
  { key: "collabLaunch.relay3", lane: 1, t0: 6.85, t1: 7.5, u0: 0, u1: 1 },
  { key: "collabLaunch.relay4", lane: 0, t0: 7.4, t1: 7.9, u0: 1, u1: 0 },
  { key: "collabLaunch.relay5", lane: 2, t0: 7.75, t1: 8.2, u0: 0, u1: 1 },
  { key: "collabLaunch.relay6", lane: 1, t0: 8.1, t1: 8.45, u0: 1, u1: 0 },
  { key: "collabLaunch.relay7", lane: 0, t0: 8.35, t1: 8.65, u0: 0, u1: 1 },
  { key: "collabLaunch.relay8", lane: 2, t0: 8.55, t1: 8.85, u0: 1, u1: 0 },
  { key: "collabLaunch.relay9", lane: 0, t0: 9.5, t1: 10.2, u0: 0, u1: 0.455 },
  { key: "collabLaunch.relay9", lane: 0, t0: 9.8, t1: 10.5, u0: 1, u1: 0.545 },
  { key: "collabLaunch.relay3", lane: 0, t0: 10.6, t1: 11.2, u0: 0, u1: 0.455 },
  { key: "collabLaunch.relay10", lane: 0, t0: 10.9, t1: 11.5, u0: 1, u1: 0.545 }
];

const FIRST_RELAY_ARRIVAL = RELAYS[0]?.t1 ?? 0;
const RELAY_START_A = RELAYS.filter((relay) => relay.u0 === 0).map((relay) => relay.t0);
const RELAY_START_B = RELAYS.filter((relay) => relay.u0 === 1).map((relay) => relay.t0);

/** The original sessions of both people: where they sit, where the copy lands and when each one is written. */
const SESSIONS = [
  { from: [154, 310] as const, slot: [422, 207] as const, tIn: 1.1, speak: [138, 174] as const, tFly: 14.0, tint: TINT.A[2] },
  { from: [163, 305] as const, slot: [464, 207] as const, tIn: 1.52, speak: [186, 171] as const, tFly: 14.22, tint: TINT.A[2] },
  { from: [172, 300] as const, slot: [506, 207] as const, tIn: 1.94, speak: [140, 168] as const, tFly: 14.44, tint: TINT.A[2] },
  { from: [756, 310] as const, slot: [422, 241] as const, tIn: 3.3, tFly: 14.15, tint: TINT.B[2] },
  { from: [765, 305] as const, slot: [464, 241] as const, tIn: 3.5, tFly: 14.37, tint: TINT.B[2] },
  { from: [774, 300] as const, slot: [506, 241] as const, tIn: 3.7, tFly: 14.59, tint: TINT.B[2] }
];

/** Outline of the further super individuals that join at the end: only their outline is drawn. */
const MINIS = [
  { cx: -22, cy: 70, side: 1, curve: "M20 70C180 70 300 120 386 182", tint: "#d6e7fb" },
  { cx: -24, cy: 352, side: 1, curve: "M18 352C200 374 330 330 386 238", tint: "#ffd3db" },
  { cx: 950, cy: 70, side: -1, curve: "M908 70C748 70 628 120 542 182", tint: "#e0dffc" },
  { cx: 952, cy: 352, side: -1, curve: "M910 352C728 374 598 330 542 238", tint: "#fdf2b8" }
];

const clamp = (value: number, low = 0, high = 1) => (value < low ? low : value > high ? high : value);
const progressOf = (time: number, start: number, duration: number) => clamp((time - start) / duration);
const easeOut = (value: number) => 1 - Math.pow(1 - value, 3);
const easeInOut = (value: number) =>
  value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
const overshoot = (value: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(value - 1, 3) + c1 * Math.pow(value - 1, 2);
};
const lerp = (from: number, to: number, ratio: number) => from + (to - from) * ratio;
const fractional = (value: number) => value - Math.floor(value);
const fadeInOut = (time: number, start: number, end: number, fadeIn = 0.35, fadeOut = 0.3) =>
  easeOut(progressOf(time, start, fadeIn)) * (1 - easeOut(progressOf(time, end, fadeOut)));
const mixColor = (from: ReadonlyArray<number>, to: ReadonlyArray<number>, ratio: number) =>
  from.map((value, index) => Math.round(lerp(value, to[index] ?? value, ratio)));

/** The camera at a moment: a logarithmic zoom between keyframes, so pushing in and pulling out feel even. */
function cameraAt(time: number) {
  const first = CAMERA[0] ?? ([0, 464, 210, 1] as const);
  if (time <= first[0]) {
    return { x: first[1], y: first[2], z: first[3] };
  }
  let previous: readonly [number, number, number, number] = first;
  for (const next of CAMERA.slice(1)) {
    if (time <= next[0]) {
      const ratio = easeInOut((time - previous[0]) / (next[0] - previous[0]));
      return {
        x: lerp(previous[1], next[1], ratio),
        y: lerp(previous[2], next[2], ratio),
        z: Math.exp(lerp(Math.log(previous[3]), Math.log(next[3]), ratio))
      };
    }
    previous = next;
  }
  return {
    x: previous[1],
    y: previous[2],
    z: previous[3] * (1 + 0.025 * easeOut(progressOf(time, previous[0], 14)))
  };
}

/** A person's avatar: a silhouette on a tinted disc, the four tints the prototype uses. */
function PersonAvatar(props: { id: string; background: string; figure: string; radius: number }) {
  const clip = `collab-launch-clip-${props.id}`;
  const size = props.radius * 2;
  return (
    <svg viewBox="0 0 56 56" width={size} height={size}>
      <defs>
        <clipPath id={clip}>
          <circle cx="28" cy="28" r="28" />
        </clipPath>
      </defs>
      <circle cx="28" cy="28" r="28" fill={props.background} />
      <g clipPath={`url(#${clip})`} fill={props.figure}>
        <circle cx="28" cy="22.5" r="9.5" />
        <path d="M7 58c0-12 9.5-20.5 21-20.5S49 46 49 58z" />
      </g>
    </svg>
  );
}

/** Three dots that blink while something waits. */
function LoaderDots() {
  return (
    <span className="collab-launch-loader">
      <i />
      <i />
      <i />
    </span>
  );
}

function CheckMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 6.3l2.4 2.4 4.6-5" />
    </svg>
  );
}

/** One page of a session: three lines, the first one tinted with its owner's colour. */
function SessionPage(props: { tint?: string }) {
  return (
    <>
      <i style={props.tint ? { background: props.tint } : undefined} />
      <i />
      <i />
    </>
  );
}

export interface CollabLaunchStageProps {
  /** The scene on screen, reported only when it changes. */
  onSceneChange(index: number): void;
}

export function CollabLaunchStage(props: CollabLaunchStageProps): JSX.Element {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const onSceneChangeRef = useRef(props.onSceneChange);
  onSceneChangeRef.current = props.onSceneChange;
  /** Jumps the clock to one act: pressing its progress piece plays that act again from its first frame. */
  const seekRef = useRef<(act: number) => void>(() => undefined);

  // The stage is designed at 928×420; the card is narrower than that in small windows and in the dev preview, so the
  // whole picture is scaled down as one piece. The frame takes the scaled height so no gap is left below it.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const apply = (width: number) => {
      if (!Number.isFinite(width) || width <= 0) return;
      const next = Math.min(1, width / STAGE_WIDTH);
      setScale((current) => (Math.abs(next - current) < 0.001 ? current : next));
    };

    apply(frame.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => apply(entries[0]?.contentRect.width ?? 0));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const pick = <T extends Element = HTMLElement>(selector: string): T => {
      const found = stage.querySelector<T>(selector);
      if (!found) throw new Error(`collab launch stage is missing ${selector}`);
      return found;
    };
    const pickAll = <T extends Element = Element>(selector: string): T[] =>
      Array.from(stage.querySelectorAll<T>(selector));

    const world = pick(".collab-launch-world");
    const grid = pick(".collab-launch-grid");

    const personA = pick(".collab-launch-person--a");
    const personB = pick(".collab-launch-person--b");
    const personC = pick(".collab-launch-person--c");
    const personD = pick(".collab-launch-person--d");
    const agentA = pick(".collab-launch-agent--a");
    const agentB = pick(".collab-launch-agent--b");
    const agentC = pick(".collab-launch-agent--c");
    const agentD = pick(".collab-launch-agent--d");
    const hub = pick(".collab-launch-agent--hub");
    const haloes = {
      personA: pick(".collab-launch-halo--pa"),
      personB: pick(".collab-launch-halo--pb"),
      agentA: pick(".collab-launch-halo--aa"),
      agentB: pick(".collab-launch-halo--ab")
    };
    const tags = {
      a: pick(".collab-launch-tag--a"),
      b: pick(".collab-launch-tag--b")
    };
    const stackLabels = {
      a: pick(".collab-launch-stack-label--a"),
      b: pick(".collab-launch-stack-label--b")
    };
    const originalPages = pickAll<HTMLElement>(".collab-launch-session-page--original");
    const copiedPages = pickAll<HTMLElement>(".collab-launch-session-page--copy");
    const relayChips = pickAll<HTMLElement>(".collab-launch-relay");
    const tally = pick(".collab-launch-tally");
    const tallyNumber = pick(".collab-launch-tally__number");
    const zeroChip = pick(".collab-launch-zero");
    const idleA = pick(".collab-launch-idle--a");
    const idleB = pick(".collab-launch-idle--b");
    const heat = pick(".collab-launch-heat");
    const bubble = pick(".collab-launch-bubble");
    const readLabel = pick(".collab-launch-read-label");
    const readPages = pickAll<HTMLElement>(".collab-launch-read-page");
    const assistRequest = pick(".collab-launch-assist-request");
    const assistResult = pick(".collab-launch-assist-result");
    const auth = pick(".collab-launch-auth");
    const exec = pick(".collab-launch-exec");
    const check = pick(".collab-launch-check");
    const project = pick(".collab-launch-project");
    const nameLabels = pickAll<HTMLElement>(".collab-launch-name");
    const segments = pickAll<HTMLElement>(".collab-launch-progress__segment");

    const ringFillA = pick<SVGRectElement>(".collab-launch-ring-fill--a");
    const ringFillB = pick<SVGRectElement>(".collab-launch-ring-fill--b");
    const ringFillC = pick<SVGRectElement>(".collab-launch-ring-fill--c");
    const ringFillD = pick<SVGRectElement>(".collab-launch-ring-fill--d");
    const ringA = pick<SVGRectElement>(".collab-launch-ring--a");
    const ringB = pick<SVGRectElement>(".collab-launch-ring--b");
    const ringC = pick<SVGRectElement>(".collab-launch-ring--c");
    const ringD = pick<SVGRectElement>(".collab-launch-ring--d");
    const arc = pick<SVGPathElement>(".collab-launch-lane--0");
    const laneOne = pick<SVGPathElement>(".collab-launch-lane--1");
    const laneTwo = pick<SVGPathElement>(".collab-launch-lane--2");
    const linkA = pick<SVGPathElement>(".collab-launch-link--a");
    const linkB = pick<SVGPathElement>(".collab-launch-link--b");
    const linkC = pick<SVGPathElement>(".collab-launch-link--c");
    const linkD = pick<SVGPathElement>(".collab-launch-link--d");
    const trunkLeft = pick<SVGPathElement>(".collab-launch-trunk--left");
    const trunkRight = pick<SVGPathElement>(".collab-launch-trunk--right");
    const trunkAll = pick<SVGPathElement>(".collab-launch-trunk-all");
    const spokeC = pick<SVGPathElement>(".collab-launch-spoke--c");
    const spokeD = pick<SVGPathElement>(".collab-launch-spoke--d");
    const chipLane = pick<SVGPathElement>(".collab-launch-chip-lane");
    const comet = pickAll<SVGPathElement>(".collab-launch-comet");
    const projectRipples = pickAll<SVGRectElement>(".collab-launch-project-ripple");
    const authRing = pick<SVGCircleElement>(".collab-launch-auth-ring");
    const authRipple = pick<SVGCircleElement>(".collab-launch-auth-ripple");
    const miniCurves = pickAll<SVGPathElement>(".collab-launch-mini-curve");
    const miniRings = pickAll<SVGRectElement>(".collab-launch-mini-ring");
    const miniPeople = pickAll<SVGCircleElement>(".collab-launch-mini-who");
    const miniTiles = pickAll<SVGRectElement>(".collab-launch-mini-tile");
    const miniFlows = pickAll<SVGPathElement>(".collab-launch-mini-flow");
    const execRing = pick<SVGRectElement>(".collab-launch-progress-rect");
    const workA = pickAll<SVGPathElement>(".collab-launch-work--a");
    const workB = pickAll<SVGPathElement>(".collab-launch-work--b");
    const workC = pickAll<SVGPathElement>(".collab-launch-work--c");
    const workD = pickAll<SVGPathElement>(".collab-launch-work--d");
    const readFlow = pickAll<SVGPathElement>(".collab-launch-read-flow");
    const linkPulse = pick<SVGPathElement>(".collab-launch-link-pulse");
    const ambientLeft = pickAll<SVGPathElement>(".collab-launch-ambient--left");
    const ambientRight = pickAll<SVGPathElement>(".collab-launch-ambient--right");
    const ambientC = pickAll<SVGPathElement>(".collab-launch-ambient--c");
    const ambientD = pickAll<SVGPathElement>(".collab-launch-ambient--d");

    // Path lengths are read once. A document without layout reports 0 for every path (happy-dom in tests): lengths are
    // then treated as unavailable, strokes are drawn whole and anything that would ride a path stays hidden.
    const lengths = new WeakMap<Element, number>();
    const lengthOf = (node: Element) => {
      const cached = lengths.get(node);
      if (cached !== undefined) return cached;
      const measured = (node as SVGPathElement).getTotalLength?.() ?? 0;
      const usable = Number.isFinite(measured) && measured > 0 ? measured : 0;
      lengths.set(node, usable);
      return usable;
    };
    const pointAt = (path: SVGPathElement, ratio: number): readonly [number, number] | null => {
      const length = lengthOf(path);
      if (!length || typeof path.getPointAtLength !== "function") return null;
      const point = path.getPointAtLength(length * clamp(ratio));
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
      return [point.x, point.y];
    };

    let labelFactor = 1;

    const place = (node: HTMLElement, x: number, y: number, size = 1, opacity = 1) => {
      const scaled = node.getAttribute("data-lab") === "1" ? size * labelFactor : size;
      node.style.transform =
        `translate(${x.toFixed(2)}px,${y.toFixed(2)}px) translate(-50%,-50%) scale(${scaled.toFixed(3)})`;
      node.style.opacity = opacity.toFixed(3);
    };

    const popAt = (node: HTMLElement, at: readonly [number, number], time: number, start: number, weight = 1) => {
      const ratio = progressOf(time, start, 0.45);
      place(node, at[0], at[1], ratio <= 0 ? 0.6 : 0.6 + 0.4 * overshoot(ratio), easeOut(clamp(ratio * 1.7)) * weight);
    };

    const popInOut = (
      node: HTMLElement,
      at: readonly [number, number],
      time: number,
      start: number,
      end: number,
      weight = 1
    ) => popAt(node, at, time, start, (1 - easeOut(progressOf(time, end, 0.3))) * weight);

    const draw = (node: SVGPathElement, ratio: number) => {
      const length = lengthOf(node);
      if (!length) {
        // Without a length the stroke cannot be split into a drawn part; it is shown whole instead.
        node.style.strokeDasharray = "";
        node.style.strokeDashoffset = "";
        return;
      }
      node.style.strokeDasharray = String(length);
      node.style.strokeDashoffset = String(length * (1 - clamp(ratio)));
    };

    const travel = (
      node: HTMLElement,
      path: SVGPathElement,
      time: number,
      start: number,
      end: number,
      from: number,
      to: number,
      shrink = 0
    ) => {
      const ratio = progressOf(time, start, end - start);
      if (ratio <= 0 || ratio >= 1) {
        node.style.opacity = "0";
        return;
      }
      const point = pointAt(path, lerp(from, to, easeInOut(ratio)));
      if (!point) {
        node.style.opacity = "0";
        return;
      }
      place(
        node,
        point[0],
        point[1],
        1 - shrink * ratio * ratio,
        Math.min(1, ratio / 0.12, (1 - ratio) / (shrink ? 0.3 : 0.12))
      );
    };

    const pulse = (node: HTMLElement, at: readonly [number, number], time: number, times: ReadonlyArray<number>) => {
      let last = -1;
      for (const moment of times) if (moment <= time) last = moment;
      const ratio = last < 0 ? 1 : (time - last) / 0.75;
      if (ratio >= 1) {
        node.style.opacity = "0";
        return;
      }
      place(node, at[0], at[1], 1 + 0.5 * easeOut(ratio), 0.6 * (1 - ratio));
    };

    // A short segment riding a line: it covers [head - segment, head], cut off by the path's own ends.
    const dashAt = (node: SVGPathElement, length: number, head: number, segment: number) => {
      if (!length) {
        node.style.opacity = "0";
        return;
      }
      node.style.strokeDasharray = `${segment.toFixed(1)} ${(length + 2 * segment).toFixed(1)}`;
      node.style.strokeDashoffset = (segment - head).toFixed(2);
    };

    const flow = (
      lines: ReadonlyArray<SVGPathElement>,
      path: SVGPathElement,
      time: number,
      start: number,
      speed: number,
      visibility: number,
      oneWay = false
    ) => {
      const length = lengthOf(path);
      const segment = Math.min(14, length * 0.4);
      lines.forEach((line, index) => {
        if (!length || visibility <= 0.003) {
          line.style.opacity = "0";
          return;
        }
        const ratio = fractional((time - start) * speed + index / lines.length);
        dashAt(line, length, (!oneWay && index % 2 ? 1 - ratio : ratio) * (length + segment), segment);
        line.style.opacity = visibility.toFixed(3);
      });
    };

    const ripple = (
      node: SVGCircleElement | SVGRectElement,
      time: number,
      start: number,
      from: number,
      to: number,
      duration = 0.9
    ) => {
      const ratio = progressOf(time, start, duration);
      if (ratio <= 0 || ratio >= 1) {
        node.style.opacity = "0";
        return;
      }
      if (node.tagName.toLowerCase() === "circle") node.setAttribute("r", lerp(from, to, easeOut(ratio)).toFixed(1));
      node.style.opacity = (0.75 * (1 - ratio)).toFixed(3);
    };

    const lanes = [arc, laneOne, laneTwo] as const;

    const render = (time: number): number => {
      const camera = cameraAt(time);
      // Every relay that arrives gives the picture a small nudge.
      let kick = 0;
      for (const relay of RELAYS) {
        if (time >= relay.t1) kick = Math.max(kick, 1 - easeOut(progressOf(time, relay.t1, 0.32)));
      }
      const zoom = camera.z * (1 + 0.016 * kick * (1 - progressOf(time, TIMELINE.s3, 0.3)));
      // Labels grow slower than the picture when the camera pushes in, and shrink slower when it pulls out.
      labelFactor = Math.pow(zoom, -0.5);
      world.style.transform =
        `translate(${(464 - camera.x * zoom).toFixed(2)}px,${(210 - camera.y * zoom).toFixed(2)}px) scale(${zoom.toFixed(4)})`;
      grid.style.backgroundPosition =
        `${(8 - (camera.x - 464) * 0.35 * zoom).toFixed(1)}px ${(6 - (camera.y - 210) * 0.35 * zoom).toFixed(1)}px`;
      for (const label of nameLabels) label.style.scale = labelFactor.toFixed(3);

      // While people relay work by hand, each one's own agent and sessions are left aside.
      const dim = 1 - 0.55 * easeOut(progressOf(time, 5.0, 0.5)) + 0.55 * easeOut(progressOf(time, 12.3, 0.5));

      /* Scene 1: one person and their agent is already a super individual. */
      popAt(personA, SPOT.personA, time, 0.15);
      popAt(agentA, SPOT.agentA, time, 0.5, dim);
      popAt(personB, SPOT.personB, time, 2.7);
      popAt(agentB, SPOT.agentB, time, 2.95, dim);
      draw(linkA, easeOut(progressOf(time, 0.8, 0.4)));
      draw(linkB, easeOut(progressOf(time, 3.2, 0.4)));
      linkA.style.opacity = String(dim);
      linkB.style.opacity = String(dim);
      flow(workA, linkA, time, 0, 0.5, 0.8 * dim * progressOf(time, 1.0, 0.3));
      flow(workB, linkB, time, 0.3, 0.5, 0.8 * dim * progressOf(time, 3.6, 0.3));

      // The first super individual is circled in the opening close-up, the second one once the camera pulls back.
      const ringVisibility = 0.42 + 0.58 * (1 - easeOut(progressOf(time, TIMELINE.s2, 0.5)) + easeOut(progressOf(time, 12.6, 0.5)));
      (
        [
          { ring: ringA, fill: ringFillA, start: 2.0, tag: tags.a, x: 163, tagStart: 2.7 },
          { ring: ringB, fill: ringFillB, start: 3.4, tag: tags.b, x: 765, tagStart: 3.9 }
        ] as const
      ).forEach((item) => {
        const drawn = easeOut(progressOf(time, item.start, 0.9));
        item.ring.style.strokeDashoffset = String(1 - drawn);
        item.ring.style.opacity = drawn > 0 ? String(ringVisibility) : "0";
        item.fill.style.opacity = String(easeOut(progressOf(time, item.start + 0.4, 0.5)) * ringVisibility);
        const opacity = clamp(fadeInOut(time, item.tagStart, 4.75) + easeOut(progressOf(time, 25.7, 0.4)));
        place(item.tag, item.x, 144, 0.9 + 0.1 * opacity, opacity);
      });

      /* The original sessions: the original stays on the machine, the copy is what goes into the project. */
      SESSIONS.forEach((session, index) => {
        const original = originalPages[index];
        const copy = copiedPages[index];
        if (!original || !copy) return;
        if (index < 3) {
          // In the close-up each round of work shows up between the person and their agent, then drops into the stack.
          const speak = session.speak ?? session.from;
          const appear = progressOf(time, session.tIn, 0.3);
          const fly = easeInOut(progressOf(time, session.tIn + 0.34, 0.55));
          place(
            original,
            lerp(speak[0], session.from[0], fly),
            lerp(speak[1], session.from[1], fly) - 8 * Math.sin(Math.PI * fly),
            appear <= 0 ? 0.6 : 0.6 + 0.4 * overshoot(appear),
            easeOut(clamp(appear * 1.7)) * dim
          );
        } else {
          popAt(original, session.from, time, session.tIn, dim);
        }
        const ratio = easeInOut(progressOf(time, session.tFly, 0.85));
        place(
          copy,
          lerp(session.from[0], session.slot[0], ratio),
          lerp(session.from[1], session.slot[1], ratio) + 18 * Math.sin(Math.PI * ratio),
          1,
          progressOf(time, session.tFly, 0.1)
        );
        const highlight = index < 3 ? fadeInOut(time, 16.3 + (index % 3) * 0.3, 18.4, 0.3, 0.3) : 0;
        copy.style.boxShadow =
          highlight > 0.01
            ? `0 0 0 ${(2 * highlight).toFixed(2)}px rgba(92,191,174,${(0.95 * highlight).toFixed(2)}), 0 2px 6px rgba(19,74,78,.09)`
            : "";
      });
      place(stackLabels.a, SPOT.stackA[0], 336, 1, easeOut(progressOf(time, 1.9, 0.4)) * (0.45 + 0.55 * dim));
      place(stackLabels.b, SPOT.stackB[0], 336, 1, easeOut(progressOf(time, 3.4, 0.4)) * (0.45 + 0.55 * dim));

      /* Scene 2: work relayed by hand, faster and denser each time. */
      lanes[0].style.opacity = String(fadeInOut(time, 5.0, TIMELINE.s3, 0.5, 0.4));
      lanes[1].style.opacity = String(fadeInOut(time, 6.75, TIMELINE.s2b, 0.3, 0.4));
      lanes[2].style.opacity = String(fadeInOut(time, 7.65, TIMELINE.s2b, 0.3, 0.4));
      lanes.forEach((lane, index) => {
        lane.style.strokeDashoffset = String((index % 2 ? 1 : -1) * time * 14);
      });
      RELAYS.forEach((relay, index) => {
        const chip = relayChips[index];
        const lane = lanes[relay.lane];
        if (!chip || !lane) return;
        travel(chip, lane, time, relay.t0, relay.t1, relay.u0, relay.u1, relay.u1 > 0 && relay.u1 < 1 ? 0.55 : 0);
      });

      let relays = 0;
      let lastArrival = -9;
      let warmth = 0;
      for (const relay of RELAYS) {
        if (time >= relay.t1) {
          relays += 1;
          lastArrival = Math.max(lastArrival, relay.t1);
        }
        warmth += easeOut(progressOf(time, relay.t1, 0.35));
      }
      warmth /= RELAYS.length;
      // Memmy arrives: the count falls back to zero and turns green, then shrinks above the project.
      const cool = easeInOut(progressOf(time, TIMELINE.s3 + 0.1, 0.65));
      tallyNumber.textContent = String(Math.round(relays * (1 - cool)));
      tally.style.color = `rgb(${mixColor(
        mixColor(mixColor(EMBER_RGB, HOT_RGB, warmth), GRAY_RGB, cool),
        MINT_RGB,
        easeOut(progressOf(time, TIMELINE.s3 + 0.62, 0.3))
      )})`;
      tallyNumber.style.transform = `scale(${(1 + 0.24 * (1 - easeOut(progressOf(time, lastArrival, 0.38)))).toFixed(3)})`;
      const tallyIn = progressOf(time, FIRST_RELAY_ARRIVAL - 0.05, 0.4);
      const dock = easeInOut(progressOf(time, 13.05, 0.4));
      place(
        tally,
        464,
        lerp(214, 106, dock),
        (tallyIn <= 0 ? 0.8 : 0.8 + 0.2 * overshoot(tallyIn)) * lerp(1, 0.4, dock),
        easeOut(clamp(tallyIn * 1.7)) * (1 - easeOut(progressOf(time, 13.2, 0.25)))
      );
      heat.style.opacity = (warmth * (1 - easeOut(progressOf(time, TIMELINE.s3 + 0.1, 0.6)))).toFixed(3);
      popInOut(zeroChip, [464, 106], time, 13.35, 18.5);
      const waiting = fadeInOut(time, 5.7, TIMELINE.s3, 0.4, 0.3);
      place(idleA, SPOT.agentA[0], 166, 1, waiting);
      place(idleB, SPOT.agentB[0], 166, 1, waiting);
      popInOut(hub, SPOT.apex, time, 9.1, TIMELINE.s3);
      pulse(haloes.personA, SPOT.personA, time, RELAY_START_A);
      pulse(haloes.personB, SPOT.personB, time, RELAY_START_B);

      /* Scene 3: work between the agents, through one project. */
      popAt(project, SPOT.project, time, 13.45);
      projectRipples.forEach((node, index) => {
        const ratio = progressOf(time, 13.45 + index * 0.18, 1.0);
        if (ratio <= 0 || ratio >= 1) {
          node.style.opacity = "0";
          return;
        }
        const spread = 64 * easeOut(ratio);
        node.setAttribute("x", (386 - spread).toFixed(1));
        node.setAttribute("y", (152 - spread).toFixed(1));
        node.setAttribute("width", (156 + 2 * spread).toFixed(1));
        node.setAttribute("height", (116 + 2 * spread).toFixed(1));
        node.setAttribute("rx", (18 + spread).toFixed(1));
        node.style.opacity = (0.7 * (1 - ratio)).toFixed(3);
      });
      draw(trunkLeft, easeOut(progressOf(time, 13.7, 0.5)));
      draw(trunkRight, easeOut(progressOf(time, 13.7, 0.5)));
      popInOut(bubble, [836, 119], time, 15.5, 18.4);
      popInOut(readLabel, [599, 187], time, 16.3, 18.4);
      flow(readFlow, trunkRight, time, 16.3, 0.9, fadeInOut(time, 16.3, 18.3, 0.2, 0.3), true);
      readPages.forEach((node, index) => {
        const ratio = progressOf(time, 16.45 + index * 0.38, 0.7);
        if (ratio <= 0 || ratio >= 1) {
          node.style.opacity = "0";
          return;
        }
        const eased = easeInOut(ratio);
        place(
          node,
          lerp(422 + index * 42, SPOT.agentB[0], eased),
          lerp(207, SPOT.agentB[1], eased) + 12 * Math.sin(Math.PI * eased),
          lerp(1, 0.5, eased),
          Math.min(1, ratio / 0.12, (1 - ratio) / 0.22)
        );
      });
      {
        // One exchange inside scene 3: the person asks, then authorizes, then confirms.
        const exchange = (
          [
            [15.9, 16.3, 1, 0],
            [20.4, 20.75, 0, 1],
            [21.4, 21.75, 1, 0]
          ] as const
        ).find((window) => time > window[0] && time < window[1]);
        const length = lengthOf(linkB);
        if (exchange && length) {
          const ratio = progressOf(time, exchange[0], exchange[1] - exchange[0]);
          dashAt(
            linkPulse,
            length,
            lerp(exchange[2], exchange[3], easeInOut(ratio)) * (length + 16),
            16
          );
          linkPulse.style.opacity = Math.min(1, ratio / 0.1, (1 - ratio) / 0.1).toFixed(3);
        } else {
          linkPulse.style.opacity = "0";
        }
      }

      /* Scene 4: a member's computer, lent through the project. */
      travel(assistRequest, chipLane, time, 19.1, 20.5, 0, 1);
      {
        // The light trail over the project: the tail follows on the way out, leads on the way back.
        const window = time < 22 ? ([19.1, 20.5, 1] as const) : ([23.0, 24.4, -1] as const);
        const ratio = progressOf(time, window[0], window[1] - window[0]);
        const length = lengthOf(trunkAll);
        const running = ratio > 0 && ratio < 1 && length > 0;
        const eased = easeInOut(ratio);
        const head = window[2] > 0 ? eased * (length + 20) : length - eased * (length + 20);
        comet.forEach((node) => {
          const segment = Number(node.getAttribute("data-segment") ?? 0);
          const strength = Number(node.getAttribute("data-strength") ?? 0);
          if (!running) {
            node.style.opacity = "0";
            return;
          }
          dashAt(node, length, window[2] > 0 ? head : head + segment, segment);
          node.style.opacity = (strength * Math.min(1, ratio / 0.08, (1 - ratio) / 0.08)).toFixed(3);
        });
      }
      popInOut(auth, [836, 121], time, 20.6, 24.3);
      auth.classList.toggle("collab-launch-auth--ok", time >= 21.4);
      {
        // The ring around the other member's avatar turns while approval is pending, then closes and spreads once.
        const approved = time >= 21.4;
        authRing.style.opacity = Math.max(
          fadeInOut(time, 20.65, 21.4, 0.2, 0.1),
          fadeInOut(time, 21.4, 24.3, 0.12, 0.35)
        ).toFixed(3);
        authRing.style.stroke = approved ? "var(--color-action-sky-hover)" : "var(--color-icon-ember)";
        authRing.style.strokeDasharray = approved ? "1 0" : ".16 .09";
        authRing.style.strokeDashoffset = approved ? "0" : (-time * 0.5).toFixed(3);
        ripple(authRipple, time, 21.4, 33, 58, 0.8);
      }
      popInOut(exec, [696, 121], time, 21.75, 23.1);
      execRing.style.strokeDashoffset = String(1 - progressOf(time, 21.75, 1.3));
      execRing.style.opacity = fadeInOut(time, 21.75, 23.1, 0.15, 0.3).toFixed(3);
      travel(assistResult, chipLane, time, 23.0, 24.4, 1, 0);
      popInOut(check, [258, 184], time, 24.4, 25.5);
      pulse(haloes.agentA, SPOT.agentA, time, [19.0, 24.4]);
      pulse(haloes.agentB, SPOT.agentB, time, [17.15, 17.53, 17.91, 20.5, 23.0]);

      /* Scene 5: more super individuals join; the picture closes on the outlines around the project. */
      popAt(personC, SPOT.personC, time, 25.6);
      popAt(agentC, SPOT.agentC, time, 25.8);
      popAt(personD, SPOT.personD, time, 25.8);
      popAt(agentD, SPOT.agentD, time, 26.0);
      draw(linkC, easeOut(progressOf(time, 26.0, 0.3)));
      draw(linkD, easeOut(progressOf(time, 26.2, 0.3)));
      const ringCProgress = easeOut(progressOf(time, 26.0, 0.7));
      const ringDProgress = easeOut(progressOf(time, 26.2, 0.7));
      ringC.style.strokeDashoffset = String(1 - ringCProgress);
      ringC.style.opacity = ringCProgress > 0 ? "1" : "0";
      ringFillC.style.opacity = String(easeOut(progressOf(time, 26.3, 0.5)));
      ringD.style.strokeDashoffset = String(1 - ringDProgress);
      ringD.style.opacity = ringDProgress > 0 ? "1" : "0";
      ringFillD.style.opacity = String(easeOut(progressOf(time, 26.5, 0.5)));
      draw(spokeC, easeOut(progressOf(time, 26.3, 0.4)));
      draw(spokeD, easeOut(progressOf(time, 26.5, 0.4)));
      flow(workC, linkC, time, 0.1, 0.7, 0.8 * progressOf(time, 26.4, 0.3));
      flow(workD, linkD, time, 0.5, 0.7, 0.8 * progressOf(time, 26.6, 0.3));

      // Once the sessions are in, work keeps moving along the lines.
      const busy = Math.max(fadeInOut(time, 19.0, 20.6, 0.2, 0.3), fadeInOut(time, 22.9, 24.5, 0.2, 0.3));
      const ambient = easeOut(progressOf(time, 15.3, 0.6)) * (1 - busy);
      const ambientEnd = easeOut(progressOf(time, 26.8, 0.6));
      flow(ambientLeft, trunkLeft, time, 0, 0.42, ambient);
      flow(ambientRight, trunkRight, time, 0.35, 0.42, ambient * (1 - fadeInOut(time, 16.2, 18.4, 0.2, 0.3)));
      flow(ambientC, spokeC, time, 0.2, 0.6, ambientEnd);
      flow(ambientD, spokeD, time, 0.6, 0.6, ambientEnd);
      MINIS.forEach((_, index) => {
        const appearing = easeOut(progressOf(time, 26.1 + index * 0.14, 0.7));
        const connecting = easeOut(progressOf(time, 26.4 + index * 0.14, 0.8));
        const ring = miniRings[index];
        const curve = miniCurves[index];
        const flowLine = miniFlows[index];
        if (ring) {
          ring.style.strokeDashoffset = String(1 - appearing);
          ring.style.opacity = appearing > 0 ? "0.7" : "0";
        }
        const person = miniPeople[index];
        if (person) person.style.opacity = appearing.toFixed(3);
        const tile = miniTiles[index];
        if (tile) tile.style.opacity = appearing.toFixed(3);
        if (curve) {
          draw(curve, connecting);
          curve.style.opacity = connecting > 0 ? "0.5" : "0";
          flow(
            flowLine ? [flowLine] : [],
            curve,
            time,
            index * 0.23,
            0.3,
            easeOut(progressOf(time, 27.3 + index * 0.14, 0.6)),
            true
          );
        }
      });

      /* Progress: pure indication, filled as the animation runs. */
      segments.forEach((segment, index) => {
        const start = SCENE_STARTS[index] ?? 0;
        const end = SCENE_STARTS[index + 1] ?? start;
        segment.style.setProperty("--p", clamp(end > start ? (time - start) / (end - start) : 1).toFixed(3));
      });

      let scene = 0;
      CAPTION_STARTS.forEach((start, index) => {
        if (time >= start) scene = index;
      });
      return scene;
    };

    let time = 0;
    let last = 0;
    let frameId: number | null = null;
    let playing = true;
    let painted = false;
    let lastScene = -1;

    const paint = (value: number) => {
      const scene = render(value);
      if (!painted) {
        painted = true;
        world.style.opacity = "1";
      }
      if (scene !== lastScene) {
        lastScene = scene;
        onSceneChangeRef.current(scene);
      }
    };

    const step = (now: number) => {
      const elapsed = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (playing) {
        time += elapsed;
        paint(time);
      }
      frameId = requestAnimationFrame(step);
    };

    const stop = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
    };

    const play = (from: number) => {
      time = from;
      playing = true;
      paint(time);
      last = performance.now();
      stop();
      frameId = requestAnimationFrame(step);
    };

    seekRef.current = (act: number) => play(SCENE_STARTS[act] ?? 0);

    // A visitor who asked for less motion lands on the closing frame; pressing a piece is still theirs to do.
    const reduceMotion =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    time = reduceMotion ? TIMELINE.done + 2 : 0;
    playing = !reduceMotion;
    paint(time);

    if (playing) {
      last = performance.now();
      frameId = requestAnimationFrame(step);
    }

    // Returning to a hidden window must not hand the loop one huge frame: the clock is re-aligned on the way back.
    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      last = performance.now();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisible);
      seekRef.current = () => undefined;
    };
  }, []);

  const codexLogo = agentSourceLogoUrl("codex");
  const claudeLogo = agentSourceLogoUrl("claude_code");
  const cursorLogo = agentSourceLogoUrl("cursor");
  const openclawLogo = agentSourceLogoUrl("openclaw");

  return (
    <div
      className="collab-launch-stage-frame"
      ref={frameRef}
      style={{ height: STAGE_HEIGHT * scale }}
    >
      <div
        className="collab-launch-stage"
        ref={stageRef}
        style={{ "--collab-launch-stage-scale": scale } as CSSProperties}
      >
        <div className="collab-launch-heat" aria-hidden="true" />
        <div className="collab-launch-grid" aria-hidden="true" />
        <div className="collab-launch-world" aria-hidden="true">
          <svg className="collab-launch-wires" viewBox="0 0 928 420" aria-hidden="true">
            {/* The two circles, drawn before anything inside them. */}
            <rect className="collab-launch-ring-fill collab-launch-ring-fill--a" x={34} y={144} width={258} height={132} rx={66} pathLength={1} />
            <rect className="collab-launch-ring-fill collab-launch-ring-fill--b" x={636} y={144} width={258} height={132} rx={66} pathLength={1} />
            <rect className="collab-launch-ring-fill collab-launch-ring-fill--c" x={424} y={8} width={80} height={126} rx={40} pathLength={1} />
            <rect className="collab-launch-ring-fill collab-launch-ring-fill--d" x={424} y={286} width={80} height={126} rx={40} pathLength={1} />
            <rect className="collab-launch-ring collab-launch-ring--a" x={34} y={144} width={258} height={132} rx={66} pathLength={1} />
            <rect className="collab-launch-ring collab-launch-ring--b" x={636} y={144} width={258} height={132} rx={66} pathLength={1} />
            <rect className="collab-launch-ring collab-launch-ring--c" x={424} y={8} width={80} height={126} rx={40} pathLength={1} />
            <rect className="collab-launch-ring collab-launch-ring--d" x={424} y={286} width={80} height={126} rx={40} pathLength={1} />

            {/* Hand relays: one arc, and two more lanes once relaying speeds up. */}
            <path className="collab-launch-lane collab-launch-lane--0" d="M92 178C92 37 836 37 836 178" />
            <path className="collab-launch-lane collab-launch-lane--1" d="M92 178C92 -8 836 -8 836 178" />
            <path className="collab-launch-lane collab-launch-lane--2" d="M92 178C92 82 836 82 836 178" />

            <path className="collab-launch-link collab-launch-link--a" d="M118 210H204" />
            <path className="collab-launch-link collab-launch-link--b" d="M724 210H810" />
            <path className="collab-launch-link collab-launch-link--c" d="M464 58V77" />
            <path className="collab-launch-link collab-launch-link--d" d="M464 343V362" />

            <path className="collab-launch-trunk collab-launch-trunk--left" d="M260 210H386" />
            <path className="collab-launch-trunk collab-launch-trunk--right" d="M542 210H668" />
            <path className="collab-launch-trunk collab-launch-spoke collab-launch-spoke--c" d="M464 123V152" />
            <path className="collab-launch-trunk collab-launch-spoke collab-launch-spoke--d" d="M464 268V297" />

            {/* Empty paths that only carry the moving pieces. */}
            <path className="collab-launch-trunk-all" d="M262 210H666" />
            <path className="collab-launch-chip-lane" d="M262 190H666" />
            <path
              className="collab-launch-comet collab-launch-flow collab-launch-flow--mint"
              d="M262 210H666"
              data-segment={110}
              data-strength={0.22}
              style={{ strokeWidth: 2 }}
            />
            <path
              className="collab-launch-comet collab-launch-flow collab-launch-flow--mint"
              d="M262 210H666"
              data-segment={60}
              data-strength={0.5}
              style={{ strokeWidth: 3 }}
            />
            <path
              className="collab-launch-comet collab-launch-flow collab-launch-flow--mint"
              d="M262 210H666"
              data-segment={22}
              data-strength={1}
              style={{ strokeWidth: 4 }}
            />

            <rect className="collab-launch-project-ripple" x={386} y={152} width={156} height={116} rx={18} pathLength={1} />
            <rect className="collab-launch-project-ripple" x={386} y={152} width={156} height={116} rx={18} pathLength={1} />

            <circle className="collab-launch-auth-ring" cx={836} cy={210} r={33} pathLength={1} />
            <circle className="collab-launch-auth-ripple" cx={836} cy={210} r={33} pathLength={1} />

            {MINIS.map((mini, index) => (
              <g key={index}>
                <path className="collab-launch-mini-curve" d={mini.curve} />
                <rect
                  className="collab-launch-ring collab-launch-mini-ring"
                  x={mini.cx - 42}
                  y={mini.cy - 24}
                  width={84}
                  height={48}
                  rx={24}
                  pathLength={1}
                />
                <circle
                  className="collab-launch-mini-who"
                  cx={mini.cx - mini.side * 16}
                  cy={mini.cy}
                  r={9}
                  style={{ fill: mini.tint }}
                />
                <rect
                  className="collab-launch-mini-tile"
                  x={mini.cx + mini.side * 16 - 8}
                  y={mini.cy - 8}
                  width={16}
                  height={16}
                  rx={5}
                  fill="#fff"
                />
                <path className="collab-launch-mini-flow collab-launch-flow collab-launch-flow--mint" d={mini.curve} />
              </g>
            ))}

            <rect className="collab-launch-progress-rect" x={665} y={179} width={62} height={62} rx={19} pathLength={1} />

            <path className="collab-launch-flow collab-launch-work--a" d="M118 210H204" />
            <path className="collab-launch-flow collab-launch-work--a" d="M118 210H204" />
            <path className="collab-launch-flow collab-launch-work--b" d="M724 210H810" />
            <path className="collab-launch-flow collab-launch-work--b" d="M724 210H810" />
            <path className="collab-launch-flow collab-launch-work--c" d="M464 58V77" />
            <path className="collab-launch-flow collab-launch-work--c" d="M464 58V77" />
            <path className="collab-launch-flow collab-launch-work--d" d="M464 343V362" />
            <path className="collab-launch-flow collab-launch-work--d" d="M464 343V362" />

            <path className="collab-launch-flow collab-launch-flow--mint collab-launch-read-flow" d="M542 210H668" />
            <path className="collab-launch-flow collab-launch-flow--mint collab-launch-read-flow" d="M542 210H668" />
            <path className="collab-launch-flow collab-launch-flow--mint collab-launch-link-pulse" d="M724 210H810" />

            <path className="collab-launch-flow collab-launch-flow--mint collab-launch-ambient--left" d="M260 210H386" />
            <path className="collab-launch-flow collab-launch-flow--mint collab-launch-ambient--left" d="M260 210H386" />
            <path className="collab-launch-flow collab-launch-flow--mint collab-launch-ambient--right" d="M542 210H668" />
            <path className="collab-launch-flow collab-launch-flow--mint collab-launch-ambient--right" d="M542 210H668" />
            <path className="collab-launch-flow collab-launch-flow--mint collab-launch-ambient--c" d="M464 123V152" />
            <path className="collab-launch-flow collab-launch-flow--mint collab-launch-ambient--c" d="M464 123V152" />
            <path className="collab-launch-flow collab-launch-flow--mint collab-launch-ambient--d" d="M464 268V297" />
            <path className="collab-launch-flow collab-launch-flow--mint collab-launch-ambient--d" d="M464 268V297" />
          </svg>

          {/* Circles around whoever is busy. */}
          <div className="collab-launch-node collab-launch-halo collab-launch-halo--pa" />
          <div className="collab-launch-node collab-launch-halo collab-launch-halo--pb" />
          <div className="collab-launch-node collab-launch-halo collab-launch-halo--sq collab-launch-halo--aa" />
          <div className="collab-launch-node collab-launch-halo collab-launch-halo--sq collab-launch-halo--ab" />

          <div className="collab-launch-node collab-launch-person collab-launch-person--a">
            <PersonAvatar id="a" background={TINT.A[0]} figure={TINT.A[1]} radius={26} />
          </div>
          <div className="collab-launch-node collab-launch-person collab-launch-person--b">
            <PersonAvatar id="b" background={TINT.B[0]} figure={TINT.B[1]} radius={26} />
          </div>
          <div className="collab-launch-node collab-launch-agent collab-launch-agent--a">
            <div className="collab-launch-tile">
              {codexLogo ? <img src={codexLogo} alt="" /> : null}
            </div>
            <span className="collab-launch-name">Codex</span>
          </div>
          <div className="collab-launch-node collab-launch-agent collab-launch-agent--b">
            <div className="collab-launch-tile">
              {claudeLogo ? <img src={claudeLogo} alt="" /> : null}
            </div>
            <span className="collab-launch-name">Claude Code</span>
          </div>
          <div className="collab-launch-node collab-launch-person collab-launch-person--c">
            <PersonAvatar id="c" background={TINT.C[0]} figure={TINT.C[1]} radius={20} />
          </div>
          <div className="collab-launch-node collab-launch-person collab-launch-person--d">
            <PersonAvatar id="d" background={TINT.D[0]} figure={TINT.D[1]} radius={20} />
          </div>
          <div className="collab-launch-node collab-launch-agent collab-launch-agent--small collab-launch-agent--c">
            <div className="collab-launch-tile">
              {cursorLogo ? <img src={cursorLogo} alt="" /> : null}
            </div>
          </div>
          <div className="collab-launch-node collab-launch-agent collab-launch-agent--small collab-launch-agent--d">
            <div className="collab-launch-tile">
              {openclawLogo ? <img src={openclawLogo} alt="" /> : null}
            </div>
          </div>
          <div className="collab-launch-node collab-launch-agent collab-launch-agent--hub">
            <div className="collab-launch-tile">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="#93a3a0">
                <path d="M12 2c.8 5.6 4.4 9.2 10 10-5.6.8-9.2 4.4-10 10-.8-5.6-4.4-9.2-10-10 5.6-.8 9.2-4.4 10-10z" />
              </svg>
            </div>
            <span className="collab-launch-name">{t("collabLaunch.labelSharedAgent")}</span>
          </div>

          <div className="collab-launch-node collab-launch-tag collab-launch-tag--a" data-lab="1">
            {t("collabLaunch.tagSuperIndividual")}
          </div>
          <div className="collab-launch-node collab-launch-tag collab-launch-tag--b" data-lab="1">
            {t("collabLaunch.tagSuperIndividual")}
          </div>

          <div className="collab-launch-node collab-launch-project">
            <div className="collab-launch-project__head">
              <img src={memmyAppIconUrl} alt="" />
              {t("collabLaunch.labelProject")}
            </div>
            <div className="collab-launch-project__slots">
              <s />
              <s />
              <s />
              <s />
              <s />
              <s />
            </div>
          </div>

          {SESSIONS.map((session, index) => (
            <div className="collab-launch-node collab-launch-session-page collab-launch-session-page--original" key={`o${index}`}>
              <SessionPage tint={session.tint} />
            </div>
          ))}
          {SESSIONS.map((session, index) => (
            <div className="collab-launch-node collab-launch-session-page collab-launch-session-page--copy" key={`c${index}`}>
              <SessionPage tint={session.tint} />
            </div>
          ))}

          <div className="collab-launch-node collab-launch-stack-label collab-launch-stack-label--a" data-lab="1">
            {t("collabLaunch.labelSessions")}
          </div>
          <div className="collab-launch-node collab-launch-stack-label collab-launch-stack-label--b" data-lab="1">
            {t("collabLaunch.labelSessions")}
          </div>

          {RELAYS.map((relay, index) => (
            <div className="collab-launch-node collab-launch-chip collab-launch-chip--ember collab-launch-relay" key={index} data-lab="1">
              {t(relay.key)}
            </div>
          ))}

          <div className="collab-launch-node collab-launch-tally">
            <small>{t("collabLaunch.tallyLabel")}</small>
            <div>
              <b className="collab-launch-tally__number">0</b>
              <span>{t("collabLaunch.tallyUnit")}</span>
            </div>
          </div>
          <div className="collab-launch-node collab-launch-chip collab-launch-chip--mint collab-launch-chip--count collab-launch-zero" data-lab="1">
            {t("collabLaunch.tallyZero", { count: 0 })}
          </div>
          <div className="collab-launch-node collab-launch-idle collab-launch-idle--a" data-lab="1">
            {t("collabLaunch.labelWaiting")}
            <LoaderDots />
          </div>
          <div className="collab-launch-node collab-launch-idle collab-launch-idle--b" data-lab="1">
            {t("collabLaunch.labelWaiting")}
            <LoaderDots />
          </div>

          <div className="collab-launch-node collab-launch-bubble" data-lab="1">
            {t("collabLaunch.askBubble")}
          </div>
          <div className="collab-launch-node collab-launch-chip collab-launch-chip--mint collab-launch-read-label" data-lab="1">
            {t("collabLaunch.readSessions")}
          </div>

          {[0, 1, 2].map((index) => (
            <div className="collab-launch-node collab-launch-session-page collab-launch-read-page" key={`r${index}`}>
              <SessionPage tint={TINT.A[2]} />
            </div>
          ))}

          <div className="collab-launch-node collab-launch-chip collab-launch-chip--mint collab-launch-chip--under collab-launch-assist-request" data-lab="1">
            {t("collabLaunch.assistRequest")}
          </div>
          <div className="collab-launch-node collab-launch-chip collab-launch-chip--mint collab-launch-chip--under collab-launch-assist-result" data-lab="1">
            {t("collabLaunch.assistResult")}
          </div>
          <div className="collab-launch-node collab-launch-chip collab-launch-chip--ember collab-launch-auth" data-lab="1">
            <span className="collab-launch-auth__wait">
              <i className="collab-launch-pulse" />
              {t("collabLaunch.awaitingApproval")}
            </span>
            <span className="collab-launch-auth__ok">
              <CheckMark />
              {t("collabLaunch.approved")}
            </span>
          </div>
          <div className="collab-launch-node collab-launch-chip collab-launch-chip--mint collab-launch-exec" data-lab="1">
            {t("collabLaunch.runningLocally")}
            <LoaderDots />
          </div>
          <div className="collab-launch-node collab-launch-check">
            <CheckMark />
          </div>
        </div>

        {/* 进度条可点：按一下就从那一幕的第一帧重新播，所以它不能藏在舞台的 aria-hidden 里。 */}
        <div className="collab-launch-progress" role="group" aria-label={t("collabLaunch.progress")}>
          {[0, 1, 2, 3, 4].map((index) => {
            const caption = COLLAB_LAUNCH_CAPTIONS[ACT_CAPTIONS[index] ?? index];
            const main = caption ? t(caption.main) : "";
            return (
              <button
                className="collab-launch-progress__segment"
                key={index}
                type="button"
                aria-label={t("collabLaunch.jumpToScene").replace("{scene}", String(index + 1)).replace("{caption}", main)}
                onClick={() => seekRef.current(index)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
