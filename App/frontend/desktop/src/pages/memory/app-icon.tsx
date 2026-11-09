import { useEffect, useState } from "react";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";

export interface AppIconProps {
  bundleId: string;
  client: MemmyAgentClient | null;
  displayName?: string;
}

// Keep successful icons for the renderer lifetime. A missing icon may become
// available after an application install or a transient helper failure, so
// retry that answer when the icon is mounted again after a short interval.
const MISSING_RETRY_MS = 60_000;
const cache = new Map<string, { icon: string | null; expiresAt: number }>();
const inFlight = new Map<string, Promise<string | null>>();

function cachedIcon(bundleId: string): string | null | undefined {
  const entry = cache.get(bundleId);
  if (!entry) return undefined;
  if (entry.expiresAt > Date.now()) return entry.icon;
  cache.delete(bundleId);
  return undefined;
}

function load(client: MemmyAgentClient, bundleId: string): Promise<string | null> {
  const existing = inFlight.get(bundleId);
  if (existing) return existing;
  const request = client.getApplicationIcon(bundleId)
    .then((icon) => {
      cache.set(bundleId, { icon, expiresAt: icon ? Infinity : Date.now() + MISSING_RETRY_MS });
      return icon;
    })
    .catch(() => {
      cache.set(bundleId, { icon: null, expiresAt: Date.now() + MISSING_RETRY_MS });
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
 * because the platform could not resolve it, or because lookup failed, and in all
 * three the row should still say which applications the window involved.
 */
export function AppIcon(props: AppIconProps) {
  const [icon, setIcon] = useState<string | null>(() => cachedIcon(props.bundleId) ?? null);

  useEffect(() => {
    const client = props.client;
    const cached = cachedIcon(props.bundleId);
    if (!client || cached !== undefined) {
      setIcon(cached ?? null);
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
    return <img className="ch-app-icon" src={icon} alt={props.displayName ?? props.bundleId} title={props.displayName ?? props.bundleId} />;
  }
  return (
    <span
      className="ch-app-icon ch-app-icon--fallback"
      title={props.displayName ?? props.bundleId}
      aria-label={props.displayName ?? props.bundleId}
      style={{ backgroundColor: `hsl(${hue(props.bundleId)} 42% 88%)`, color: `hsl(${hue(props.bundleId)} 45% 32%)` }}
    >
      {props.displayName ? props.displayName.replace(/\.exe$/iu, "").slice(0, 2).toUpperCase() : initials(props.bundleId)}
    </span>
  );
}
