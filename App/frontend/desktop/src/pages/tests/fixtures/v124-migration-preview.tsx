import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { PluginUiProvider, type PluginUiCall } from "../../../app/plugin-ui-context.js";
import { AgentThreadMessages } from "../../agent-thread-messages.js";
import { PluginCapabilityHost } from "../../plugin-capability-host.js";
import { PluginMarketplaceSection } from "../../plugin-marketplace-section.js";
import type { AgentChatMessage } from "../../../state/agent-chat-slice.js";
import "../../../styles.css";
import "../../conversation-features.css";
import "../../plugin-marketplace.css";

const question = { version: 1, requestId: "preview-question", title: "确认报告范围", questions: [
  { id: "scope", prompt: "这次报告需要覆盖哪些范围？", options: [{ id: "risk", label: "风险与整改建议" }, { id: "full", label: "完整诊断与制度建议" }], allowOther: true, allowMultiple: false }
] };
const legalCall: PluginUiCall = { pluginId: "legal-labor", capabilityId: "gap-resolve", callId: "preview-legal", conversationId: "preview", origin: "agent",
  events: [{ type: "interaction", request: { interactionId: "region", type: "question", payload: { title: "确认参保地", questions: [
    { id: "city", label: "企业实际参保地是哪里？", options: ["上海", "北京", "其他地区"], required: true }
  ] } } }] };
function Preview() {
  const [tab,setTab] = useState("通用提问");
  const [messages,setMessages] = useState<AgentChatMessage[]>([
    { id: "u", role: "user", content: "根据材料整理一份用工诊断报告。", turnId: "t" },
    { id: "reason", role: "assistant", kind: "trace", content: "", reasoning: "先检查材料，再确认报告范围。", turnId: "t", isStreaming: true },
    { id: "question", role: "assistant", content: "", agentUi: { questionCard: question }, turnId: "t", isStreaming: true }
  ]);
  const [answered,setAnswered] = useState(false);
  const [calls,setCalls] = useState([legalCall]);
  return <main style={{maxWidth:960,margin:"0 auto",padding:"28px 24px",minHeight:"100vh"}}>
    <h1 style={{fontSize:22,fontWeight:600}}>1.2.4 功能迁移 · 组件验收</h1>
    <p style={{fontSize:13,opacity:.65,margin:"8px 0 20px"}}>使用实际组件和测试数据；此页不连接账号、插件服务或麦克风。</p>
    <nav style={{display:"flex",gap:12,marginBottom:28}}>{["通用提问","法律提问","插件商店"].map(name => <button key={name} onClick={()=>setTab(name)} style={{padding:"8px 16px",borderRadius:8,border:"1px solid #d8d2c9",background:tab===name?"#eae4da":"white"}}>{name}</button>)}</nav>
    {tab === "通用提问" ? <AgentThreadMessages chatScopeKey="preview" messages={messages} isSending={!answered}
      onAnswerQuestion={async (_card,response) => {setAnswered(true);setMessages(current=>[...current.map(message=>({...message,isStreaming:false,...(message.id==="question"?{questionResponse:response}:{})})),{id:"done",role:"assistant",content:"已收到你的选择。后续步骤继续沿用 1.2.4 的过程展示。",turnId:"t"}]);return true;}} /> : null}
    {tab === "法律提问" ? <PluginCapabilityHost calls={calls} plugins={[]} region="pinned" dockInteractions client={{getUi:async()=>"",cancel:async()=>{},respond:async()=>setCalls([])}} /> : null}
    {tab === "法律提问" && calls.length===0 ? <p role="status">测试回答已提交。</p> : null}
    {tab === "插件商店" ? <PluginMarketplaceSection plugins={[
      {id:"legal-labor",name:"法律插件",description:"用工风险诊断、访谈录音与报告交付",category:"legal",version:"0.1.6",installable:true},
      {id:"literature-review",name:"文献综述",description:"检索文献、确认研究范围与综述交付",category:"research",version:"1.0.0",installable:true}
    ]} officialModelReady signedIn onInstall={()=>{}} onUpdate={()=>{}} onUninstall={()=>{}} onEnable={()=>{}} onAddToChat={()=>{}} onConfigureModel={()=>{}} onRefresh={()=>{}} /> : null}
  </main>;
}
createRoot(document.getElementById("root")!).render(<I18nProvider language="zh-CN"><PluginUiProvider><Preview /></PluginUiProvider></I18nProvider>);
