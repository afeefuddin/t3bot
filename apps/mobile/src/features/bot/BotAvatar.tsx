import { useState } from "react";
import { View, Pressable } from "react-native";
import { SvgXml } from "react-native-svg";
import { DEFAULT_BOT_AVATAR, type BotAvatar } from "@t3tools/contracts/bot";
import {
  botAvatarSvg,
  BOT_AVATAR_COLORS,
  BOT_AVATAR_COLOR_NAMES,
  BOT_AVATAR_PARTS,
} from "@t3tools/client-runtime/bot-avatar";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

export function BotAvatarImage({
  avatar,
  size = 32,
}: {
  avatar: BotAvatar | undefined;
  size?: number;
}) {
  return (
    <View accessibilityRole="image" accessibilityLabel="t3bot avatar">
      <SvgXml xml={botAvatarSvg(avatar)} width={size} height={size} />
    </View>
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
  const dirty = JSON.stringify(draft) !== JSON.stringify(avatar);
  const submit = async (value: BotAvatar | null) => {
    setSaving(true);
    if (await save(value)) setDraft(value ?? DEFAULT_BOT_AVATAR);
    setSaving(false);
  };
  return (
    <View className="gap-4 rounded-2xl border border-separator p-4">
      <View className="flex-row items-center gap-3">
        <BotAvatarImage avatar={draft} size={72} />
        <View className="flex-1 gap-1">
          <AppText>Make t3bot yours</AppText>
          <AppText textRole="caption">Design the face you’ll see in your bot’s messages.</AppText>
        </View>
      </View>
      <AppText>Color</AppText>
      <View className="flex-row flex-wrap gap-3">
        {BOT_AVATAR_COLOR_NAMES.map((color) => (
          <Pressable
            key={color}
            accessibilityRole="button"
            accessibilityLabel={`${color} avatar color`}
            accessibilityState={{ selected: draft.color === color, disabled: saving }}
            disabled={saving}
            onPress={() => setDraft({ ...draft, color })}
            className="size-12 items-center justify-center rounded-full"
            style={{ backgroundColor: BOT_AVATAR_COLORS[color] }}
          >
            {draft.color === color && <AppText className="text-white">✓</AppText>}
          </Pressable>
        ))}
      </View>
      {BOT_AVATAR_PARTS.map((part) => (
        <View key={part.key} className="gap-2">
          <AppText>{part.label}</AppText>
          <View className="flex-row flex-wrap gap-2">
            {part.choices.map((value) => (
              <Button
                key={value}
                label={`${value}${draft[part.key] === value ? " · selected" : ""}`}
                tone={draft[part.key] === value ? "primary" : "secondary"}
                accessibilityHint={part.label}
                disabled={saving}
                onPress={() => setDraft({ ...draft, [part.key]: value })}
              />
            ))}
          </View>
        </View>
      ))}
      <Button
        label={`Antenna ${draft.antenna ? "on" : "off"}`}
        disabled={saving}
        onPress={() => setDraft({ ...draft, antenna: !draft.antenna })}
      />
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Save avatar"
          tone="primary"
          disabled={!dirty || saving}
          loading={saving}
          onPress={() => void submit(draft)}
        />
        <Button
          label="Reset to default"
          tone="text"
          disabled={saving}
          onPress={() => void submit(null)}
        />
      </View>
      <AppText textRole="caption">{dirty ? "Unsaved changes" : "Saved on your bot"}</AppText>
    </View>
  );
}
