import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";

export type WindowsStoreEdition = "cn" | "intl";

export interface WindowsStoreIdentity {
  edition: WindowsStoreEdition;
  identityName: string;
  publisher: string;
  publisherId: string;
  applicationId: string;
  packageFamilyName: string;
  aumid: string;
  packageRoot: string;
}

export interface WindowsStorePathOptions {
  isWindowsStore: boolean;
  resourcesPath: string;
  localAppDataPath?: string;
}

interface ExpectedWindowsStoreIdentity {
  edition: WindowsStoreEdition;
  publisher: string;
  publisherId: string;
  applicationId: string;
  packageFamilyName: string;
}

const corporatePublisher = "CN=2CA03910-614F-4524-BAEC-BAE9D6F10DD0";
const corporatePublisherId = "eyack96k521x2";

const expectedIdentities: Readonly<Record<string, ExpectedWindowsStoreIdentity>> = Object.freeze({
  "Memtensor.Memmy": {
    edition: "cn",
    publisher: corporatePublisher,
    publisherId: corporatePublisherId,
    applicationId: "Memmy",
    packageFamilyName: "Memtensor.Memmy_eyack96k521x2"
  },
  "Memtensor.MemmyAgent": {
    edition: "intl",
    publisher: corporatePublisher,
    publisherId: corporatePublisherId,
    applicationId: "Memmy",
    packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2"
  }
});

export const resolveWindowsStoreIdentity = (
  options: WindowsStorePathOptions
): WindowsStoreIdentity | null => {
  if (!options.isWindowsStore) return null;

  const packageRoot = findWindowsStorePackageRoot(options.resourcesPath);
  const manifestPath = join(packageRoot, "AppxManifest.xml");
  let manifest: string;
  try {
    manifest = readFileSync(manifestPath, "utf8");
  } catch (cause) {
    throw new Error(`Windows Store AppxManifest.xml is unreadable: ${manifestPath}`, { cause });
  }

  const identityTags = collectXmlTagAttributes(manifest, "Identity");
  const identityAttributes = identityTags[0];
  if (identityTags.length !== 1 || identityAttributes === undefined) {
    throw new Error("Windows Store AppxManifest.xml must contain exactly one Identity element");
  }
  const identityName = readRequiredXmlAttribute(identityAttributes, "Name", "Identity");
  const publisher = readRequiredXmlAttribute(identityAttributes, "Publisher", "Identity");
  const manifestVersion = readRequiredXmlAttribute(identityAttributes, "Version", "Identity");
  const manifestArchitecture = readRequiredXmlAttribute(identityAttributes, "ProcessorArchitecture", "Identity");
  const manifestResourceId = readOptionalXmlAttribute(identityAttributes, "ResourceId", "Identity") ?? "";
  const expected = expectedIdentities[identityName];
  if (!expected) {
    throw new Error(`Windows Store manifest identity is not an approved CN/Intl identity: ${identityName}`);
  }
  if (publisher !== expected.publisher) {
    throw new Error(`Windows Store manifest Publisher does not match ${identityName}`);
  }

  const applicationTags = collectXmlTagAttributes(manifest, "Application");
  const applicationAttributes = applicationTags[0];
  if (applicationTags.length !== 1 || applicationAttributes === undefined) {
    throw new Error("Windows Store AppxManifest.xml must contain exactly one Application identity");
  }
  const applicationId = readRequiredXmlAttribute(applicationAttributes, "Id", "Application");
  if (applicationId !== expected.applicationId) {
    throw new Error(`Windows Store Application Id does not match ${identityName}`);
  }

  const packageFullName = basename(packageRoot);
  const packageNameParts = packageFullName.split("_");
  if (
    packageNameParts.length !== 5
    || packageNameParts[0] !== identityName
    || packageNameParts[1] !== manifestVersion
    || !/^\d+\.\d+\.\d+\.\d+$/u.test(manifestVersion)
    || packageNameParts[2]?.toLowerCase() !== manifestArchitecture.toLowerCase()
    || !/^(?:x64|x86|arm|arm64|neutral)$/iu.test(manifestArchitecture)
    || packageNameParts[3] !== manifestResourceId
    || packageNameParts[4] !== expected.publisherId
  ) {
    throw new Error(`Windows Store package root is not the expected PackageFullName for ${identityName}: ${packageFullName}`);
  }

  const packageFamilyName = `${identityName}_${expected.publisherId}`;
  if (packageFamilyName !== expected.packageFamilyName) {
    throw new Error(`Windows Store Package Family Name does not match ${identityName}`);
  }
  const aumid = `${packageFamilyName}!${applicationId}`;
  return {
    edition: expected.edition,
    identityName,
    publisher,
    publisherId: expected.publisherId,
    applicationId,
    packageFamilyName,
    aumid,
    packageRoot
  };
};

