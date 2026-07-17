export const APP_PROTOCOL_SCHEMA = "agent-app.v1";

export function compactDict(values: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value == null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return out;
}

export function appManifest({
  appId,
  app_id: appIdParam,
  displayName,
  display_name: displayNameParam,
  description,
  category,
  source,
  capabilities,
  install,
  remove,
  trust,
  version,
  logoUrl,
  logo_url: logoUrlParam,
  brandColor,
  brand_color: brandColorParam,
  docsUrl,
  docs_url: docsUrlParam,
}: {
  appId?: string;
  app_id?: string;
  displayName?: string;
  display_name?: string;
  description: string;
  category: string;
  source: string;
  capabilities: Record<string, any>[];
  install: Record<string, any>;
  remove: Record<string, any>;
  trust: Record<string, any>;
  version?: string | null;
  logoUrl?: string | null;
  logo_url?: string | null;
  brandColor?: string | null;
  brand_color?: string | null;
  docsUrl?: string | null;
  docs_url?: string | null;
}): Record<string, any> {
  return compactDict({
    schema: APP_PROTOCOL_SCHEMA,
    id: appId ?? appIdParam,
    display_name: displayName ?? displayNameParam,
    version,
    description,
    category,
    source,
    logo_url: logoUrl ?? logoUrlParam,
    brand_color: brandColor ?? brandColorParam,
    docs_url: docsUrl ?? docsUrlParam,
    capabilities,
    install,
    remove,
    trust,
  });
}
