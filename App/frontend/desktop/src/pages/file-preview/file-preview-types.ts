export interface FilePreviewResource {
  id: string;
  name: string;
  path?: string;
  mediaType?: string;
  size?: number | null;
  load(signal?: AbortSignal): Promise<Blob>;
  open?: () => Promise<void> | void;
  reveal?: () => Promise<void> | void;
  download?: () => Promise<void> | void;
  openRelativePath?: (path: string) => void;
  loadRelativePath?: (path: string, signal?: AbortSignal) => Promise<Blob>;
}

export interface FilePreviewViewState {
  page?: number;
  scale?: number;
  fit?: "width" | "page" | null;
  scrollTop?: number;
  markdownMode?: "preview" | "source";
}
