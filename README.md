# modelshift

**Know what breaks before your LLM is switched off.**

`modelshift` scans your repo for every model ID you use (OpenAI, Anthropic, Google, Mistral, Cohere, AWS Bedrock, and open-weight models on **DeepInfra, Together, Fireworks, Groq, OpenRouter**). It tells you which are retiring, which are already gone, and which your host has **silently stopped serving**.

```bash
npx modelshift scan            # calendar check: no API keys needed
npx modelshift scan --live     # also ask providers what they actually serve today
```

```
● ALREADY SHUT DOWN  gpt-4-turbo  shut down 2026-10-23
    replacement: gpt-5.6-sol
    used at: config/.env.example:1

● NOT SERVED ANYMORE (live)  meta-llama/meta-llama-3-8b-instruct
    Not listed by deepinfra's live model list today: calls will likely fail with model-not-found.
    used at: audit_pipeline.py:28

● RETIRING  gpt-4o-2024-08-06  2027-01-14 (51 days)
    replacement: gpt-6-luna
    used at: src/app.py:5
```

## Why

- **Scheduled retirements.** OpenAI shuts down the GPT-4o, GPT-4o mini, GPT-4.1 and GPT-4.1 mini snapshots on **14 Jan 2027**. Anthropic, Google and others retire models every few months. Apps break, or silently change behaviour when requests auto-route to a replacement.
- **Unannounced removals.** Inference hosts like DeepInfra publish **no deprecation page**, and their `/models` endpoints carry no deprecation field. A model just disappears, and you find out when your API calls start failing. `--live` catches this by checking each host's live model list.

## How it works

1. **Find model IDs.** Only string literals and config values are scanned (`.py .ts .js .json .yaml .toml .env*` and more), so prose and variable names don't create noise. `node_modules`, build output and virtualenvs are skipped.
2. **Check the retirement calendar.** [`data/retirements.json`](data/retirements.json) is copied from the providers' official deprecation pages, and every entry cites its source. Fine-tuned OpenAI models follow their base model. Gateway IDs such as `openai/gpt-4o-mini-2024-07-18` are resolved too.
3. **Live check (`--live`).** Each relevant provider's model-list endpoint is queried with your own key. Keys only ever go to their own provider, and nothing else leaves your machine. Open-weight IDs are only checked against hosts your code actually references, because ID formats differ between hosts.

| Status | Meaning |
|---|---|
| ALREADY SHUT DOWN | Past its published shutdown date |
| NOT SERVED ANYMORE (live) | The provider's live list no longer includes it |
| DEPRECATED BY PROVIDER (live) | The provider's model object carries a deprecation or expiry field |
| RETIRING | Published shutdown date in the future |
| DEPRECATED (date TBA) | Deprecated, with no date announced yet |
| CHECK ALIAS | Undated alias (e.g. `gpt-4o`) whose dated snapshots are retiring |

## Options

```
--live                 query live model lists (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY,
                       MISTRAL_API_KEY, DEEPINFRA_API_KEY, TOGETHER_API_KEY, FIREWORKS_API_KEY,
                       GROQ_API_KEY, OPENROUTER_API_KEY; DeepInfra and OpenRouter work without a key)
--providers a,b        limit live checks (openai, anthropic, google, mistral, deepinfra, together, fireworks, groq, openrouter)
--json | --markdown    machine-readable output / PR-comment summary
--fail-on <level>      exit 1 on: retired | retiring | any   (use in CI)
--calendar <file>      custom calendar JSON
```

### In CI (daily, so you hear about removals before your users do)

```yaml
on:
  schedule: [{ cron: "0 7 * * *" }]
  workflow_dispatch:
jobs:
  models:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx modelshift scan --live --fail-on retiring
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## Roadmap

- `capture` + `run`: replay real traffic against the replacement model, measuring a noise floor first, then diffing format, tool calls, refusals, cost and latency
- `report`: a single-file HTML migration report with an honest "safe to switch?" verdict
- A GitHub Action, an MCP server and a Claude Code skill

## Contributing to the calendar

Spotted a retirement we're missing? Open a PR that edits `data/retirements.json`, and include the official source URL.

## License

MIT. The CLI, checks and calendar are, and will stay, free and open source.
