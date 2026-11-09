import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMMAND_PLUGIN_NETWORK_ALLOWLIST,
  resolveCommandPluginNetworkAllowlist
} from "../index.js";

describe("command plugin network policy", () => {
  it("allows only the exact hosts required by the built-in literature-review providers by default", () => {
    expect(resolveCommandPluginNetworkAllowlist({})).toEqual([
      "export.arxiv.org",
      "arxiv.org",
      "eutils.ncbi.nlm.nih.gov",
      "pmc.ncbi.nlm.nih.gov",
      "api.openalex.org",
      "api.crossref.org"
    ]);
    expect(DEFAULT_COMMAND_PLUGIN_NETWORK_ALLOWLIST).toContain("api.crossref.org");
    expect(DEFAULT_COMMAND_PLUGIN_NETWORK_ALLOWLIST).not.toContain("*.crossref.org");
  });

  it("accepts an explicit exact-host deployment override", () => {
    expect(resolveCommandPluginNetworkAllowlist({
      MEMMY_COMMAND_PLUGIN_NETWORK_ALLOWLIST: " EXAMPLE.COM,api.example.com "
    })).toEqual(["example.com", "api.example.com"]);
  });
});
