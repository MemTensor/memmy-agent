import { useState } from "react";
import { MessageCircle } from "lucide-react";
import type { IntegrationAuthKind, IntegrationCategory } from "@memmy/local-api-contracts";
import { ALL_INTEGRATION_CATALOG } from "./toolkit-catalog.js";
import feishuLogoUrl from "../assets/channel-logos/feishu.svg";
import dingtalkLogoUrl from "../assets/channel-logos/dingtalk.svg";
import wechatLogoUrl from "../assets/channel-logos/wechat.svg";

export const CATEGORY_TABS = ["All", "Chat", "Productivity", "Tools & Automation", "Social", "Platform"] as const;
export type IntegrationCategoryTab = (typeof CATEGORY_TABS)[number];
export type IntegrationSurface = "channel" | "integration";

export interface IntegrationMeta {
  slug: string;
  surface: IntegrationSurface;
  identity: string;
  name: string;
  description: string;
  category: IntegrationCategory;
  logoUrl: string;
  permissionLabel: string;
  authKind: IntegrationAuthKind;
  isChannel: boolean;
  authProvider?: string;
}

const chatKeywords = ["discord", "slack", "teams", "webex", "whatsapp", "dialpad"];
const socialKeywords = ["facebook", "instagram", "linkedin", "reddit", "youtube", "stack_exchange"];
const productivityKeywords = [
  "gmail",
  "calendar",
  "drive",
  "docs",
  "doc",
  "sheets",
  "slides",
  "tasks",
  "todoist",
  "trello",
  "notion",
  "box",
  "dropbox",
  "sharepoint",
  "share_point",
  "one_drive",
  "onedrive",
  "outlook",
  "miro",
  "mural",
  "monday",
  "clickup",
  "linear",
  "jira",
  "confluence",
  "asana",
  "basecamp",
  "wrike",
  "cal",
  "calendly",
  "typeform",
  "excel",
  "figma",
  "google"
];
const platformKeywords = [
  "github",
  "gitlab",
  "bitbucket",
  "digital_ocean",
  "contentful",
  "supabase",
  "convex",
  "prisma",
  "sentry",
  "stripe",
  "salesforce",
  "hubspot",
  "quickbooks",
  "zendesk",
  "zoho"
];

interface ChannelIconDefinition {
  Icon: typeof MessageCircle;
  className: string;
}

const channelIconBySlug: Record<string, ChannelIconDefinition> = {
  imessage: { Icon: MessageCircle, className: "channel-integration-icon-imessage" }
};

const channelLogoBySlug: Record<string, string> = {
  feishu: feishuLogoUrl,
  dingtalk: dingtalkLogoUrl,
  wechat: wechatLogoUrl
};

export function composioLogoUrl(slug: string): string {
  return `https://logos.composio.dev/api/${slug}`;
}

/**
 * Guess the integration category from its slug/name.
 *
 * @param slug the integration slug.
 * @param name the display name.
 * @returns the Memmy tools page category.
 */
export function guessIntegrationCategory(slug: string, name: string): IntegrationCategory {
  const key = `${slug} ${name}`.toLowerCase();

  if (chatKeywords.some((keyword) => key.includes(keyword))) {
    return "Chat";
  }

  if (socialKeywords.some((keyword) => key.includes(keyword))) {
    return "Social";
  }

  if (productivityKeywords.some((keyword) => key.includes(keyword))) {
    return "Productivity";
  }

  if (platformKeywords.some((keyword) => key.includes(keyword))) {
    return "Platform";
  }

  return "Tools & Automation";
}

/**
 * Get the display metadata for all integrations.
 *
 * @returns the 5 channels plus the full managed-auth table.
 */
export function getAllIntegrationMeta(): IntegrationMeta[] {
  return ALL_INTEGRATION_CATALOG.map((item) => createIntegrationMeta(item.slug, item.name, item.authKind, item.isChannel, item.authProvider));
}

/**
 * Look up integration metadata by slug.
 *
 * @param slug the integration slug.
 * @param surface an optional tools page surface; when provided, disambiguates channel vs integration for the same slug.
 * @returns the matching display metadata; undefined when not found.
 */
export function getIntegrationMeta(slug: string, surface?: IntegrationSurface): IntegrationMeta | undefined {
  return getAllIntegrationMeta().find((item) => item.slug === slug && (!surface || item.surface === surface));
}

/**
 * Generic remote logo badge.
 *
 * @param props.slug the integration slug.
 * @param props.name the display name.
 * @param props.surface the tools page surface; only the channel surface uses Memmy's own channel icons.
 * @returns the logo badge node, falling back to a generic icon when the image fails to load.
 */
