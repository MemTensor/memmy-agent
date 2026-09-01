import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMMAND_PLUGIN_NETWORK_ALLOWLIST,
  resolveCommandPluginNetworkAllowlist
} from "../index.js";

describe("command plugin network policy", () => {
  it("allows only the two exact hosts required by the arXiv provider by default", () => {
    expect(resolveCommandPluginNetworkAllowlist({})).toEqual([
      "export.arxiv.org",
      "arxiv.org"
    ]);
    expect(DEFAULT_COMMAND_PLUGIN_NETWORK_ALLOWLIST).not.toContain("api.crossref.org");
  });

  it("accepts an explicit exact-host deployment override", () => {
    expect(resolveCommandPluginNetworkAllowlist({
      MEMMY_COMMAND_PLUGIN_NETWORK_ALLOWLIST: " EXAMPLE.COM,api.example.com "
    })).toEqual(["example.com", "api.example.com"]);
  });
});
