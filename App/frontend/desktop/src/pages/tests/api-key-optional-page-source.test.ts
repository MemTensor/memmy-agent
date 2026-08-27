import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourcePath = fileURLToPath(new URL("../api-key-optional-page.tsx", import.meta.url));

describe("ApiKeyOptionalPage catalog source", () => {
  it("只 patch ASR/Image endpoint、preset 和 byok 单选，并保留前序目录", () => {
    const source = readFileSync(sourcePath, "utf8");
    const get = source.indexOf("clients.config.getModelConfig()");
    const save = source.indexOf("clients.config.saveModelCatalog(modelConfigInput(workspace))");

    expect(get).toBeGreaterThanOrEqual(0);
    expect(save).toBeGreaterThan(get);
    expect(source).toContain('protocol: "dashscope-input-audio-chat"');
    expect(source).toContain('capabilities: ["asr"]');
    expect(source).toContain('capabilities: ["image_generation"]');
    expect(source).toContain('assignCatalogPreset(asr.workspace, "byok", "asr"');
    expect(source).toContain('assignCatalogPreset(image.workspace, "byok", "image_generation"');
    expect(source).not.toContain("createAsrProviderConfig");
    expect(source).not.toContain("createImageGenProviderConfig");
    expect(source).not.toContain("showAdvanced");
    expect(source).not.toContain("maxTokens");
    expect(source).not.toContain("dailyTokenLimit");
  });

  it("保存失败时展示可重试的持久化错误", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("const [saveError, setSaveError] = useState<string | null>(null)");
    expect(source).toContain("setSaveError(null)");
    expect(source).toContain("setSaveError(optionalStepSaveErrorText(error, t))");
    expect(source).toContain("optionalStepSaveErrorText");
    expect(source).toContain("const savedCatalogSignatureRef = useRef<string | null>(null)");
    expect(source).toContain("savedCatalogSignatureRef.current !== saveSignature");
    expect(source).toContain("savedCatalogSignatureRef.current = saveSignature");
    expect(source).toContain("const savedEndpointIdentitiesRef = useRef");
    expect(source).toContain("savedAsrIdentity?.credentialSignature === asrCredentialSignature");
    expect(source).toContain("savedImageIdentity?.credentialSignature === imageGenCredentialSignature");
    expect(source).toContain("endpointCredentialSignature(");
    expect(source).toContain("provider: provider.trim().toLowerCase()");
    expect(source).toContain('endpoint: endpoint.trim().replace(/\\/+$/, "")');
    expect(source).toContain("credential: normalizedMaskedApiKey ?");
    expect(source).toContain('role="alert"');
    expect(source).toContain("disabled={modePersistencePending}");
  });
});
