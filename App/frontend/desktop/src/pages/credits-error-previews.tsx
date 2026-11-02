/** Isolated examples in the existing app shells; no billing or task mutations. */
import { useState, useMemo, type ReactNode } from "react";
import { AlertTriangle, CircleAlert, Plus, Mic, Send } from "lucide-react";
import type { PanelItemsOutput } from "@memmy/local-api-contracts";
import { KnowledgePage as KnowledgeManagement } from "@memmy/knowledge/ui";
import { Button } from "../components/button.js";
import { Select } from "../components/Select.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { useCreditDemo } from "../app/use-credit-demo.js";
import type { AgentChatMessage } from "../state/agent-chat-slice.js";
import { AppFrame } from "./app-frame.js";
import { AgentThreadMessages } from "./agent-thread-messages.js";
import { MemoryPage, MemoryPageView, type MemorySubPageId } from "./memory-page.js";
import { MemoriesSubPageView } from "./memory/memories-sub-page.js";
import styles from "./credits-error-previews.module.css";

function useCopy() {
  const { language } = useTranslation();
  return (cn: string, en: string) => language.startsWith("zh") ? cn : en;
}

function CreditNotice({ label, title, children }: {
  label: string; title: string; children: ReactNode;
}) {
  return <section className={`agent-model-error-notice ${styles.notice}`} role="alert" aria-label={label}>
    <AlertTriangle size={16} className="agent-model-error-notice__icon" aria-hidden="true" />
    <div className={styles.noticeBody}>
      <h2 className="agent-model-error-notice__title">{title}</h2>
      {children}
    </div>
  </section>;
}

function AgentLimitNotice() {
  const text = useCopy();
  const { demo } = useCreditDemo();
  const message = demo.plan === "pro"
    ? text("积分不足，当前任务已暂停。可查看积分来源或切换自有模型后继续", "Not enough credits. This task is paused. Check your credits or switch to your own model to continue.")
    : text("积分不足，当前任务已暂停。可申请升级，权益开通后再继续任务", "Not enough credits. This task is paused. Apply for an upgrade and continue after it is activated.");
  return <div className={styles.limitLine} role="alert" aria-label={text("Agent 任务积分不足", "Agent task out of credits")}>
    <span className={styles.limitMessage}><CircleAlert size={16} aria-hidden="true" />
      {message}
    </span>
  </div>;
}

export function CreditsLimitsPage() {
  const text = useCopy();
  const recoveredPreview = new URLSearchParams(window.location.search).get("credits-recovered") === "1";
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState<"platform" | "byok">("platform");
  const [followUps, setFollowUps] = useState<Array<{ user: string; reply: string }>>(() => recoveredPreview ? [{
    user: text("积分已经补足。请继续整理恢复方式。", "Credits are available again. Please continue with the recovery flow."),
    reply: text("恢复方式补充如下：记忆服务满足恢复条件后自动继续；Agent 任务从这条新消息开始按当前模型正常处理。", "To complete the recovery flow: the memory service resumes when its conditions are met, and this new message starts a normal Agent turn with the selected model.")
  }] : []);
  const [errorAttempt, setErrorAttempt] = useState(0);
  const title = text("积分不足时的 Agent 任务处理", "Handling Agent tasks when credits run out");
  const messages: AgentChatMessage[] = [
    { id:"preview-user", role:"user", content:text("梳理积分不足时的 Agent 任务处理：先写中断与内容保留，再写恢复方式。", "Describe how an Agent task stops, preserves work, and resumes when credits run out.") },
    { id:"preview-partial", role:"assistant", turnId:"preview-turn", content:text("先整理已确定的部分：\n\n- 平台模型调用期间发现积分不足时，暂停当前任务。\n- 已展示的回复、工具结果和用户输入保留。\n\n恢复方式还在整理中。", "Established behavior so far:\n\n- Pause the task when platform-model credits run out.\n- Keep visible replies, tool results, and user input.\n\nThe recovery flow is still being prepared.") }
  ];
  followUps.forEach(({ user, reply }, index) => {
    messages.push({ id:`preview-follow-up-${index}`, role:"user", content:user });
    messages.push({ id:`preview-reply-${index}`, role:"assistant", turnId:`preview-follow-up-turn-${index}`, content:reply });
  });
  const sendMessage = () => {
    if (!draft.trim()) return;
    if (model === "platform" && !recoveredPreview) {
      setErrorAttempt(value => value + 1);
      return;
    }
    setFollowUps(current => [...current, {
      user: draft.trim(),
      reply: text("收到，我会按当前模型继续处理。", "Got it. I'll continue with the selected model.")
    }]);
    setDraft("");
  };
  return <AppFrame title={title} topBar={<h1 className="agent-conversation-title"><span className="agent-conversation-title__text">{title}</span></h1>}>
    <div className="credits-empty-demo">
      <div className="credits-empty-demo__thread"><div className="credits-empty-demo__column">
        <AgentThreadMessages chatScopeKey="credits-error-preview" messages={messages}
          afterMessageId="preview-partial" afterMessageContent={<AgentLimitNotice key={errorAttempt} />} />
      </div></div>
      <div className={styles.composerDock}>
        <div className="agent-conversation-content agent-conversation-content--composer max-w-3xl mx-auto">
          <div className="agent-composer-flow"><div className="agent-composer-stack">
            <div className="relative agent-composer-shell agent-composer-shell--expanded rounded-card-lg">
              <textarea rows={1} value={draft} onChange={event => setDraft(event.target.value)} aria-label={text("输入消息", "Message")}
                placeholder={text("分配一个任务或提问任何问题...", "Assign a task or ask any question...")}
                className="agent-composer-input--conversation block w-full pl-4 py-3 text-sm resize-none focus:outline-none rounded-card-lg bg-background-paper placeholder:text-text-ink/40" />
              <div className="agent-composer-toolbar"><div className="agent-composer-toolbar__leading"/><div className="composer-actions">
                <Select ariaLabel={text("会话模型", "Chat model")} value={model} onValueChange={value => setModel(value === "byok" ? "byok" : "platform")}
                  options={[
                    { value:"platform", label:text("Memmy Agent 模型", "Memmy Agent model") },
                    { value:"byok", label:text("自有 API Key 模型", "Own API key model") }
                  ]} placement="top" className="select-control--compact select-control--subtle agent-model-selector__control" buttonClassName="agent-model-selector__button" menuClassName="agent-model-selector__menu" />
                <button type="button" className="composer-action-btn" aria-label={text("添加图片和文件", "Add images and files")} disabled><Plus size={15} strokeWidth={2}/></button>
                <button type="button" className="composer-action-btn" aria-label={text("语音输入", "Voice input")} disabled><Mic size={15} strokeWidth={2}/></button>
                <button type="button" disabled={!draft.trim()} onClick={sendMessage}
                  className={`composer-action-submit ${!draft.trim() ? "bg-text-ink/25 text-white cursor-not-allowed" : "bg-action-sky text-white hover:bg-action-sky-hover shadow-sm cursor-pointer"}`}
                  aria-label={text("发送", "Send")}><Send size={13} className="translate-y-[1px]"/></button>
              </div></div>
            </div>
          </div></div>
        </div>
        <p className="text-center text-[11px] text-text-ink/40 mt-2">{text("内容由 AI 生成，请仔细甄别", "Content generated by AI, please verify before using")}</p>
      </div>
    </div>
  </AppFrame>;
}

