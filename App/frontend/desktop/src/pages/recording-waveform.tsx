/**
 * Bar count and silhouette for the idle illustration.
 *
 * 28 bars at 2px with a 3px gap is 137px, which fits the narrowest place the
 * wave appears (the interview bar caps it at 180px). The 40 × 1.5px row this
 * replaces needed 197px there, so its edge bars were clipped mid-width — and a
 * half-pixel bar rounds to 1px or 2px depending on where it lands on the pixel
 * grid, which is why the row read as bars of different thicknesses.
 */
export const WAVE_BARS = 28;

const IDLE_LEVELS = [
  .12, .18, .3, .18, .42, .6, .36, .24, .54, .78,
  .48, .3, .66, .9, .54, .36, .72, .48, .24, .6,
  .78, .42, .3, .54, .36, .18, .3, .12
];

/** Idle is a static illustration; recording and pause retain actual mic levels. */
export function RecordingWaveform(props: { levels: number[]; active: boolean; idle: boolean }) {
  const samples = props.levels.slice(-WAVE_BARS);
  const levels = props.idle ? IDLE_LEVELS : [...Array<number>(WAVE_BARS - samples.length).fill(0), ...samples];
  return <div className={`recording-waveform${props.active ? " recording-waveform--active" : ""}${props.idle ? " recording-waveform--idle" : ""}`} aria-hidden="true">
    {levels.map((level, index) => <span key={index} className="recording-waveform__bar"
      // The negative delay starts each bar partway through the pulse, so the
      // wave reads as travelling rather than every bar breathing together.
      style={{ height: `${Math.round(8 + Math.min(1, Math.max(0, level)) * 92)}%`, animationDelay: `${-index * 85}ms` }} />)}
  </div>;
}