export const resolveWindowsStorePackageFamilyName = (
  options: WindowsStorePathOptions
): string | null => resolveWindowsStoreIdentity(options)?.packageFamilyName ?? null;

export const resolveWindowsStoreAumid = (
  options: WindowsStorePathOptions
): string | null => resolveWindowsStoreIdentity(options)?.aumid ?? null;

export const resolveWindowsStoreUserDataPath = (
  options: WindowsStorePathOptions
): string | null => {
  const identity = resolveWindowsStoreIdentity(options);
  if (!identity) return null;

  const localAppDataPath = options.localAppDataPath?.trim();
  if (!localAppDataPath) {
    throw new Error("Windows Store LOCALAPPDATA is unavailable");
  }
  if (!win32.isAbsolute(localAppDataPath)) {
    throw new Error("Windows Store LOCALAPPDATA must be an absolute path");
  }
  return win32.join(
    win32.normalize(localAppDataPath),
    "Packages",
    identity.packageFamilyName,
    "LocalState",
    "Memmy"
  );
};

const findWindowsStorePackageRoot = (resourcesPath: string): string => {
  const trimmedResourcesPath = resourcesPath.trim();
  if (!trimmedResourcesPath) {
    throw new Error("Windows Store resources path is unavailable");
  }
  if (!isAbsolute(trimmedResourcesPath)) {
    throw new Error("Windows Store resources path must be absolute");
  }

  let candidate = resolve(trimmedResourcesPath);
  for (let depth = 0; depth <= 8; depth += 1) {
    if (existsSync(join(candidate, "AppxManifest.xml"))) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(`Windows Store AppxManifest.xml was not found above resources path: ${resourcesPath}`);
};

const collectXmlTagAttributes = (manifest: string, tagName: string): string[] => {
  const attributes: string[] = [];
  const tagPattern = new RegExp(
    `<(?:[A-Za-z][\\w.-]*:)?${tagName}\\b([^>]*)>`,
    "giu"
  );
  for (const match of manifest.matchAll(tagPattern)) {
    attributes.push(match[1] ?? "");
  }
  return attributes;
};

const readRequiredXmlAttribute = (
  attributes: string,
  attributeName: string,
  elementName: string
): string => {
  const matches = readXmlAttributeMatches(attributes, attributeName);
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(`Windows Store ${elementName} must contain exactly one ${attributeName} attribute`);
  }
  return matches[0];
};

const readOptionalXmlAttribute = (
  attributes: string,
  attributeName: string,
  elementName: string
): string | undefined => {
  const matches = readXmlAttributeMatches(attributes, attributeName);
  if (matches.length > 1 || (matches.length === 1 && !matches[0])) {
    throw new Error(`Windows Store ${elementName} contains an invalid ${attributeName} attribute`);
  }
  return matches[0];
};

const readXmlAttributeMatches = (attributes: string, attributeName: string): string[] => {
  const matches: string[] = [];
  const attributePattern = /(?:^|\s)([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/gu;
  for (const match of attributes.matchAll(attributePattern)) {
    if (match[1] === attributeName) {
      matches.push(decodeXmlAttribute(match[3] ?? ""));
    }
  }
  return matches;
};

const decodeXmlAttribute = (value: string): string => {
  const decoded = value.replace(/&(quot|apos|amp|lt|gt);/gu, (entity) => ({
    "&quot;": "\"",
    "&apos;": "'",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">"
  })[entity] ?? entity);
  if (/&(?:#\d+|#x[\da-f]+|[A-Za-z][\w.-]*);/iu.test(decoded)) {
    throw new Error("Windows Store AppxManifest.xml contains an unsupported XML entity");
  }
  return decoded;
};