export function CreditsMemoryPausedPage() {
  const text = useCopy();
  const { dispatch } = useAppState();
  const [page, setPage] = useState<MemorySubPageId>("memories");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  const [now] = useState(() => new Date());
  const samples = [
    [text("产品评审：套餐与申请升级", "Product review: plans and upgrade applications"), text("套餐页查看权益，填写问卷申请升级。", "Compare benefits and fill out the upgrade form.")],
    [text("邀请奖励与明细展示", "Referral rewards and records"), text("注册成功后双方各得 200 积分，奖励按每位好友单独记录。", "Registration grants 200 credits to each person, recorded per friend.")],
    [text("知识库的使用边界", "Knowledge base usage"), text("上传与存储按套餐额度限制；召回产生的模型消耗归入 Agent 任务。", "Uploads and storage use plan quotas; model usage during recall belongs to the Agent task.")]
  ];
  const items: PanelItemsOutput["items"] = samples.map(([title, summary], index) => ({
    id: `credits-memory-${index}`, kind: "trace", memoryLayer: "L1", status: "activated", title: title!, summary: summary!,
    tags: [], metadata: { source: "memmy" }, createdAt: new Date(now.getTime() - (index + 1) * 3600000).toISOString(), updatedAt: now.toISOString(), version: 1
  }));
  const visible = items.filter(item => (!query || `${item.title} ${item.summary}`.includes(query)) && (!source || ["memmy", "memmy-agent", "memmy_agent"].includes(source)));
  if (page !== "memories") return <MemoryPage initialSubPage={page}/>;
  const notice = <CreditNotice label={text("记忆服务暂停", "Memory service paused")} title={text("积分不足，记忆加工已暂停", "Memory processing paused: not enough credits")}>
    <p className={styles.description}>{text("原始内容和已完成记忆保留。积分恢复，或记忆服务改用已配置的自有 API Key 模型后，将自动继续。", "Source material and completed memories are saved. Processing resumes automatically when credits return or the memory service switches to a configured own API key model.")}</p>
  </CreditNotice>;
  const content = <><MemoriesSubPageView state={{status:"ready",data:{items:visible,page:1,pageSize:20,total:visible.length,totalPages:1,hasNext:false,hasPrev:false,serverTime:now.toISOString()}}}
    notice={notice} query={query} sourceAgent={source} onQueryChange={setQuery} onSourceAgentChange={setSource} onSearch={()=>undefined} onRefresh={()=>undefined}
    onPageChange={()=>undefined} onOpenDetail={item=>setOpened(`${item.title}\n\n${item.summary}`)} onDeleteDetail={async()=>undefined} onCloseDetail={()=>setOpened(null)}/>
    {opened && <div className={styles.overlay} onClick={()=>setOpened(null)}><div role="dialog" aria-modal="true" aria-label={text("已完成记忆", "Completed memory")} className={styles.detail} onClick={event=>event.stopPropagation()}><p>{opened}</p><Button size="sm" onClick={()=>setOpened(null)}>{text("关闭", "Close")}</Button></div></div>}
  </>;
  return <MemoryPageView activePage="memories" onActivePageChange={setPage} onBack={()=>dispatch(appActions.navigate("/main"))} onOpenMemoryBudgetSettings={()=>dispatch(appActions.navigate("/settings"))}
    childByPage={{overview:null,"computer-history":null,memories:content,"user-memories":null,tasks:null,policies:null,"world-model":null,skills:null,analytics:null,logs:null,sources:null}}/>;
}

