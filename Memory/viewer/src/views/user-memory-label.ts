type TranslateUserMemoryType = (
  key: "memories.user.type.fact" | "memories.user.type.preference" | "memories.user.type.directive",
) => string;

export function userMemoryTypeLabel(type: string, translate: TranslateUserMemoryType): string {
  if (type === "User Fact") return translate("memories.user.type.fact");
  if (type === "User Preference") return translate("memories.user.type.preference");
  if (type === "User Directive") return translate("memories.user.type.directive");
  return type;
}
