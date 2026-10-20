import { memo, useLayoutEffect, useRef, type FormEvent } from "react";
import type { BotAvatar, BotMessage } from "@t3tools/contracts/bot";
import type { getBotReplyActivity } from "@t3tools/client-runtime/bot";
import { ArrowUpIcon, Clock3Icon, SlidersHorizontalIcon } from "lucide-react";
import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { BotAvatarImage } from "./BotAvatar";

type ReplyActivity = ReturnType<typeof getBotReplyActivity>;

export const BotMessageRow = memo(function BotMessageRow({
  message,
  avatar,
}: {
  message: BotMessage;
  avatar: BotAvatar | undefined;
}) {
  const time = new Date(message.createdAt);
  if (message.role === "system")
    return (
      <article className="ml-10 flex gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Clock3Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <p className="min-w-0 whitespace-pre-wrap break-words leading-relaxed">{message.text}</p>
      </article>
    );
  const user = message.role === "user";
  return (
    <article className={user ? "ml-auto w-fit max-w-[88%] sm:max-w-[80%]" : "flex gap-3"}>
      {!user && (
        <div className="pt-0.5">
          <BotAvatarImage avatar={avatar} size={28} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className={`mb-2 flex items-center gap-2 text-2xs ${user ? "justify-end" : ""}`}>
          <span className="font-medium text-muted-foreground">{user ? "You" : "t3bot"}</span>
          <time
            className="text-muted-foreground/60"
            dateTime={time.toISOString()}
            aria-label={time.toLocaleString()}
          >
            {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        </div>
        {user ? (
          <p className="rounded-2xl rounded-tr-sm bg-muted/70 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words">
            {message.text}
          </p>
        ) : (
          <ChatMarkdown text={message.text} cwd={undefined} parseRawHtml={false} />
        )}
      </div>
    </article>
  );
});

export function BotReplyProgress({
  activity,
  sending,
  connected,
  avatar,
}: {
  activity: ReplyActivity;
  sending: boolean;
  connected: boolean;
  avatar: BotAvatar | undefined;
}) {
  if (!sending && activity.phase === "idle") return null;
  const label = !connected
    ? "Reconnecting…"
    : sending
      ? "Sending…"
      : activity.phase === "thinking"
        ? "Thinking…"
        : activity.phase === "retrying"
          ? "Waiting to retry…"
          : "Message queued…";
  return (
    <div className="flex items-center gap-3" role="status" aria-live="polite" aria-atomic="true">
      <BotAvatarImage avatar={avatar} size={28} />
      <div className="flex min-h-9 items-center gap-2 text-sm text-muted-foreground">
        <Spinner size="sm" aria-hidden="true" />
        <span>{label}</span>
        {activity.count > 1 && (
          <span className="text-xs text-muted-foreground/60">· {activity.count - 1} queued</span>
        )}
      </div>
    </div>
  );
}

export function BotComposer({
  draft,
  setDraft,
  send,
  sending,
  connected,
  provider,
  onProviderClick,
}: {
  draft: string;
  setDraft: (value: string) => void;
  send: (event: FormEvent) => Promise<void>;
  sending: boolean;
  connected: boolean;
  provider: string;
  onProviderClick: () => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = draft ? "0px" : "";
    if (draft) node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [draft]);
  return (
    <form onSubmit={(event) => void send(event)} className="mx-auto w-full max-w-3xl">
      <div className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm focus-within:border-ring/60">
        <textarea
          ref={textarea}
          aria-label="Message t3bot"
          placeholder="Message t3bot…"
          className="block min-h-15 w-full resize-none bg-transparent px-4 pt-4 pb-2 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground/60 sm:text-sm"
          rows={1}
          maxLength={16000}
          value={draft}
          readOnly={sending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault();
              void send(event);
            }
          }}
        />
        <div className="flex items-center justify-between gap-3 px-3 pb-3">
          <Button
            size="compact"
            variant="ghost"
            onClick={onProviderClick}
            aria-label="Coordinator settings"
          >
            <SlidersHorizontalIcon className="size-3.5" />
            {provider || "Choose a provider"}
          </Button>
          <Button
            type="submit"
            size="icon-lg"
            aria-label={sending ? "Sending message" : "Send message"}
            disabled={!draft.trim() || sending || !connected || !provider}
          >
            {sending ? (
              <Spinner size="md" aria-hidden="true" />
            ) : (
              <ArrowUpIcon className="size-4" />
            )}
          </Button>
        </div>
      </div>
      <div className="mt-2 flex min-h-4 items-center justify-between gap-3 px-1 text-2xs text-muted-foreground/60">
        <span>
          {connected ? "Your personal assistant, ready when you are." : "Reconnecting to your bot…"}
        </span>
        <span className="hidden shrink-0 sm:inline">
          Enter to send <span className="px-1">·</span> Shift + Enter for a new line
        </span>
      </div>
    </form>
  );
}
