# Text generation models

p0code writes some text for you: thread titles, commit messages, pull request titles and
descriptions, branch names, and voice transcript cleanup. Pick the model for this in
**Settings → Threads → Text generation model**. **Settings → Source control & issues** and
**Settings → Voice** can each pick a different one.

By default, a coding agent handles these tasks by starting a session per request. Adding a dedicated **text generator** API is usually much faster and cheaper.

## Add a text generator

Open **Settings → Providers → Text generators → Add generator** (stored per environment; API keys support [Secrets](./secrets.md)):

- **OpenAI** or **Anthropic**: Enter an API key.
- **OpenRouter**: Enter an OpenRouter API key to use any model it serves.
- **Custom (OpenAI-compatible)**: Enter a base URL (e.g. Ollama at `http://localhost:11434/v1` or LM Studio—`localhost` resolves on the environment's server).

Click **Test** beside a model picker to verify the key works, or **Show models** to refresh the catalog. Disabling or removing a generator falls back to the environment's default text generation model.

p0code lists the service's models to check the connection, then shows the model picker for each
text task so you can switch any of them to the new generator, or keep what they use. **Test** next
to a picker has the chosen model answer a tiny prompt, which proves the key works; some services
list their models without checking it. **Show models** in the generator's menu lists its models
and refreshes the list after the service adds some.

- **Review guides** always require a coding agent (Codex or Claude), not a text generator—choose one under **Settings → Source control & issues → Review guide model**.
- A [managed policy](./managed-policy.md) that restricts providers also disables text generators.
