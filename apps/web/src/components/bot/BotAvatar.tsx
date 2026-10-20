import { useState } from "react";
import { DEFAULT_BOT_AVATAR, type BotAvatar } from "@t3tools/contracts/bot";
import {
  botAvatarSvg,
  BOT_AVATAR_COLORS,
  BOT_AVATAR_COLOR_NAMES,
  BOT_AVATAR_PARTS,
} from "@t3tools/client-runtime/bot-avatar";
import { Button } from "~/components/ui/button";

export function BotAvatarImage({
  avatar,
  size = 32,
}: {
  avatar: BotAvatar | undefined;
  size?: number;
}) {
  return (
    <img
      src={`data:image/svg+xml,${encodeURIComponent(botAvatarSvg(avatar))}`}
      width={size}
      height={size}
      alt="t3bot avatar"
      className="shrink-0"
    />
  );
}

export function BotAvatarDesigner({
  avatar,
  save,
}: {
  avatar: BotAvatar;
  save: (avatar: BotAvatar | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(avatar);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(avatar);
  const change = (next: BotAvatar) => {
    setDraft(next);
    setSaved(false);
  };
  const submit = async (value: BotAvatar | null) => {
    setSaving(true);
    const success = await save(value);
    setSaving(false);
    if (success) {
      setDraft(value ?? DEFAULT_BOT_AVATAR);
      setSaved(true);
    }
  };
  return (
    <section aria-label="Bot avatar designer" className="space-y-5 rounded-lg border p-4">
      <div className="flex items-center gap-4">
        <BotAvatarImage avatar={draft} size={80} />
        <div className="space-y-1">
          <h2 className="font-medium">Make t3bot yours</h2>
          <p className="text-sm text-muted-foreground">
            Design the face you’ll see in this bot’s header and messages.
          </p>
        </div>
      </div>
      <fieldset disabled={saving} className="space-y-4">
        <legend className="sr-only">Avatar features</legend>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Color</legend>
          <div className="flex flex-wrap gap-2">
            {BOT_AVATAR_COLOR_NAMES.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`${color} avatar color`}
                aria-pressed={draft.color === color}
                onClick={() => change({ ...draft, color })}
                style={{ backgroundColor: BOT_AVATAR_COLORS[color] }}
                className="size-9 cursor-pointer rounded-full border-2 border-transparent outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:border-foreground aria-pressed:ring-2 aria-pressed:ring-inset aria-pressed:ring-ring disabled:cursor-default disabled:opacity-50"
              />
            ))}
          </div>
        </fieldset>
        {BOT_AVATAR_PARTS.map((part) => (
          <fieldset key={part.key} className="space-y-2">
            <legend className="text-sm font-medium">{part.label}</legend>
            <div className="flex flex-wrap gap-2">
              {part.choices.map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={draft[part.key] === value ? "secondary" : "outline"}
                  aria-label={`${part.label}: ${value}`}
                  aria-pressed={draft[part.key] === value}
                  onClick={() => change({ ...draft, [part.key]: value })}
                >
                  {value.charAt(0).toUpperCase() + value.slice(1)}
                </Button>
              ))}
            </div>
          </fieldset>
        ))}
        <Button
          variant="outline"
          size="sm"
          aria-pressed={draft.antenna}
          onClick={() => change({ ...draft, antenna: !draft.antenna })}
        >
          Antenna {draft.antenna ? "on" : "off"}
        </Button>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={saving || !dirty} onClick={() => void submit(draft)}>
          {saving ? "Saving…" : "Save avatar"}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={() => void submit(null)}>
          Reset to default
        </Button>
        <span role="status" className="text-xs text-muted-foreground">
          {dirty ? "Unsaved changes" : saved ? "Avatar saved" : "Saved on your bot"}
        </span>
      </div>
    </section>
  );
}
