/**
 * Materialize files received from an opaque-origin plugin iframe before fetch.
 * Chromium cannot upload the cross-frame disk-backed File directly: it fails
 * with ERR_ALPN_NEGOTIATION_FAILED before reaching the local upload endpoint.
 * Reading bytes and constructing a memory-backed Blob preserves sandboxing.
 * Call only after the host has checked the file count, type and size limits.
 */
export async function materializePluginUploadFile(file: File): Promise<Blob> {
  return new Blob([await file.arrayBuffer()], { type: file.type });
}
