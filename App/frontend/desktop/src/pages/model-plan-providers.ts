import type { ModelEndpointProtocol, ModelPlanProviderId } from "@memmy/local-api-contracts";
import type { MessageKey } from "../i18n/messages.js";

export interface ModelPlanProviderOption {
  value: ModelPlanProviderId;
  labelKey: MessageKey;
  groupLabelKey: MessageKey;
  logoProvider: string;
  endpoint: string;
  protocol: ModelEndpointProtocol;
}

/** Subscription API endpoints with credentials isolated from their metered counterparts. */
export const MODEL_PLAN_PROVIDER_OPTIONS: readonly ModelPlanProviderOption[] = [
  {
    value: "dashscope_token_plan",
    labelKey: "settings.modelWorkspace.plan.dashscope",
    groupLabelKey: "settings.modelWorkspace.plan.tokenGroup",
    logoProvider: "dashscope",
    endpoint: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    protocol: "openai-chat-completions"
  },
  {
    value: "qianfan_token_plan_personal",
    labelKey: "settings.modelWorkspace.plan.qianfanPersonal",
    groupLabelKey: "settings.modelWorkspace.plan.tokenGroup",
    logoProvider: "qianfan",
    endpoint: "https://qianfan.baidubce.com/v2/tokenplan/personal",
    protocol: "openai-chat-completions"
  },
  {
    value: "qianfan_token_plan_team",
    labelKey: "settings.modelWorkspace.plan.qianfanTeam",
    groupLabelKey: "settings.modelWorkspace.plan.tokenGroup",
    logoProvider: "qianfan",
    endpoint: "https://qianfan.baidubce.com/v2/tokenplan/team",
    protocol: "openai-chat-completions"
  },
  {
    value: "minimax_token_plan",
    labelKey: "settings.modelWorkspace.plan.minimax",
    groupLabelKey: "settings.modelWorkspace.plan.tokenGroup",
    logoProvider: "minimax",
    endpoint: "https://api.minimax.cn/anthropic",
    protocol: "anthropic-messages"
  },
  {
    value: "xiaomi_mimo_token_plan",
    labelKey: "settings.modelWorkspace.plan.xiaomi",
    groupLabelKey: "settings.modelWorkspace.plan.tokenGroup",
    logoProvider: "xiaomi_mimo",
    endpoint: "https://token-plan-cn.xiaomimimo.com/v1",
    protocol: "openai-chat-completions"
  },
  {
    value: "dashscope_coding_plan",
    labelKey: "settings.modelWorkspace.plan.dashscope",
    groupLabelKey: "settings.modelWorkspace.plan.codingGroup",
    logoProvider: "dashscope",
    endpoint: "https://coding.dashscope.aliyuncs.com/v1",
    protocol: "openai-chat-completions"
  },
  {
    value: "zhipu_coding_plan",
    labelKey: "settings.modelWorkspace.plan.zhipu",
    groupLabelKey: "settings.modelWorkspace.plan.codingGroup",
    logoProvider: "zhipu",
    endpoint: "https://open.bigmodel.cn/api/coding/paas/v4",
    protocol: "openai-chat-completions"
  },
  {
    value: "moonshot_coding_plan",
    labelKey: "settings.modelWorkspace.plan.moonshot",
    groupLabelKey: "settings.modelWorkspace.plan.codingGroup",
    logoProvider: "moonshot",
    endpoint: "https://api.kimi.com/coding/v1",
    protocol: "openai-chat-completions"
  },
  {
    value: "volcengine_coding_plan",
    labelKey: "settings.modelWorkspace.plan.volcengine",
    groupLabelKey: "settings.modelWorkspace.plan.codingGroup",
    logoProvider: "volcengine",
    endpoint: "https://ark.cn-beijing.volces.com/api/coding/v3",
    protocol: "openai-chat-completions"
  }
];

export function modelPlanProviderOption(provider: string): ModelPlanProviderOption | undefined {
  return MODEL_PLAN_PROVIDER_OPTIONS.find((option) => option.value === provider);
}
