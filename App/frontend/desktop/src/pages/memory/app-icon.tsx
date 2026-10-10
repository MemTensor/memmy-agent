import { useEffect, useState } from "react";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";

export interface AppIconProps {
  bundleId: string;
  client: MemmyAgentClient | null;
}

// Icons are per bundle id and never change while the app runs, so one shared
// cache keeps a feed of many entries from asking for the same icon repeatedly.
const cache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

function load(client: MemmyAgentClient, bundleId: string): Promise<string | null> {
  const existing = inFlight.get(bundleId);
  if (existing) return existing;
  const request = client.getApplicationIcon(bundleId)
    .then((icon) => {
      cache.set(bundleId, icon);
      return icon;
    })
    .catch(() => {
      cache.set(bundleId, null);
      return null;
    })
    .finally(() => {
      inFlight.delete(bundleId);
    });
  inFlight.set(bundleId, request);
  return request;
}

/** The last recognizable word of a bundle id, e.g. `com.apple.Notes` → `No`. */
function initials(bundleId: string): string {
  const parts = bundleId.split(".").filter(Boolean);
  const name = parts.at(-1) ?? bundleId;
  return name.slice(0, 2).toUpperCase();
}

/** A stable hue per bundle id, so the placeholder is at least recognizable. */
function hue(bundleId: string): number {
  let total = 0;
  for (const character of bundleId) total = (total * 31 + character.charCodeAt(0)) % 360;
  return total;
}

/**
 * An application's real icon, falling back to a lettered chip.
 *
 * The fallback matters: an icon can be missing because the app was uninstalled,
 * because this is not macOS, or because the lookup simply failed, and in all
 * three the row should still say which applications the window involved.
 */
export function AppIcon(props: AppIconProps) {
  const [icon, setIcon] = useState<string | null>(() => cache.get(props.bundleId) ?? null);

  useEffect(() => {
    const client = props.client;
    if (!client || cache.has(props.bundleId)) {
      setIcon(cache.get(props.bundleId) ?? null);
      return;
    }
    let live = true;
    void load(client, props.bundleId).then((loaded) => {
      if (live) setIcon(loaded);
    });
    return () => {
      live = false;
    };
  }, [props.bundleId, props.client]);

  if (icon) {
    return <img className="ch-app-icon" src={icon} alt={props.bundleId} title={props.bundleId} />;
  }
  return (
    <span
      className="ch-app-icon ch-app-icon--fallback"
      title={props.bundleId}
      aria-label={props.bundleId}
      style={{ backgroundColor: `hsl(${hue(props.bundleId)} 42% 88%)`, color: `hsl(${hue(props.bundleId)} 45% 32%)` }}
    >
      {initials(props.bundleId)}
    </span>
  );
}
