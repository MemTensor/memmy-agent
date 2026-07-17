import type { AppRoutePath } from "../app/routes.js";
import type { MemorySubPageId } from "../pages/memory-page.js";
import type { PageViewEvent } from "./analytics-events.js";
import { resolveAnalyticsPageLocation } from "./page-location.js";

const ROUTE_PAGE_TITLES: Record<AppRoutePath, string> = {
  "/welcome": "Welcome",
  "/token-detail": "Token Detail",
  "/login": "Login",
  "/api-key": "API Key",
  "/api-key-models": "API Key Models",
  "/api-key-optional": "API Key Optional Models",
  "/onboarding": "Onboarding",
  "/main": "Home",
  "/pet": "Pet",
  "/tools": "Tools",
  "/memory": "Memory",
  "/memory-sources": "Memory Sources",
  "/settings": "Settings"
};

const MEMORY_SUB_PAGE_TITLES: Record<MemorySubPageId, string> = {
  overview: "Overview",
  memories: "Memories",
  tasks: "Tasks",
  policies: "Policies",
  "world-model": "World Model",
  skills: "Skills",
  analytics: "Analytics",
  logs: "Logs",
  sources: "Sources"
};

/** Memory routes report sub-page views as page_view instead of at the top-level router. */
export function shouldDeferRoutePageView(path: AppRoutePath): boolean {
  return path === "/memory" || path === "/memory-sources";
}

export function resolveRoutePageTitle(path: AppRoutePath): string {
  return ROUTE_PAGE_TITLES[path] ?? path;
}

export function resolveMemorySubPagePath(subPage: MemorySubPageId): string {
  return `/memory/${subPage}`;
}

export function resolveMemorySubPageTitle(subPage: MemorySubPageId): string {
  return `Memory/${MEMORY_SUB_PAGE_TITLES[subPage]}`;
}

export function buildPageViewEvent(input: {
  pagePath: string;
  pageTitle: string;
  referrerPath?: string | null;
  isProd?: boolean;
}): PageViewEvent {
  const isProd = input.isProd ?? import.meta.env.PROD;
  return {
    name: "page_view",
    params: {
      page_title: input.pageTitle,
      page_location: resolveAnalyticsPageLocation(input.pagePath, isProd),
      page_referrer: input.referrerPath
        ? resolveAnalyticsPageLocation(input.referrerPath, isProd)
        : ""
    },
    consentTier: "basic"
  };
}

export function buildRoutePageViewEvent(
  path: AppRoutePath,
  referrerPath: AppRoutePath | null,
  isProd = import.meta.env.PROD
): PageViewEvent {
  return buildPageViewEvent({
    pagePath: path,
    pageTitle: resolveRoutePageTitle(path),
    referrerPath,
    isProd
  });
}

export function buildMemorySubPageViewEvent(
  subPage: MemorySubPageId,
  referrerSubPage: MemorySubPageId | null,
  isProd = import.meta.env.PROD
): PageViewEvent {
  return buildPageViewEvent({
    pagePath: resolveMemorySubPagePath(subPage),
    pageTitle: resolveMemorySubPageTitle(subPage),
    referrerPath: referrerSubPage ? resolveMemorySubPagePath(referrerSubPage) : null,
    isProd
  });
}
