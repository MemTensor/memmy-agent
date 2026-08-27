/** Nickname modal module. */
import { Shuffle } from "lucide-react";
import { Memmy } from "./mascot/memmy.js";
import { useTranslation } from "../i18n/use-translation.js";

export interface NicknameModalProps {
  open: boolean;
  nickname: string;
  onNicknameChange: (value: string) => void;
  onShuffle: () => void;
  onSubmit: () => void;
}

export function NicknameModal(props: NicknameModalProps) {
  const { t } = useTranslation();

  if (!props.open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas-oat px-4">
      <div className="w-full max-w-sm bg-background-paper rounded-card-lg shadow-lg border border-border-stone/60 overflow-hidden">
        <div className="px-7 pt-6 pb-2 text-center">
          <div className="flex justify-center -mb-4">
            <Memmy pose="blush" size={96} className="memmy-bob" />
          </div>
          <h2 className="text-lg font-bold text-text-ink">{t("login.nicknameSlogan")}</h2>
        </div>

        <div className="px-7 pb-8">
          <div className="relative mt-4">
            <input
              type="text"
              autoFocus
              placeholder={t("login.nicknamePlaceholder")}
              value={props.nickname}
              onChange={(event) => props.onNicknameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  props.onSubmit();
                }
              }}
              maxLength={32}
              className="w-full px-1 py-2.5 pr-10 border-b border-border-stone/50 rounded-none bg-transparent text-sm focus:outline-none placeholder:text-text-ink/35"
            />
            <button
              type="button"
              onClick={props.onShuffle}
              title={t("login.luckyName")}
              aria-label={t("login.luckyName")}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-text-ink/30 hover:text-action-sky transition-colors cursor-pointer"
            >
              <Shuffle size={16} />
            </button>
          </div>

          <button
            type="button"
            onClick={props.onSubmit}
            className="w-full mt-6 py-2.5 bg-action-sky text-white font-normal rounded-btn hover:bg-action-sky-hover transition-all cursor-pointer active:scale-[0.98]"
          >
            {t("login.nicknameStart")}
          </button>
        </div>
      </div>
    </div>
  );
}
