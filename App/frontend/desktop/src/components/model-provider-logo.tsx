import memmyCoverLogoUrl from "../assets/brand/memmy-cover.png";
import anthropicLogoUrl from "../assets/model-logos/anthropic.svg";
import baiduLogoUrl from "../assets/model-logos/baidu.svg";
import deepseekLogoUrl from "../assets/model-logos/deepseek.svg";
import doubaoLogoUrl from "../assets/model-logos/doubao.svg";
import geminiLogoUrl from "../assets/model-logos/gemini.svg";
import minimaxLogoUrl from "../assets/model-logos/minimax.svg";
import moonshotLogoUrl from "../assets/model-logos/moonshot.svg";
import openaiLogoUrl from "../assets/model-logos/openai.svg";
import qwenLogoUrl from "../assets/model-logos/qwen.svg";
import zhipuLogoUrl from "../assets/model-logos/zhipu.svg";
import type { Protocol } from "../pages/model-config.js";

export { memmyCoverLogoUrl };

const PROTOCOL_LOGO_URLS: Record<Protocol, string> = {
  openai: openaiLogoUrl,
  anthropic: anthropicLogoUrl,
  gemini: geminiLogoUrl,
  deepseek: deepseekLogoUrl,
  zhipu: zhipuLogoUrl,
  qwen: qwenLogoUrl,
  moonshot: moonshotLogoUrl,
  minimax: minimaxLogoUrl,
  baidu: baiduLogoUrl,
  doubao: doubaoLogoUrl
};

/** Resolve a logo URL for a protocol or free-form provider string. */
export function modelProviderLogoUrl(provider: string): string | undefined {
  const key = provider.trim().toLocaleLowerCase();
  if (!key) return undefined;
  if (
    key === "memmy"
    || key === "platform"
    || key.includes("memmy")
    || key.includes("memos")
  ) {
    return memmyCoverLogoUrl;
  }
  if (key in PROTOCOL_LOGO_URLS) {
    return PROTOCOL_LOGO_URLS[key as Protocol];
  }
  if (key.includes("anthropic") || key.includes("claude")) return PROTOCOL_LOGO_URLS.anthropic;
  if (key.includes("openai") || key.includes("gpt")) return PROTOCOL_LOGO_URLS.openai;
  if (key.includes("gemini") || key.includes("google")) return PROTOCOL_LOGO_URLS.gemini;
  if (key.includes("deepseek")) return PROTOCOL_LOGO_URLS.deepseek;
  if (key.includes("zhipu") || key.includes("glm") || key.includes("智谱")) return PROTOCOL_LOGO_URLS.zhipu;
  if (key.includes("qwen") || key.includes("tongyi") || key.includes("通义") || key.includes("dashscope")) {
    return PROTOCOL_LOGO_URLS.qwen;
  }
  if (key.includes("moonshot") || key.includes("kimi")) return PROTOCOL_LOGO_URLS.moonshot;
  if (key.includes("minimax")) return PROTOCOL_LOGO_URLS.minimax;
  if (key.includes("baidu") || key.includes("ernie") || key.includes("qianfan")) return PROTOCOL_LOGO_URLS.baidu;
  if (key.includes("doubao") || key.includes("bytedance") || key.includes("volc") || key.includes("ark")) {
    return PROTOCOL_LOGO_URLS.doubao;
  }
  return undefined;
}

export interface ModelProviderLogoProps {
  provider: string;
  className?: string;
  size?: number;
}

/** Brand mark for a model protocol / provider. */
export function ModelProviderLogo(props: ModelProviderLogoProps) {
  const size = props.size ?? 14;
  const logoUrl = modelProviderLogoUrl(props.provider);
  const className = ["model-provider-logo", props.className].filter(Boolean).join(" ");

  if (!logoUrl) {
    return (
      <span
        className={`${className} model-provider-logo--fallback`}
        style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.64)) }}
        aria-hidden="true"
      >
        {props.provider.trim().slice(0, 1).toLocaleUpperCase() || "?"}
      </span>
    );
  }

  const isCover = logoUrl === memmyCoverLogoUrl;
  return (
    <img
      src={logoUrl}
      className={`${className}${isCover ? " model-provider-logo--cover" : ""}`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
