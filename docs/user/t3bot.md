# t3bot

t3bot is your persistent assistant inside T3 Code. You can keep talking to it
while it works in its hosted workspace or coordinates a connected computer.

Open **t3bot** from the sidebar or command palette. On mobile, open
**Settings → Automations → t3bot**. In the bot's Settings, enter the bot URL and
owner credential supplied by whoever operates your instance. Select one of the
configured coordinator providers. Operators can follow the
[hosting guide](../operations/t3bot.md).

Customize your bot’s avatar in **t3bot → Settings**. Preview a design and save it
to use it in the header and bot messages across T3 Code clients. You can reset
it to the default at any time.

## Give it work

You can also prompt t3bot by messaging its configured Slack app or Telegram bot.
Slack supports DMs and mentions in explicitly authorized channels; Telegram
supports private text chats. Replies and task updates return to the originating
chat. These messages appear in the same bot conversation in T3 Code.
Your operator must configure the connection and allow your account first.
Bot Settings shows connections and lets you pause/resume them; failed replies
appear in Activity with Retry. See the hosting guide for connection setup.

Ask for a bounded outcome, such as “Research these alternatives in your cloud
workspace and give me a concise comparison.” To work locally, name the connected
environment and project. Tasks appear in Activity with their execution location,
progress, and result. Open a task's T3 thread to inspect the agent's work or handle
provider approvals. Your client needs its own connection to that environment.

t3bot chooses the worker provider, model, supported model options, prompt, and
planning mode from the connected environment's available choices. Name a model
when you have a preference; otherwise it decides. Projects do not need a default
model when the environment advertises its worker catalogue.

Tasks wake t3bot when they finish, need input, or lose and regain their execution
environment. Quiet tasks get a progress review after five minutes, with increasing
intervals between further checks. You can ask for a different check interval or
to stop timed checks. The bot can continue work in the existing thread, ask you
for missing information, or remain silent when there is no useful update. These
checks survive bot restarts. Updates appear here and return to the originating
Slack or Telegram chat when that connection is configured.

You can ask t3bot to send follow-up instructions or cancel a task. Cancellation
remains pending until the executor confirms the outcome. Closing the client does
not stop hosted work. Work requiring an offline computer waits for that computer;
it does not silently move to another machine.

To investigate existing threads, ask t3bot to delegate that investigation to the
appropriate environment and project. The worker uses the environment's T3 tools.

## Remember preferences

Say “Remember that I prefer concise reports,” or let automatic memory capture
save durable preferences. Inspect, correct, or forget notes in Memory. Automatic
capture can be disabled in bot Settings. Project/environment notes apply to their
own context; they are not global preferences.

Forgetting a curated note removes it from active memory. It does not erase the
original conversation. Configure credentials privately with your operator rather
than asking the bot to remember them.

## Give it a responsibility

For example: “Each weekday at 9 in Asia/Kolkata, review this project's active work
and tell me what needs attention.” Work that runs on an executor is bound to an
environment and project; a reminder can run in the bot conversation.

Activity lets you run a responsibility now, pause/resume it, or archive/restore
it. Ask in chat to edit its instructions or schedule. Pausing prevents future
dispatches; cancel an already running task separately. Missed recurring checks
are coalesced rather than replayed once for every missed interval.

## Control access and recover work

Pair execution environments from bot Settings and configure the returned grant
on the destination T3 server. Revoke a grant there to block further commands.
Stop any running work first if it must finish before access is removed.

Results and questions remain in the conversation after reconnecting. Failed
background jobs are visible in Activity with a retry action. A task being
accepted means its request was saved, not that its work has finished.