export async function knowledgeLimitPreviewRequest(path: string, method = "GET", plan: "free" | "pro" = "free"): Promise<unknown> {
  if (method !== "GET") throw new Error("No changes were made.");
  if (path === "/settings") {
    const names = ["产品方案","用户调研","设计规范","会议记录","技术文档","运营活动","竞品资料","项目归档","团队协作","常见问题"];
    return { authenticated:true, enabled:true, serviceAvailable:true, maxBases:plan === "pro" ? 50 : 10,
      bases:Array.from({length:plan === "pro" ? 50 : 10},(_,index)=>({id:`sample-kb-${index}`,name:names[index] ?? `知识库 ${index+1}`,selected:index===0})) };
  }
  if (path.includes("/members")) return {members:[]};
  if (path.includes("/folders")) return {folders:[]};
  if (path.includes("/files")) return {page:1,total:3,files:["积分产品方案.pdf","套餐页面评审.md","用户反馈整理.docx"].map((name,index)=>({id:`sample-file-${index}`,name,status:"available",message:""}))};
  return {};
}

export function CreditsKnowledgeLimitPage() {
  const text = useCopy();
  const { language } = useTranslation();
  const params = new URLSearchParams(window.location.search);
  const selected = params.get("knowledge-limit");
  const plan = params.get("credits-plan") === "pro" ? "pro" : "free";
  const kind = selected === "storage" || selected === "sharing" ? selected : "count";
  const previewRequest = useMemo(() => {
    let members = [
      {userId:"preview-member-1",name:"林悦",contact:"lin.yue@example.com",status:"ACTIVE"},
      {userId:"preview-member-2",name:"陈晨",contact:"chen.chen@example.com",status:"ACTIVE"},
      {userId:"preview-member-3",name:"周宁",contact:"zhou.ning@example.com",status:"ACTIVE"},
      {userId:"preview-member-4",name:"许安",contact:"xu.an@example.com",status:"ACTIVE"}
    ];
    if (plan === "pro") members = [...members, ...Array.from({length:5},(_,index)=>({userId:`preview-member-${index+5}`,name:`协作者 ${index+5}`,contact:`member${index+5}@example.com`,status:"ACTIVE"}))];
    return async (path: string, method = "GET") => {
      if (kind === "sharing" && path.includes("/members")) {
        if (method === "DELETE") {
          members = members.filter(member => !path.endsWith(`/${member.userId}`));
          return {};
        }
        if (method === "GET") return {members};
      }
      const result = await knowledgeLimitPreviewRequest(path, method, plan);
      if (path === "/settings" && kind !== "count") {
        const settings = result as {bases: Array<unknown>};
        return {...settings,bases:settings.bases.slice(0,3)};
      }
      return result;
    };
  }, [kind, plan]);
  const failedUpload = <ul className="mk-flist" aria-label={text("未上传文件", "File not uploaded")}>
    <li className={`mk-frow ${styles.failedUpload}`}>
      <span className="mk-fic" aria-hidden="true">PDF</span>
      <div className="mk-fmeta">
        <div className="mk-fname">{text("用户访谈资料.pdf", "user-interviews.pdf")}</div>
        <div className="mk-fsub">{text("98 MB · 可用空间 0 MB", "98 MB · 0 MB available")}</div>
      </div>
      <span className="mk-fstatus mk-dot-fail"><span className="mk-sdot" />{text("上传失败，空间不足", "Upload failed · insufficient storage")}</span>
    </li>
  </ul>;
  return <AppFrame title={text("知识库", "Knowledge")}><KnowledgeManagement language={language} connection={{baseUrl:"http://127.0.0.1",localToken:""}} request={previewRequest}
    limitPreview={kind === "sharing" ? {kind,maxMembers:plan === "pro" ? 10 : 5} : undefined}
    storagePreview={kind === "storage" ? plan === "pro"
      ? {byBase:{"sample-kb-0":"20.20 GB","sample-kb-1":"15.10 GB","sample-kb-2":"14.76 GB"},totalUsed:"50.06 GB",totalLimit:"50 GB",exceeded:true}
      : {byBase:{"sample-kb-0":"4.20 GB","sample-kb-1":"3.10 GB","sample-kb-2":"2.76 GB"},totalUsed:"10.06 GB",totalLimit:"10 GB",exceeded:true} : undefined}
    fileNotice={kind === "storage" ? failedUpload : undefined}/></AppFrame>;
}
