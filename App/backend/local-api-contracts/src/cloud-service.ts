/** Cloud service module. */

/** Definition for cloud service env key. */
export const CLOUD_SERVICE_ENV_KEY = "MEMMY_CLOUD_SERVICE";

/** Handles resolve cloud service base url. */
export function resolveCloudServiceBaseUrl(raw: string | undefined): string {
  const normalized = raw?.trim();
  if (!normalized) {
    throw new Error(
      `${CLOUD_SERVICE_ENV_KEY} 未配置:请确认外部环境、打包运行时清单或开发环境 .env 已提供网关地址。`
    );
  }
  return normalized;
}
