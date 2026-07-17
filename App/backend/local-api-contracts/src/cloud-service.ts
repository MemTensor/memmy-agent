/** Cloud service module. */

/** Definition for cloud service env key. */
export const CLOUD_SERVICE_ENV_KEY = "MEMMY_CLOUD_SERVICE";

/** Handles resolve cloud service base url. */
export function resolveCloudServiceBaseUrl(raw: string | undefined): string {
  const normalized = raw?.trim();
  if (!normalized) {
    throw new Error(
      `${CLOUD_SERVICE_ENV_KEY} 未配置:网关地址唯一来源是仓库根 .env,请确认入口已加载该文件。`
    );
  }
  return normalized;
}
