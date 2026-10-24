// macOS can return "WeChat" even when the picker is displayed in Chinese.
export const APP_SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "com.tencent.xinwechat": ["微信", "个人微信"],
  "com.tencent.wechat": ["微信", "个人微信"],
  "win32.wechat": ["微信", "个人微信"],
  "win32.weixin": ["微信", "个人微信"],
};
