# Secrets

p0code can read credentials from a secret provider, so the credential stays in your password
manager and p0code saves only a reference to it. Agents can also ask you for a secret in a
private card instead of in the chat.

> Note: **Settings → Secrets** is in preview and may not appear in every build. In-thread secret request cards from agents work everywhere.

## Connect 1Password

1Password is the supported provider. p0code reads secrets with the
[1Password CLI](https://developer.1password.com/docs/cli/) (`op`), so `op` must be installed and
signed in on the machine that runs the p0code server. When you use p0code on another machine or
from your phone, that is the remote machine, not the device in front of you.

1. Open **Settings → Secrets → Add provider** (configured per environment).
2. Enter a name and the 1Password account shorthand, sign-in address (without `https://`), or ID from `op account list`.

## Use secret references

Credential fields in Settings (provider env vars, source control tokens, usage keys, device host tokens) include a source picker: choose **Value** for a literal value or select your 1Password provider and paste a reference like `op://vault/item/field`.

Credential fields in Settings, such as provider environment variables and credentials, source
control tokens, usage limit keys, and device host tokens, show a source picker next to the field.
Pick **Value** to save the credential itself, or pick a secret provider and enter a reference such
as `op://vault/item/field`. Copy the reference from 1Password with **Copy Secret Reference**.
Select the check button next to a reference to read it now. If it reads, providers that use it
start using the new value.

p0code reads the secret when it needs it, for example when a provider starts. Change the
credential in 1Password and refresh to use the new value.

## When a secret cannot be read

If 1Password is locked or signed out, the provider or feature that needs the secret shows an error
naming the secret provider. Unlock 1Password on the server's machine, then select **Refresh** in
**Settings → Providers**. p0code never replaces a saved credential it cannot read with another
login.

## Remove a secret provider

When you remove a secret provider in **Settings → Secrets**, p0code lists the fields that read
from it. Removing it clears those fields, so set them again before you need them. The secrets in
1Password are not touched.

## When an agent asks for a secret

When an agent calls `request_secret`, T3 Code displays a private card in the thread (web, desktop, and mobile) instead of asking you to paste into chat.

If the environment has a secret provider, the card also lets you pick it and enter a reference
instead of the value. Answering with a reference needs permission to manage providers, as saving a
reference in Settings does; a session without it sees only the value field. p0code reads the secret once, when you answer. If 1Password is locked, the
card says so and the request stays open: unlock it and try again, or enter the value.

The value never appears in the conversation. Most requests keep it from the agent too: p0code
passes it to the tool that needs it. When an agent has to run a command with the value, the card
says so instead: the value goes into a private file that the agent's commands can read for about 24
hours.
