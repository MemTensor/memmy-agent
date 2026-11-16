/**
 * 协助请求里「要做的事」的列表：默认显示前 3 条，其余收起成一行「展开其余 N 条」，右侧写明条数与人读的规模。
 *
 * <p>正文放宽到每条 4000 字、保留换行之后，一条请求可能很长；一致用法是默认看到前三条足够的上下文，
 * 需要时再展开。展开状态不持久化，换一次弹窗或换一条请求就回到收起。</p>
 */
import { useState } from "react";
import { useTranslation } from "../i18n/use-translation.js";
import { assistTextSize } from "./collab-assist-view.js";
import styles from "./collab-assist-items.module.css";

/** 默认显示前几条。 */
const PREVIEW_ITEMS = 3;

export function AssistItems(props: { items: readonly string[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { items } = props;
  if (!items.length) return null;
  const hidden = items.length - PREVIEW_ITEMS;
  const shown = open || hidden <= 0 ? items : items.slice(0, PREVIEW_ITEMS);
  return (
    <>
      <ol className={styles.items}>
        {shown.map((item, index) => <li key={`${index}-${item.slice(0, 24)}`}>{item}</li>)}
      </ol>
      <div className={styles.meta}>
        {hidden > 0 ? (
          <button type="button" className={styles.toggle} onClick={() => setOpen((value) => !value)}>
            {open
              ? t("collab.assist.collapse")
              : t("collab.assist.itemsMore", { count: String(hidden) })}
          </button>
        ) : <span />}
        <span className={styles.size}>
          {t("collab.assist.itemsSummary", { count: String(items.length), size: assistTextSize(items.join("\n")) })}
        </span>
      </div>
    </>
  );
}