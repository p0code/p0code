# Permission modes

Permission modes control when an agent must ask for your approval before running commands or editing files. Set the mode per thread from the composer (`mod+shift+a` or the model picker's **Permissions** menu).

Configure the default for new threads in **Settings → Threads → New threads → Permissions** (default: **Full access**; projects can override). Administrators can cap available modes with a [managed policy](./managed-policy.md#permission-modes).

| Mode                  | Behavior                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                          |
| **Auto-accept edits** | Approves file edits automatically; commands and other actions may still ask.              |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about risky ones. |
| **Full access**       | Runs commands and edits without approval prompts.                                         |

Permission modes never stop an agent from asking clarifying questions. Subagent approval requests appear in the parent conversation with the subagent's name so you can approve without switching threads.

## Git push hooks below Full access

When an agent below **Full access** opens a PR using T3 Code's built-in pull request tool and the push would execute local Git hooks (`pre-push`, `reference-transaction`, or `hook.<name>.command`), T3 Code prompts you every time—naming the branch and hook files/commands—before pushing.

- Declining cancels the push. There is no "always allow" option, and Plan mode prompts too.
- Providers that can't show this prompt push without running hooks and inform the agent.
- Direct shell commands (`git push`, `gh pr create`) follow the provider's normal command approval rules instead.

## Provider differences

Providers enforce permissions differently, and some read-only actions proceed even in **Supervised**:

- **Auto mode**: Supported by Codex, Claude, Cursor, Grok, Antigravity (account-dependent; falls back to Supervised if unavailable), and fx. Providers without an equivalent (including OpenCode) fall back to asking.
- **Claude**: In **Auto**, asks about actions its review leaves open (unavailable if disabled in Claude settings or by the model). In **Full access**, Claude's own settings can still require approval or block dangerous removals. While an approval is pending, typing a reply declines it with feedback directly to that agent or subagent.
- **Codex**: In **Full access**, skips dangerous-command prompts, though managed network restrictions can still prompt unless commands were allowed for the session.
- **Grok**: No **Auto-accept edits** (falls back to Supervised). File approvals offer session-wide allow; command approvals do not.
- **fx**: No **Auto-accept edits**; **Full access** requires fx 0.0.14+ (otherwise falls back to Supervised).
- **Muse Code & Kiro**: Only **Supervised** and **Full access** (other modes fall back to Supervised). In Supervised, Kiro also asks you to review turn file changes; see [Kiro](./providers-kiro.md#permission-modes).
- **Antigravity**: May still send native approval prompts in **Full access**.
- **ACP Registry agents**: T3 Code answers their approval requests according to the selected mode; see [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

Muse Code offers only **Supervised** and **Full access**. A Muse thread already set to another mode
runs in **Supervised**.

p0code offers no **Auto-accept edits** for fx, and **Full access** only with fx 0.0.14 or later. An fx
thread set to a mode its fx lacks runs in **Supervised**.

Grok offers no **Auto-accept edits**. A Grok thread already set to it runs in **Supervised**. Grok
file-change approvals offer **Allow all edits this session**. Its command approvals have no
session-wide choice, because Grok would remember that command for the whole project.

ACP Registry agents run their own tools in their own mode; p0code answers their approval requests
by the permission mode. See [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

In **Full access**, commands that Codex's dangerous-command check would ask about run without
asking. Codex still asks before network access its managed network settings don't allow, unless
you already allowed commands for the session.

Claude can still ask in **Full access** when its settings disable bypass permissions or require
approval for an action. Dangerous-removal safety checks in bypass mode reject the command with
the original warning. Claude can use a safe rewrite when the warning supplies one; otherwise it
continues without the removal and tells you what it skipped.
While a Claude approval is pending, type a text reply to decline that request and give feedback
directly to the agent that asked, including a subagent. Other pending requests stay unanswered.

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

Kiro offers only **Supervised** and **Full access**. In **Supervised** Kiro also asks you to
review a turn's file changes. See [Kiro permissions](./providers-kiro.md#permission-modes).

See the [provider guides](./install.md#providers) for setup and provider-specific limits.
