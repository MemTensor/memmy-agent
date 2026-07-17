export function MemoryStateBox(props: { message: string; tone?: "error" }) {
  return <div className={`memory-state-box${props.tone === "error" ? " memory-state-box--error" : ""}`}>{props.message}</div>;
}
