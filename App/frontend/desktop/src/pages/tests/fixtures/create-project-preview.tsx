/**
 * 新建项目弹窗的预览页：`create-project-preview.html?share=on|off`。
 *
 * 渲的是真实组件与真实样式，只把协作客户端换成空对象，所以能看出开关行的框、页脚三个按钮的
 * 高度 / 字号 / 字重是否一致；点「创建项目」不会真的建项目（没有桥），只看界面。
 */
import { createRoot } from "react-dom/client";
import type { CollabClient } from "../../../api/collab-client.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { CreateProjectModal } from "../../collab-create-project-dialog.js";
import "../../../styles.css";

const params = new URLSearchParams(window.location.search);

createRoot(document.getElementById("root")!).render(
  <I18nProvider language="zh-CN">
    <CreateProjectModal
      open
      shareAvailable
      defaultShare={params.get("share") !== "off"}
      collab={{} as CollabClient}
      onClose={() => undefined}
      onCreated={() => undefined}
      onShared={() => undefined}
      onBound={() => undefined}
      onBindFailed={() => undefined}
      onShareFailed={() => undefined}
      onJoinProject={() => undefined}
    />
  </I18nProvider>
);
