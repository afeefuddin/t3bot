# Run t3bot

t3bot is a private, single-owner hosted assistant. `apps/bot` owns conversations,
memory, responsibilities, and durable jobs. The bot runs general tools and internal
workers in its own hosted workspace. Paired T3 servers execute project tasks. The existing T3
clients provide the interface.

## Local development

Use the repository's supported Node version and install with `vp i`. Copy
`apps/bot/config.example.json` to a private config file. Remove unused provider
entries, set real endpoints/models, and list each allowed T3 client origin
(scheme, host, and port). Endpoint URLs are complete API URLs. For Codex models,
set `api` to `responses` and use the provider's `/v1/responses` endpoint. The
optional `reasoningEffort` is `low`, `medium`, or `high`; omit it for a model
that does not support it. t3bot calls the model directly and owns the tool loop,
memory, task dispatch, and background jobs. It saves tool decisions and opaque
reasoning continuation data locally so work can resume after a restart without
depending on a provider-hosted conversation. Responses requests use `store: false`. Set `webSearch: true` on a Responses
provider that supports native web search (or the Codex CLI adapter) to enable
general live lookups; leave it off for endpoints without that capability.

Other OpenAI-compatible providers can use `api: "chat_completions"` (the default
when `api` is omitted) with a complete `/v1/chat/completions` URL and a model
supporting function tools. Set `maxTokensField` to
`max_tokens` on providers that use that spelling instead of
`max_completion_tokens`. That setting applies only to Chat Completions.

Set the credential environment variables named by `apiKeyEnv` (omit that field
for an endpoint that requires no authentication); API credentials
are never sent to clients or written to bot memory. Multiple provider entries
can use different credentials, URLs, and models. Select the coordinator provider
in the client's bot Settings. All configured credential variables must exist at
startup, or remove that provider until it is configured.

The optional CLI compatibility adapter uses a Codex session for each model step.
Prefer the direct Responses configuration above when t3bot should call only the
model. To use the CLI adapter, install Codex on the bot host and authenticate
it there with `codex login` (or its supported API-key configuration). Add a
provider alongside, or instead of, the HTTP entries:

```json
{ "id": "Codex", "type": "codex", "model": "YOUR_CODEX_MODEL" }
```

Set `provider` to `Codex`. The optional `binary` field selects an absolute Codex
executable path. Codex uses the bot host's own login and provider configuration;
a client-side login does not authenticate a remote bot. Each model step runs in
an ephemeral read-only session and returns decisions to t3bot's durable tool
loop, which still owns memory, task dispatch, and retries. Other configured
OpenAI-compatible providers remain selectable.

Start the bot with isolated storage:

```sh
T3BOT_HOME=/absolute/private/bot-home T3BOT_CONFIG=/absolute/private/config.json \
  vp run --filter @t3tools/bot start
```

The service defaults to `127.0.0.1:3780`. Its owner credential is created in
`<T3BOT_HOME>/owner-token` with restrictive permissions. Read that file privately
and enter its value in the existing client's **t3bot → Settings**. Mobile exposes
t3bot from **Settings → Automations**. An explicit `T3BOT_OWNER_TOKEN` overrides
the file; preserve it across restarts because it also derives environment grants.
Never place credentials in URLs or screenshots.

The web/desktop sidebar and command palette open t3bot. Configure its reachable
URL and owner credential. For remote clients use HTTPS through a reverse proxy;
do not use a cloud machine's loopback URL. Bot chat remains available independently
of a laptop execution server.

## Internal execution

Internal workers have separate persisted conversations and do not require a T3
project or executor. General shell tools run unattended as the bot’s operating-system
user under `<T3BOT_HOME>/workspace`. Child workers receive only their explicit task
and supplied context. Their remaining processes stop when the worker finishes.
The main conversation can start its own background processes and receive completion
updates while it remains available.

Worker model steps and completed results survive restarts. A shell operation that
was running during a crash has an unknown outcome and is not automatically rerun;
the bot must inspect its effects first. Completed process receipts retain bounded
output. Project workers use their paired executor’s configured execution ceiling;
select **Full access** for unattended project execution.

## Pair an executor

