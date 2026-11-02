import { Info } from "lucide-react";
import { Tooltip } from "../components/tooltip.js";
import styles from "./settings-token-usage.module.css";

export function CreditInfo(props: { label: string; content: string }) {
  return <Tooltip content={props.content} openOnClick variant="description">
    <button type="button" className={styles.creditInfo} aria-label={props.label}><Info size={14} aria-hidden="true" /></button>
  </Tooltip>;
}
