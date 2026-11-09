import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { CreditApplicationRoles, CreditApplicationUseCases, CreditApplicationFrequencies, CreditsApplicationRequestSchema, type CreditsApplicationRequest } from "@memmy/local-api-contracts";
import { Modal } from "../components/modal.js";
import { Button } from "../components/button.js";
import { useOptionalApiClients } from "../app/providers.js";
import { useTranslation } from "../i18n/use-translation.js";
import styles from "./credit-application-modal.module.css";

type Answers = CreditsApplicationRequest["answers"];
type Field = Exclude<keyof Answers, "additionalContact">;
const orders: Record<CreditsApplicationRequest["formType"], Field[]> = {
  CN_ZH: ["usageFrequency", "useCases", "upgradeReason", "organization", "role"],
  CN_EN: ["role", "useCases", "organization", "usageFrequency", "upgradeReason"],
  INTL_ZH: ["upgradeReason", "useCases", "usageFrequency", "organization", "role"],
  INTL_EN: ["upgradeReason", "useCases", "role", "organization", "usageFrequency"]
};
const copy = {
  "zh-CN": {
    title: "Memmy 进阶版申请", intlTitle: "Memmy 海外 Pro 版申请", close: "关闭", submit: "提交申请", submitting: "正在提交…",
    intro: "请填写你的使用需求。提交后将核对当前登录账号，并自动开通进阶版。",
    organization: "组织名称", role: "职业或岗位", useCases: "主要使用场景", upgradeReason: "希望通过升级解决什么问题", usageFrequency: "预计使用频率",
    organizationNote: "公司、学校或团队名称；个人用户可填写“个人”。", roleNote: "选择最接近你当前工作的选项。", useCasesNote: "可多选。", upgradeReasonNote: "请描述你计划用 Memmy 完成的任务，以及当前积分或知识库额度是否限制了使用。", usageFrequencyNote: "按预计使用情况选择即可。",
    roles: ["产品 / 运营", "研发 / 技术", "科研 / 教育", "法律 / 专业服务", "管理 / 创业", "其他"],
    cases: ["资料整理与知识管理", "写作与办公", "调研与信息分析", "代码开发", "法律与专业工作", "学习与科研", "其他"],
    frequencies: ["每天使用", "每周几次", "偶尔使用", "正在评估"], placeholder: "请输入…", required: "请填写组织名称、升级需求，并选择至少一个使用场景。", error: "提交未完成，请重试。", preview: "请登录账号后提交申请。"
  },
  "en-US": {
    title: "Memmy Plus application (China)", intlTitle: "Memmy Pro application (International)", close: "Close", submit: "Submit application", submitting: "Submitting…",
    intro: "Tell us how you plan to use Memmy. We will verify your signed-in account and activate Pro after submission.",
    organization: "Organization", role: "Role", useCases: "Main use cases", upgradeReason: "What would an upgrade help you do?", usageFrequency: "Expected usage frequency",
    organizationNote: "Enter Personal if you are applying as an individual.", roleNote: "Choose the option closest to your current role.", useCasesNote: "Select all that apply.", upgradeReasonNote: "Describe your plans and any current credit or storage limits.", usageFrequencyNote: "Select your expected usage frequency.",
    roles: ["Product / Operations", "Engineering", "Research / Education", "Legal / Professional services", "Management / Founder", "Other"],
    cases: ["Knowledge management", "Writing and office work", "Research and analysis", "Software development", "Legal and professional work", "Learning and education", "Other"],
    frequencies: ["Daily", "A few times a week", "Occasionally", "Still evaluating"], placeholder: "Please enter…", required: "Enter your organization and upgrade needs, and select at least one use case.", error: "Could not submit. Please try again.", preview: "Sign in to submit an application."
  }
};

