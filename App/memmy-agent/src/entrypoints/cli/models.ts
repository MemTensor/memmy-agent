export function getAllModels(): string[] {
  return [];
}

export function findModelInfo(modelName: string): Record<string, any> | null {
  void modelName;
  return null;
}

export function getModelContextLimit(model: string, provider = "auto"): number | null {
  void model;
  void provider;
  return null;
}

export function getModelSuggestions(partial: string, provider = "auto", limit = 20): string[] {
  void partial;
  void provider;
  void limit;
  return [];
}

export function formatTokenCount(tokens: number): string {
  return Math.trunc(tokens).toLocaleString("en-US");
}

export function modelDisplayName(model: string): string { return model; }
