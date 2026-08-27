export function imageGenerationPrompt(text: string, config: Record<string, any> = {}): string {
  const imageConfig = config.image_generation ?? config.imageGeneration ?? {};
  if (!imageConfig.enabled) return text;
  const aspect = imageConfig.aspect_ratio ?? imageConfig.aspectRatio;
  const aspectLine = aspect
    ? `Use the generate_image tool with aspect_ratio='${aspect}'.`
    : "Use the generate_image tool. Choose the most suitable aspect_ratio yourself.";
  return `${text}\n\n${aspectLine}`;
}