export function CreditApplicationModal({ formType, live, onClose, onSuccess }: {
  formType: CreditsApplicationRequest["formType"]; live: boolean; onClose: () => void; onSuccess: () => void;
}) {
  const { language } = useTranslation();
  const words = copy[language];
  const { clients } = useOptionalApiClients();
  const [answers, setAnswers] = useState<Answers>({ organization: "", role: "", useCases: [], upgradeReason: "", usageFrequency: "", additionalContact: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ fingerprint: string; id: string } | null>(null);
  const submitting = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const overflow = document.body.style.overflow;
    const previous = document.activeElement;
    document.body.style.overflow = "hidden";
    return () => { alive.current = false; document.body.style.overflow = overflow; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const close = () => { if (!submitting.current) onClose(); };
  async function submit() {
    if (submitting.current) return;
    if (!live || !clients?.credits) { setError(words.preview); return; }
    const fingerprint = JSON.stringify({ formType, answers });
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, id: crypto.randomUUID() };
    const parsed = CreditsApplicationRequestSchema.safeParse({ requestId: pending.current.id, formType, formVersion: "v1", answers });
    if (!parsed.success) { setError(words.required); return; }
    submitting.current = true; setBusy(true); setError(null);
    try {
      const result = await clients.credits.submitApplication(parsed.data);
      if (!alive.current) return;
      if (result.status !== "APPROVED" || result.plan !== "PRO") throw new Error(words.error);
      onSuccess();
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : words.error);
    } finally { submitting.current = false; if (alive.current) setBusy(false); }
  }
  const requiredFields: Field[] = ["organization", "useCases", "upgradeReason"];
  return createPortal(<Modal open title={formType.startsWith("INTL") ? words.intlTitle : words.title} subtitle={words.intro}
    closeLabel={words.close} closeDisabled={busy} onClose={close} className={styles.modal} bodyClassName={styles.body}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }} aria-busy={busy}>
      {orders[formType].map((field, index) => {
        const required = requiredFields.includes(field);
        const options = field === "role" ? CreditApplicationRoles : field === "usageFrequency" ? CreditApplicationFrequencies : field === "useCases" ? CreditApplicationUseCases : null;
        const labels = field === "role" ? words.roles : field === "usageFrequency" ? words.frequencies : words.cases;
        const heading = <><span className={styles.number}>{String(index + 1).padStart(2, "0")}</span>{words[field]}{required && <span className={styles.required} aria-hidden="true"> *</span>}</>;
        const note = words[`${field}Note`];
        if (options) return <fieldset key={field} className={styles.question} disabled={busy} aria-required={required} aria-describedby={`upgrade-${field}-note`}>
          <legend>{heading}</legend><p id={`upgrade-${field}-note`}>{note}</p>
          <div className={styles.options}>{options.map((value, optionIndex) => <label key={value} className={styles.option}>
            <input type={field === "useCases" ? "checkbox" : "radio"} name={field} value={value}
              checked={field === "useCases" ? answers.useCases.includes(value as Answers["useCases"][number]) : answers[field] === value}
              onChange={event => setAnswers(current => field === "useCases" ? { ...current, useCases: event.target.checked ? [...current.useCases, value as Answers["useCases"][number]] : current.useCases.filter(item => item !== value) } : { ...current, [field]: value })} />{labels[optionIndex]}
          </label>)}</div>
        </fieldset>;
        return <div key={field} className={styles.question}>
          <label htmlFor={`upgrade-${field}`}>{heading}</label><p id={`upgrade-${field}-note`}>{note}</p>
          {field === "upgradeReason" ? <textarea id={`upgrade-${field}`} aria-describedby={`upgrade-${field}-note`} value={answers[field]} required rows={6} maxLength={4000} disabled={busy} placeholder={words.placeholder} onChange={event => setAnswers(current => ({ ...current, upgradeReason: event.target.value }))} />
            : <input id={`upgrade-${field}`} aria-describedby={`upgrade-${field}-note`} value={answers[field]} required={required} maxLength={200} disabled={busy} placeholder={words.placeholder} onChange={event => setAnswers(current => ({ ...current, [field]: event.target.value }))} />}
        </div>;
      })}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <div className={styles.actions}><Button type="submit" variant="primary" disabled={busy}>{busy ? words.submitting : words.submit}</Button></div>
    </form>
  </Modal>, document.body);
}
