/**
 * 协助请求附带的文本与脚本：一行一个文件，右侧「预览」展开只读原文。
 *
 * <p>只给名字、类型图标与预览：附件只收文本与脚本，她要看的是「要跑的是什么」，
 * 文件大小、用途徒标与说明段落都是额外的理解成本，不在这里展开。</p>
 */
import { useState } from "react";
import { FileCode2, FileText } from "lucide-react";
import type { AssistRequest } from "../api/collab-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import styles from "./collab-assist-attachments.module.css";

/** 附件正文的预览上限：再长就只给前一段，超出注明已截断。 */
const PREVIEW_CHARS = 4_000;
/** 与后端一碗水：这几个扩展名落盘后置为可执行。图标据此区分脚本与文本。 */
const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".rb"]);

export function AssistAttachments(props: {
  attachments: NonNullable<AssistRequest["attachments"]>;
}) {
  const { t } = useTranslation();
  const [previewing, setPreviewing] = useState<string | null>(null);
  const { attachments } = props;
  if (!attachments.length) return null;
  return (
    <div className={styles.list} data-collab-assist-attachments="">
      {attachments.map((attachment) => {
        const script = SCRIPT_EXTENSIONS.has(extensionOf(attachment.name));
        const content = attachment.content ?? "";
        const open = previewing === attachment.name;
        const Icon = script ? FileCode2 : FileText;
        return (
          <div key={attachment.name} className={styles.row}>
            <div className={styles.head}>
              <Icon size={14} aria-hidden="true" className={styles.icon} />
              <span className={styles.name}>{attachment.name}</span>
              <button
                type="button"
                className={styles.preview}
                aria-expanded={open}
                onClick={() => setPreviewing(open ? null : attachment.name)}
              >
                {open ? t("collab.assist.attachment.hidePreview") : t("collab.assist.attachment.preview")}
              </button>
            </div>
            {open ? (
              <div className={styles.previewBody}>
                <pre className={styles.pre}>{previewOf(content)}</pre>
                {content.length > PREVIEW_CHARS ? (
                  <span className={styles.truncated}>{t("collab.assist.attachment.truncated")}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** 预览正文：超出上限时截断，界面另注一行「已截断」。 */
function previewOf(content: string): string {
  return content.length > PREVIEW_CHARS ? content.slice(0, PREVIEW_CHARS) : content;
}

/** 扩展名（小写，含点）：类型图标与徽标都按它判断。 */
function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  return at > 0 ? name.slice(at).toLowerCase() : "";
}