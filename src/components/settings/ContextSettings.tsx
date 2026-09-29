import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { Textarea } from "../ui/textarea";
import {
  GENERAL_CONTEXT_MAX_CHARS,
  DICTATION_CONTEXT_MAX_CHARS,
} from "../../helpers/userContextBlock.js";

interface ContextFieldProps {
  label: string;
  description: string;
  placeholder: string;
  help: string;
  maxChars: number;
  value: string;
  onCommit: (value: string) => void;
}

function ContextField({
  label,
  description,
  placeholder,
  help,
  maxChars,
  value,
  onCommit,
}: ContextFieldProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const pending = useRef({ draft, value, onCommit });
  pending.current = { draft, value, onCommit };
  // Not redundant with onBlur: closing Settings unmounts the field without
  // firing blur, so without this the user's last typing is silently lost.
  useEffect(
    () => () => {
      const { draft: latest, value: committed, onCommit: commit } = pending.current;
      if (latest !== committed) commit(latest);
    },
    []
  );

  return (
    <div className="space-y-2">
      <div>
        <label className="text-xs font-semibold text-foreground tracking-tight">{label}</label>
        <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
      </div>
      <Textarea
        value={draft}
        maxLength={maxChars}
        placeholder={placeholder}
        rows={6}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft)}
      />
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-muted-foreground/80 leading-relaxed">{help}</p>
        <span className="text-xs text-muted-foreground/60 whitespace-nowrap tabular-nums">
          {t("settingsPage.context.counter", { count: draft.length, max: maxChars })}
        </span>
      </div>
    </div>
  );
}

export default function ContextSettings() {
  const { t } = useTranslation();
  const generalContext = useSettingsStore((s) => s.generalContext);
  const dictationContext = useSettingsStore((s) => s.dictationContext);
  const setGeneralContext = useSettingsStore((s) => s.setGeneralContext);
  const setDictationContext = useSettingsStore((s) => s.setDictationContext);

  return (
    <div className="space-y-6">
      <ContextField
        label={t("settingsPage.context.general.label")}
        description={t("settingsPage.context.general.description")}
        placeholder={t("settingsPage.context.general.placeholder")}
        help={t("settingsPage.context.general.help")}
        maxChars={GENERAL_CONTEXT_MAX_CHARS}
        value={generalContext}
        onCommit={setGeneralContext}
      />
      <ContextField
        label={t("settingsPage.context.dictation.label")}
        description={t("settingsPage.context.dictation.description")}
        placeholder={t("settingsPage.context.dictation.placeholder")}
        help={t("settingsPage.context.dictation.help")}
        maxChars={DICTATION_CONTEXT_MAX_CHARS}
        value={dictationContext}
        onCommit={setDictationContext}
      />
    </div>
  );
}
