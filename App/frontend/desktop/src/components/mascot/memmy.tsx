/** Memmy module. */
import { useEffect, useState } from "react";
import memmyBlushUrl from "../../assets/mascot/memmy-blush.png";
import memmyBoxUrl from "../../assets/mascot/memmy-box.png";
import memmyBrainUrl from "../../assets/mascot/memmy-brain.png";
import memmyCelebrateUrl from "../../assets/mascot/memmy-celebrate.png";
import memmyChatUrl from "../../assets/mascot/memmy-chat.png";
import memmyConnectUrl from "../../assets/mascot/memmy-connect.png";
import memmyHumUrl from "../../assets/mascot/memmy-hum.png";
import memmyPeekUrl from "../../assets/mascot/memmy-peek.png";
import memmyPleadUrl from "../../assets/mascot/memmy-plead.png";
import memmyPointUrl from "../../assets/mascot/memmy-point.png";
import memmyReadUrl from "../../assets/mascot/memmy-read.png";
import memmyRiceUrl from "../../assets/mascot/memmy-rice.png";
import memmySadUrl from "../../assets/mascot/memmy-sad.png";
import memmyShieldUrl from "../../assets/mascot/memmy-shield.png";
import memmySleepUrl from "../../assets/mascot/memmy-sleep.png";
import memmyThinkUrl from "../../assets/mascot/memmy-think.png";
import memmyWaveUrl from "../../assets/mascot/memmy-wave.png";
import memmyWorkUrl from "../../assets/mascot/memmy-work.png";
import memmyWrenchUrl from "../../assets/mascot/memmy-wrench.png";

export type MemmyPose =
  | "wave"
  | "think"
  | "work"
  | "celebrate"
  | "shield"
  | "read"
  | "connect"
  | "sleep"
  | "neutral"
  | "point"
  | "box"
  | "brain"
  | "chat"
  | "wrench"
  | "blush"
  | "peek"
  | "hum"
  | "plead"
  | "sad";

export interface MemmyProps {
  pose?: MemmyPose;
  size?: number;
  className?: string;
}

export interface MemmyAssetPreloadOptions {
  createImage?: () => HTMLImageElement;
}

const poseToAsset: Record<MemmyPose, string> = {
  neutral: memmyRiceUrl,
  wave: memmyWaveUrl,
  think: memmyThinkUrl,
  work: memmyWorkUrl,
  celebrate: memmyCelebrateUrl,
  shield: memmyShieldUrl,
  read: memmyReadUrl,
  connect: memmyConnectUrl,
  sleep: memmySleepUrl,
  point: memmyPointUrl,
  box: memmyBoxUrl,
  brain: memmyBrainUrl,
  chat: memmyChatUrl,
  wrench: memmyWrenchUrl,
  blush: memmyBlushUrl,
  peek: memmyPeekUrl,
  hum: memmyHumUrl,
  plead: memmyPleadUrl,
  sad: memmySadUrl
};

export function preloadMemmyAsset(src: string, options: MemmyAssetPreloadOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = options.createImage?.() ?? new Image();

    image.onload = () => resolve(src);
    image.onerror = () => reject(new Error(`Failed to preload Memmy asset: ${src}`));
    image.src = src;
  });
}

/**
 * Render the Memmy artwork and preload the target image before switching poses.
 *
 * @param props the Memmy display props.
 * @returns an img element.
 */
export function Memmy({ pose = "neutral", size = 100, className = "" }: MemmyProps) {
  const target = poseToAsset[pose] ?? memmyRiceUrl;
  const [src, setSrc] = useState(target);

  useEffect(() => {
    if (target === src) {
      return;
    }

    let disposed = false;
    void preloadMemmyAsset(target)
      .then((loadedSrc) => {
        if (!disposed) {
          setSrc(loadedSrc);
        }
      })
      .catch((error) => {
        console.warn("preload Memmy asset failed", error);
      });

    return () => {
      disposed = true;
    };
  }, [target, src]);

  return (
    <img
      src={src}
      alt="Memmy"
      className={className}
      draggable={false}
      onError={() => {
        if (src !== memmyRiceUrl) {
          setSrc(memmyRiceUrl);
        }
      }}
      style={{
        width: size,
        height: "auto",
        userSelect: "none",
        display: "inline-block"
      }}
    />
  );
}
