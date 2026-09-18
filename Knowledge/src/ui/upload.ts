import { MAX_UPLOAD_BYTES } from "../types.js";

export const DOCUMENT_EXTENSIONS =
  ".pdf,.docx,.doc,.txt,.json,.md,.xml";
export interface UploadResult {
  name: string;
  ok: boolean;
  error?: string;
}

/** Process one file at a time so a batch keeps the same per-file request/memory limit. */
export async function uploadDocuments(
  files: readonly File[],
  upload: (file: File, content: string) => Promise<unknown>,
  onProgress: (completed: number, total: number, name: string) => void,
  zh = true,
): Promise<UploadResult[]> {
  const results: UploadResult[] = [];
  for (const file of files) {
    onProgress(results.length, files.length, file.name);
    try {
      if (!file.size || file.size > MAX_UPLOAD_BYTES)
        throw new Error(
          zh ? "文件为空或超过 20 MB" : "File is empty or exceeds 20 MB",
        );
      if (!/\.(pdf|docx|doc|txt|json|md|xml)$/i.test(file.name))
        throw new Error(
          zh
            ? "不支持的文档格式（支持 PDF、Word、TXT、Markdown、JSON、XML）"
            : "Unsupported file type (supported: PDF, Word, TXT, Markdown, JSON, XML)",
        );
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = reader.onabort = () =>
          reject(new Error(zh ? "读取文件失败" : "Could not read file"));
        reader.readAsDataURL(file);
      });
      await upload(file, content);
      results.push({ name: file.name, ok: true });
    } catch (error) {
      results.push({
        name: file.name,
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : zh
              ? "上传失败"
              : "Upload failed",
      });
    }
  }
  return results;
}