export function IntegrationLogoBadge(props: { slug: string; name: string; surface?: IntegrationSurface; sizeClassName?: string }) {
  const [failed, setFailed] = useState(false);
  const sizeClassName = props.sizeClassName ?? "h-8 w-8";
  const channelLogo = props.surface === "channel" ? channelLogoBySlug[props.slug] : undefined;
  const channelIcon = props.surface === "channel" ? channelIconBySlug[props.slug] : undefined;

  if (channelLogo) {
    return (
      <span className={`integration-logo-slot flex ${sizeClassName} items-center justify-center`}>
        <span className="integration-logo-badge">
          <img src={channelLogo} alt={`${props.name} logo`} className="integration-logo-image" loading="lazy" />
        </span>
      </span>
    );
  }

  if (channelIcon) {
    return <ChannelIntegrationIcon name={props.name} icon={channelIcon} sizeClassName={sizeClassName} />;
  }

  if (failed) {
    return <GenericIntegrationIcon name={props.name} sizeClassName={sizeClassName} />;
  }

  return (
    <span className={`integration-logo-slot flex ${sizeClassName} items-center justify-center`}>
      <span className="integration-logo-badge">
        <img
          src={composioLogoUrl(props.slug)}
          alt={`${props.name} logo`}
          className="integration-logo-image"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </span>
    </span>
  );
}

/**
 * Render a channel-specific icon.
 *
 * @param props.name the channel display name.
 * @param props.icon the channel icon component and color class.
 * @param props.sizeClassName the outer slot's size class.
 * @returns the channel icon node.
 */
function ChannelIntegrationIcon(props: { name: string; icon: ChannelIconDefinition; sizeClassName: string }) {
  const Icon = props.icon.Icon;

  return (
    <span className={`channel-integration-icon flex ${props.sizeClassName} items-center justify-center`} aria-label={`${props.name} logo`}>
      <span className={`channel-integration-icon-badge ${props.icon.className}`}>
        <Icon size={18} strokeWidth={2.2} aria-hidden="true" />
      </span>
    </span>
  );
}

/**
 * Generic icon shown after the remote logo fails to load.
 *
 * @param props.name the display name, used for the accessibility label.
 * @param props.sizeClassName the size class.
 * @returns a self-drawn generic placeholder icon.
 */
export function GenericIntegrationIcon(props: { name: string; sizeClassName?: string }) {
  const sizeClassName = props.sizeClassName ?? "h-8 w-8";

  return (
    <span
      className={`generic-integration-icon flex ${sizeClassName} items-center justify-center text-stone-600`}
      aria-label={`${props.name} logo fallback`}
    >
      <span className="generic-integration-icon-badge">
        <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" aria-hidden="true" fill="none">
          <path d="M8 8h8v8H8zM5 12h3m8 0h3M12 5v3m0 8v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </span>
    </span>
  );
}

/**
 * Create the display metadata for a single item.
 *
 * @param slug the integration slug.
 * @param name the display name.
 * @param authKind the authorization method.
 * @param isChannel whether it is a channel.
 * @returns the integration display metadata.
 */
function createIntegrationMeta(slug: string, name: string, authKind: IntegrationAuthKind, isChannel: boolean, authProvider?: string): IntegrationMeta {
  const category = isChannel ? "Chat" : guessIntegrationCategory(slug, name);
  const surface: IntegrationSurface = isChannel ? "channel" : "integration";

  return {
    slug,
    surface,
    identity: `${surface}:${slug}`,
    name,
    description: descriptionFor(name, category, slug),
    category,
    logoUrl: composioLogoUrl(slug),
    permissionLabel: permissionLabelFor(category),
    authKind,
    isChannel,
    authProvider: authProvider ?? (isChannel ? undefined : "Composio")
  };
}

/**
 * Generate the default description.
 *
 * @param name the display name.
 * @param category the category.
 * @param slug the integration slug.
 * @returns the card description.
 */
function descriptionFor(name: string, category: IntegrationCategory, slug: string): string {
  if (slug === "instagram") {
    return "Connect Instagram Business or Creator accounts for audience workflows.";
  }

  switch (category) {
    case "Chat":
      return `Connect ${name} for messaging, inbox, and team communication workflows.`;
    case "Social":
      return `Connect ${name} for social publishing, community, and audience workflows.`;
    case "Productivity":
      return `Connect ${name} for documents, planning, file, and day-to-day productivity workflows.`;
    case "Platform":
      return `Connect ${name} for developer, platform, CRM, and business system workflows.`;
    default:
      return `Connect ${name}.`;
  }
}

/**
 * Generate the permission label shown in the authorization prompt.
 *
 * @param category the integration category.
 * @returns the data scope description.
 */
function permissionLabelFor(category: IntegrationCategory): string {
  switch (category) {
    case "Chat":
      return "Messages, channels, and communication data";
    case "Social":
      return "Posts, profiles, and social content";
    case "Productivity":
      return "Docs, files, tasks, and workspace data";
    case "Platform":
      return "Repos, records, tickets, and system data";
    default:
      return "Connected account data";
  }
}