For an environment already connected to your client, use **t3bot → Settings →
Connect your projects**. Select explicit projects and the execution ceiling. This
stores the private bridge token in that T3 server's secret store; public connection
status omits it. Settings permission is required at the destination. Updates take
effect without restarting the server. Disconnect persists across restarts, including
when older environment-variable configuration is still present.

For headless or manual setup, create an environment grant in bot Settings.
On that T3 server, configure the returned
bridge ID/token and the bot URL. Also set an explicit project allowlist (comma
separated project IDs, or `*` to authorize all projects) and execution ceiling:

```text
T3BOT_URL=https://your-bot-host
T3BOT_BRIDGE_ID=<returned environment grant ID>
T3BOT_BRIDGE_TOKEN=<returned credential>
T3BOT_BRIDGE_PROJECT_IDS=<project IDs or *>
T3BOT_BRIDGE_MODE=approval-required
```

Restart that server. It connects outward to the bot, so a laptop does not need a
public inbound port. The bridge advertises its available worker providers,
models, supported options, and up to 30 recent authorized thread summaries so
t3bot can choose context and workers for each goal. Summaries contain at most
1,600 characters of the latest visible message per thread. Project
defaults are optional. Older executors without a worker catalogue still need a
project default or `T3BOT_BRIDGE_INSTANCE_ID`/`T3BOT_BRIDGE_MODEL` as a fallback.
Provider binaries and credentials must be available on the executor. Existing
T3 providers remain responsible for their capabilities and approvals.

Use `full-access` only when you intend unattended execution under that grant.
Provider permission questions are handled in the underlying T3 thread. A bot's
accepted task can still be waiting for approval. Opening its thread requires
the client's own authorized connection to the actual execution environment.

Revoke a grant in bot Settings to block further bridge commands. An accepted
task may still be running: cancel it while the executor is reachable before
revoking if it must stop. Pausing a responsibility prevents future dispatches;
cancelling an existing task is separate. Restoring an archived responsibility
does not replay every missed occurrence.

## Hosted deployment

`apps/bot/compose.yaml` runs the bot and its isolated T3 executor with separate
persistent volumes. Copy the example config to `apps/bot/config.json`, configure
provider credentials in your deployment's private environment, and set
`T3BOT_BRIDGE_MODEL` to a supported worker model. The example executor installs
a pinned Codex CLI; the Docker build's `WORKER_PACKAGE` argument can select a
different installed provider package, with matching instance/model configuration.
Configure the provider's own credentials separately from the coordinator.
The bot image also includes Codex. For a Codex coordinator, authenticate inside
the bot container; `bot-provider` persists its separate login. An HTTP-only
coordinator does not require a Codex login.

```sh
docker compose -f apps/bot/compose.yaml up --build -d
```

Expose both services through your HTTPS/private-network ingress as needed.
Compose publishes ports on loopback. Copy the generated owner credential
privately from `/data/bot/owner-token`, connect the T3 client, create the cloud
environment grant, then set `T3BOT_BRIDGE_ID`/`T3BOT_BRIDGE_TOKEN` and recreate
the executor. Its `/workspace` Git project is initialized automatically.
For subscription sign-in, use the provider CLI inside the executor; its state
has its own persistent volume. Neither bot nor executor needs access to the
container host's control socket.

Keep one bot replica with its SQLite volume. `/health` becomes available after
database initialization. Failed/retrying background jobs appear in Activity.
The bot records work before dispatch and reconciles commands after reconnect;
it cannot guarantee exactly-once arbitrary external side effects.

## Backup and restore

Use SQLite's online backup, which includes committed WAL contents:

```sh
T3BOT_HOME=/absolute/private/bot-home \
  node apps/bot/src/main.ts backup /absolute/private/backup.sqlite
```

Keep backups and the owner credential private. Restore with the bot stopped:
restore `bot.sqlite` into an empty bot home, restore the same owner credential,
and keep configuration/provider secrets separately. Do not combine a restored
main database with WAL/SHM files from another instance. Preserve executor T3
state, secret store, and workspace as well; the bot's database contains references to their
threads, not copies of their files. Reconcile executors after restoring an old
backup before permitting fresh dispatches. Test restoration in an isolated home.

## Slack and Telegram connections

