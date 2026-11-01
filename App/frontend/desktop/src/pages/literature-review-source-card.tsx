import { useRef, type ChangeEvent } from "react";
import { Folder, Plus, X } from "lucide-react";
import { Button } from "../components/button.js";
import { FileTypeIcon } from "../components/file-type-icon.js";

export interface ReviewSourceFileRow {
  file: File;
  blocked?: string | null;
}

export function ReviewSourceCard(props: {
  files: ReviewSourceFileRow[];
  accept: string;
  maxFiles?: number | null;
  validationError?: string | null;
  skippedFromFolder?: number;
  status?: "idle" | "submitting" | "answered" | "error";
  disabled?: boolean;
  canUpload: boolean;
  english?: boolean;
  onFilesPicked(files: File[]): void;
  onFolderPicked(files: File[]): void;
  onRemove(index: number): void;
  onConfirm(): void;
  onSkip(): void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const en = props.english === true;
  const readyCount = props.files.filter((item) => !item.blocked).length;
  const hasFiles = props.files.length > 0;
  const count = props.maxFiles ? `${props.files.length} / ${props.maxFiles}` : String(props.files.length);
  const pick = (event: ChangeEvent<HTMLInputElement>, receive: (files: File[]) => void) => {
    receive(Array.from(event.currentTarget.files ?? []));
    event.currentTarget.value = "";
  };
  return <article className="review-native-card review-source-card">
    <header className="review-card-header litrev-wizard-card__head"><h3>{en ? "Add local papers" : "添加本地文献"}</h3>
      <div className="litrev-wizard-card__head-actions">
        {hasFiles ? <span className="litrev-wizard-card__count">{en ? `${count} files selected` : `已选 ${count} 个文件`}</span> : null}
        <button type="button" className="litrev-wizard-card__close" disabled={props.disabled}
          aria-label={en ? "Skip local papers" : "跳过本地文献"} onClick={props.onSkip}><X size={16} strokeWidth={1.8} /></button>
      </div>
    </header>
    <div className="review-card-body litrev-wizard-card__body litrev-source-card__body">
      {hasFiles && <p className="litrev-section-hint">{en ? "Local sources are selected. Add more files or folders before confirming keywords." : "已添加本地资料。你可以继续补充文件或文件夹，再进入关键词确认。"}</p>}
      <p className="litrev-source-card__policy">{en
        ? "PDF, DOCX, TXT, and MD are supported. Selecting a folder includes only compatible files."
        : "支持 PDF、DOCX、TXT、MD；选择文件夹时只纳入其中符合格式的文件。"}</p>
      {hasFiles ? <div className="litrev-source-list" aria-label={en ? "Selected local papers" : "已选本地文献"}>
        {props.files.map((item, index) => {
          const relativePath = item.file.webkitRelativePath;
          const directory = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
          return <div className="litrev-source-list__row" key={`${relativePath || item.file.name}:${item.file.size}:${index}`}>
            <FileTypeIcon name={item.file.name} surface="row" />
            <span className="litrev-source-list__name" title={relativePath || item.file.name}>{item.file.name}</span>
            <small className={item.blocked ? "litrev-source-list__error" : ""}>
              {item.blocked || [directory, formatSourceSize(item.file.size)].filter(Boolean).join(" · ")}
            </small>
            <button type="button" disabled={props.disabled} aria-label={`${en ? "Remove" : "移除"} ${item.file.name}`}
              onClick={() => props.onRemove(index)}><X size={14} strokeWidth={1.8} /></button>
          </div>;
        })}
      </div> : <div className="litrev-source-card__empty">{en
        ? "No local papers yet. You can skip and continue with online search."
        : "尚未添加本地文献，也可以跳过并直接开始联网检索。"}</div>}
      {props.skippedFromFolder ? <p className="litrev-source-card__notice" role="status">{en
        ? `Ignored ${props.skippedFromFolder} unsupported or oversized files from the folder.`
        : `已忽略文件夹中 ${props.skippedFromFolder} 个不支持格式或超出限制的文件。`}</p> : null}
      {props.validationError && <p className="litrev-source-card__notice" role="alert">{props.validationError}</p>}
      {props.status === "error" && <p className="litrev-source-card__notice" role="alert">{en ? "Upload failed. Try again." : "上传失败，请重试。"}</p>}
      <div className="litrev-source-card__actions">
        <Button type="button" variant="secondary" size="sm" disabled={props.disabled} onClick={() => fileInput.current?.click()}><Plus size={14} strokeWidth={1.8} />{en ? "Add files" : "添加文件"}</Button>
        <Button type="button" variant="secondary" size="sm" disabled={props.disabled} onClick={() => folderInput.current?.click()}><Folder size={14} strokeWidth={1.8} />{en ? "Add folder" : "添加文件夹"}</Button>
      </div>
      <input ref={fileInput} className="sr-only" type="file" accept={props.accept} multiple disabled={props.disabled} tabIndex={-1} aria-hidden="true"
        aria-label={en ? "Add files" : "添加文件"} onChange={(event) => pick(event, props.onFilesPicked)} />
      <input ref={folderInput} className="sr-only" type="file" accept={props.accept} multiple disabled={props.disabled} tabIndex={-1} aria-hidden="true"
        aria-label={en ? "Add folder" : "添加文件夹"} onChange={(event) => pick(event, props.onFolderPicked)}
        {...{ webkitdirectory: "" } as Record<string, string>} />
    </div>
    <footer className="review-card-footer litrev-wizard-card__foot"><i aria-hidden="true" />
      {hasFiles && readyCount === 0 ? <Button type="button" variant="secondary" size="sm" disabled={props.disabled}
        onClick={props.onSkip}>{en ? "Skip" : "暂不添加，继续"}</Button> : null}
      <Button type="button" variant="primary" size="sm"
        disabled={props.disabled || (hasFiles && (!props.canUpload || Boolean(props.validationError)))}
        onClick={hasFiles ? props.onConfirm : props.onSkip}>{hasFiles
          ? en ? "Confirm sources and continue" : "确认资料并继续"
          : en ? "Skip and continue" : "暂不添加，继续"}</Button>
    </footer>
  </article>;
}

function formatSourceSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 1024) * 10) / 10} MB`;
}
