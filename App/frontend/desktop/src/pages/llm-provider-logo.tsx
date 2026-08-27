import anthropicLogoUrl from "../assets/llm-provider-logo/anthropic.svg";
import baiduLogoUrl from "../assets/llm-provider-logo/baidu.svg";
import deepseekLogoUrl from "../assets/llm-provider-logo/deepseek.svg";
import doubaoLogoUrl from "../assets/llm-provider-logo/doubao.svg";
import geminiLogoUrl from "../assets/llm-provider-logo/gemini.svg";
import memmyAccountLogoUrl from "../assets/llm-provider-logo/memmy-account.png";
import minimaxLogoUrl from "../assets/llm-provider-logo/minimax.svg";
import moonshotLogoUrl from "../assets/llm-provider-logo/moonshot.svg";
import openaiLogoUrl from "../assets/llm-provider-logo/openai.svg";
import qwenLogoUrl from "../assets/llm-provider-logo/qwen.svg";
import zhipuLogoUrl from "../assets/llm-provider-logo/zhipu.svg";

const LLM_PROVIDER_LOGOS: Readonly<Record<string, string>> = {
  anthropic: anthropicLogoUrl,
  baidu: baiduLogoUrl,
  deepseek: deepseekLogoUrl,
  doubao: doubaoLogoUrl,
  gemini: geminiLogoUrl,
  google: geminiLogoUrl,
  kimi: moonshotLogoUrl,
  memmy_account: memmyAccountLogoUrl,
  minimax: minimaxLogoUrl,
  moonshot: moonshotLogoUrl,
  openai: openaiLogoUrl,
  qwen: qwenLogoUrl,
  zhipu: zhipuLogoUrl
};

/** Returns the bundled logo URL for a text-model provider supported by the desktop UI. */
export function llmProviderLogoUrl(provider: string): string | null {
  return LLM_PROVIDER_LOGOS[provider.trim().toLowerCase()] ?? null;
}

/** Renders a decorative text-model provider logo when the desktop UI supports it. */
export function LlmProviderLogo(props: { provider: string }) {
  const provider = props.provider.trim().toLowerCase();
  const logoUrl = llmProviderLogoUrl(provider);
  return logoUrl ? <img className="llm-provider-logo" data-provider={provider} src={logoUrl} alt="" aria-hidden="true" /> : null;
}
