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

t3bot acknowledges receipt before processing your request. It can send a short update before a lookup and deliver the answer separately. Clear reminders can be set quietly after the acknowledgement; the reminder arrives when due. The acknowledgement confirms receipt, not completion, and failures are reported.

It uses available tools for quick lookups and delegates larger independent work
to internal workers. Those workers use the bot’s hosted workspace and stay out of
your project thread lists. Project-related work runs in the relevant connected project and appears in its thread list, including when it runs in the background. Connecting a machine or VM does not assign unrelated tasks to its projects.
Ask for an independent worker explicitly when you want one.

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

## Connect projects and give it a goal

In **t3bot → Settings → Connect your projects**, choose a connected T3 environment,
select the projects the bot may access, and set its execution permission. Saving
requires permission to change that environment's settings. The destination T3
server remembers the connection across restarts; its machine must be able to
reach the bot URL.

The bot can read recent thread titles, status, models, and bounded message excerpts
from those projects. For a full investigation it delegates to a worker with the
environment's T3 tools. It can continue an idle existing thread or start a new
thread, and chooses from that environment's available worker models.

Ask for an outcome such as “Fix this bug in the connected project; reproduce it
with a regression test and run the relevant existing tests.” t3bot records the
objective and completion criteria as a goal, then coordinates work and a separate
verification turn in the same workspace. A failed check can lead to another repair
and verification pass. Goals and queued reviews survive bot restarts.

Activity shows each goal's criteria, current state, blocking reason, verification
quotes, and worker tasks. Completion requires a passing quote for every criterion
from a completed verification turn, backed by commands the executor recorded as
successful in that run. Missing or unknown exit codes cannot establish completion.
The bot still assesses whether those checks actually prove the criteria; open the
worker's T3 thread to inspect the full output and changes.

Pause a goal to hold new work and reviews, resume it to continue, or cancel it to
stop future dispatches. Running workers continue until separately cancelled.
Reopening a completed goal clears its previous evidence and requires fresh
verification. A goal starts with a budget of 24 worker turns. When further dispatch
would exceed that budget, it blocks and asks for your input. Resuming an exhausted
goal authorizes another 24 turns.

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

Use **Disconnect environment** in project connection settings to stop new dispatches
and revoke its grant. Advanced manual pairing remains available for operators.
Revoke a grant in bot Settings to block further commands.
Stop any running work first if it must finish before access is removed.

Results and questions remain in the conversation after reconnecting. Failed
background jobs are visible in Activity with a retry action. A task being
accepted means its request was saved, not that its work has finished.