Messaging connections use the same personal bot conversation, memory, coordinator
provider, and authorized executors as the T3 clients. Add entries to the config's
optional `connectors` array, supply the named secrets in the bot process environment,
and restart the bot. Use separate connector IDs for separate apps/workspaces.
The IDs below give webhook paths `/connectors/slack` and `/connectors/telegram`:

```json
{
  "connectors": [
    {
      "id": "slack",
      "name": "My Slack",
      "type": "slack",
      "botTokenEnv": "SLACK_BOT_TOKEN",
      "signingSecretEnv": "SLACK_SIGNING_SECRET",
      "teamId": "T_YOUR_WORKSPACE",
      "allowedUserIds": ["U_YOUR_ACCOUNT"],
      "allowedChannelIds": []
    },
    {
      "id": "telegram",
      "name": "My Telegram",
      "type": "telegram",
      "botTokenEnv": "TELEGRAM_BOT_TOKEN",
      "webhookSecretEnv": "TELEGRAM_WEBHOOK_SECRET",
      "allowedUserIds": ["YOUR_NUMERIC_USER_ID"],
      "allowedChatIds": ["YOUR_NUMERIC_PRIVATE_CHAT_ID"]
    }
  ]
}
```

This is a fragment to merge into your existing provider configuration. Remove
unused entries: every configured credential variable must exist at startup.
Compose forwards the four example secret variables; custom variable names need
matching deployment environment entries. Keep credentials in private deployment
configuration, never in chat messages. Expose the bot through HTTPS and forward
the raw webhook body and signing headers unchanged.

For Slack, create a Slack app with bot scopes `chat:write`, `im:history`, and
`app_mentions:read`, install it in the configured workspace, and supply its bot
token and Signing Secret. Enable Events API subscriptions `message.im` and
`app_mention`; set the Request URL to your bot's `/connectors/slack` endpoint.
Enable the app's Messages tab so the owner can send DMs. URL verification and
event requests are authenticated with Slack's signing secret and timestamp.
See [Slack request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
and [Events API setup](https://docs.slack.dev/apis/events-api/).

DM the app to prompt it. For channel use, explicitly allow each channel ID, invite
the app, and mention it in each prompt or thread follow-up. Replies stay in the
originating Slack thread. Channel members can see those replies; the bot still
uses its shared personal conversation and memory, so authorize channels
accordingly. Other workspace users, unrelated channel traffic, bot messages,
edits, and file-only events do not initiate work.

For Telegram, create a bot with BotFather, start a private chat, and get your
numeric `from.id` and `chat.id` from `getUpdates` before registering a webhook.
Store those IDs as strings in the allowlists. Generate a separate 24–256 character
URL-safe webhook secret and set `TELEGRAM_WEBHOOK_SECRET`. Register the webhook
from a private shell, with `T3BOT_PUBLIC_URL` set to the reachable HTTPS bot origin:

```sh
node --input-type=module <<'JS'
const response = await fetch(
  `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `${process.env.T3BOT_PUBLIC_URL}/connectors/telegram`,
      secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message"]
    })
  }
);
const result = await response.json();
if (!result.ok) throw new Error("Telegram webhook registration failed");
console.log("Telegram webhook registered");
JS
```

This connector accepts text from the allowlisted owner in private chats; groups,
channels, bot messages, attachments, and edited messages are ignored. Replies
reference the original Telegram message and use plain text. Details:
[Telegram webhooks and Bot API](https://core.telegram.org/bots/api#setwebhook).

Bot Settings shows each configured connection's webhook path, queued/failed
replies, and pause/resume control. Pause blocks new prompts and holds queued
deliveries; resume releases them. It cannot retract a request already in flight.
Activity exposes failed delivery jobs with Retry. Fix credentials, app membership,
or permissions before retrying. Removing a config entry also stops new ingress
and delivery for that connector; restoring the same ID resumes its retained queue.

Incoming events are acknowledged after the message, reply destination, and
coordinator job commit together. Platform retries do not create duplicate bot
turns. Replies, questions, task results, and responsibilities created through a
connector retain their destination across restarts. The outbox retries transient
failures with backoff and honors rate limits; long replies are split into ordered
text chunks. Delivery is at least once: a lost acknowledgement from a messaging
API can produce a duplicate external reply. The connectors require owner app
credentials; they do not provide a public OAuth installation flow.
