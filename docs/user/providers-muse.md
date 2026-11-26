# Muse Code

Muse Code is disabled by default. Install
[Muse Code](https://dev.meta.ai/docs/muse-code) on the machine hosting your
environment, then run `muse login` as the account that runs p0code.

## Set up Muse Code

1. Install Muse Code on the server machine and run `muse login` as the user running T3 Code.
2. Open **Settings → Providers**, select the environment, enable **Muse Code** (set **Binary path** if not on `PATH`), and refresh provider status.

> Note: Provider status does not verify login—if you are signed out, turns fail until you run `muse login` on the host.

p0code ignores a `META_API_KEY` that the T3 server inherits from its own
environment, so Muse uses the credential saved on the host by `muse login`. To
use an API key instead, add `META_API_KEY` to the Muse instance's environment
variables in **Settings → Providers**. Muse gives that key priority over the
saved login.

## Models, permissions, and limitations

Connect from web, desktop, or mobile through [remote access](./remote-access.md).
Muse uses the selected environment's files and login; connecting devices do not
need Muse installed. Install and sign in separately on each host where you want
Muse to run.

Add a provider instance for a separate configuration. Instances on the same host
share its Muse login; give an instance its own `META_API_KEY` to bill it
separately. Existing conversations retain their instance when its model catalog
becomes unavailable.

## Models

Models and reasoning choices come from Muse on the selected host. After changing
Muse configuration, refresh provider status in **Settings → Providers**. On
mobile, pull down in thread settings to refresh models. If a saved model becomes
unavailable, select an available model before sending another message.

Muse can list models that your account cannot use. If a message fails with
"does not exist or you lack access", pick another model, or add one your account
can use under **Custom models** in the instance settings.

## Permissions and limitations

Muse offers two [permission modes](./permission-modes.md): **Supervised** asks
before commands and edits, and **Full access** runs them without asking. Muse has
no equivalent of **Auto-accept edits** or **Auto**, so they are not offered.

Muse can use p0code's tools. If Muse cannot reach them, the turn continues
without them. Switching providers can pass conversation context as a handoff.

Muse skills do not appear in the composer's `$` menu. Muse still loads them
itself. Manage them with `muse skills` on the host.

Forking a Muse conversation starts a new session with a copy of the conversation
context. Conversation rewind is unavailable.

Install Muse and sign in on the host; in-app installation and sign-in are not
available. Updates can run from **Settings → Providers** when p0code recognizes
the Muse launcher; otherwise update Muse on that host manually.

To stop using Muse in an environment, disable it in **Settings → Providers**.
This keeps the host's Muse login, thread history, and workspace files.
