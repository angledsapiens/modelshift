# modelshift

**Know what breaks before your LLM is switched off.**

`modelshift` scans your repo for every model ID you use (OpenAI, Anthropic, Google, Mistral, Cohere, AWS Bedrock, and open-weight models on **DeepInfra, Together, Fireworks, Groq, OpenRouter**). It tells you which are retiring, which are already gone, and which your host is **silently serving as a different model**.

```bash
npx modelshift scan                 # calendar check: no API keys needed
npx modelshift scan --live --probe  # ask hosts what they actually serve under each name
```

```
● ALREADY SHUT DOWN  gpt-4-turbo  shut down 2026-10-23
    replacement: gpt-5.6-sol
    used at: config/.env.example:1

● SILENTLY REDIRECTED (probe)  meta-llama/meta-llama-3-8b-instruct
    actually served: meta-llama/Llama-4-Scout-17B-16E-Instruct
    used at: audit_pipeline.py:28

● RETIRING  gpt-4o-2024-08-06  2027-01-14 (51 days)
    replacement: gpt-6-luna
    used at: src/app.py:5
```

## Why

- **Scheduled retirements.** OpenAI shuts down the GPT-4o, GPT-4o mini, GPT-4.1 and GPT-4.1 mini snapshots on **14 Jan 2027**. Anthropic, Google and others retire models every few months. Apps break, or silently change behaviour when requests auto-route to a replacement.
- **Silent swaps and removals.** Inference hosts like DeepInfra publish **no deprecation page**, and their `/models` endpoints carry no deprecation field. When a model is retired, requests for it may fail, or they may be **quietly answered by a different model**. In November 2026, DeepInfra was serving requests for:
  - `gemma-2-9b-it` with `gemma-3-12b-it`
  - `Meta-Llama-3-8B-Instruct` with `Llama-4-Scout-17B-16E-Instruct`

  The only clue was the `model` field in the response. `--live` checks each host's model list, and `--probe` sends one 1-token request per unlisted model to see what actually answers.

## How it works

1. **Find model IDs.** Only string literals and config values are scanned (`.py .ts .js .json .yaml .toml .env*` and more), so prose and variable names don't create noise. `node_modules`, build output and virtualenvs are skipped.
2. **Check the retirement calendar.** [`data/retirements.json`](data/retirements.json) is copied from the providers' official deprecation pages, and every entry cites its source. Fine-tuned OpenAI models follow their base model. Gateway IDs such as `openai/gpt-4o-mini-2024-07-18` are resolved too.
3. **Live check (`--live`).** Each relevant provider's model-list endpoint is queried with your own key. Keys only ever go to their own provider, and nothing else leaves your machine. Open-weight IDs are only checked against hosts your code actually references, because ID formats differ between hosts.
4. **Probe (`--probe`).** For models missing from a host's list, modelshift sends one 1-token request and reads the `model` field the host reports. The result is one of: *missing* (a real model-not-found), *silently redirected* (a different model answered), or *still served*. Each probe costs a fraction of a cent.

| Status | Meaning |
|---|---|
| ALREADY SHUT DOWN | Past its published shutdown date |
| NOT SERVED ANYMORE (probe) | The host returns model-not-found |
| SILENTLY REDIRECTED (probe) | The host answers with a different model under this name |
| NOT IN MODEL LIST (live) | Missing from the host's list (run `--probe` to see whether it fails or is redirected) |
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

## Test the replacement before you switch

```bash
# 1. Turn logged requests into a replayable test set (PII redacted by default)
npx modelshift capture logs.jsonl            # -> modelshift-samples.jsonl (50 samples spread across the log)

# 2. Replay on the old and the new model, then compare
npx modelshift run --from openai:gpt-4o-2024-08-06 --to openai:gpt-6-luna
npx modelshift run --from deepinfra:google/gemma-2-27b-it --to deepinfra:google/gemma-3-27b-it
```

```
openai:gpt-4o-2024-08-06  →  openai:gpt-6-luna   (24 samples × 2 repeats)
Verdict: NOT SAFE TO SWITCH YET  (confidence: medium; never a guarantee)
  - json-valid: 100.0% → 50.0% (95% CI of change -70.8% to -29.2%, beyond the baseline's own variation of ±0.0%)

Check            baseline  candidate  change (95% CI)           noise   n
errors               0.0%       0.0%  +0.0% [0.0%, 0.0%]         ±0.0%   24
json-valid         100.0%      50.0%  -50.0% [-70.8%, -29.2%]    ±0.0%   24 ✗
...
```

**How the comparison stays honest:**
- Models are random, so the **baseline runs each sample several times** (`--repeats`, default 3). Its run-to-run variation is the **noise floor**.
- A check is only flagged when the 95% bootstrap confidence interval of the change lies entirely on the worse side **and** the change is bigger than that noise floor.
- **Checks:** call errors (e.g. a removed model), JSON validity, JSON shape (top-level keys), tool calls, refusals, your own per-sample `expect.match` / `expect.notMatch` regexes, plus a model-free similarity drift (is the new model less like the old one than the old one is to itself?). Latency, output tokens and cost (`--prices`) are reported too.
- **Verdicts:** *likely safe*, *review*, or *not safe yet*, with a confidence level based on sample count. It never says "guaranteed".
- **Silent swaps:** if a provider serves a different model than the one you named, for the baseline or the candidate, `run` warns you, because you'd be comparing against the wrong model.
- **Old model already gone?** If every baseline call fails, candidates are judged on their own against each sample's expected output. Give several candidates (`--to a,b,c`) to compare them in one table.
- **Resilient:** rate limits (429), overloaded responses and 5xx errors are retried with backoff. Only persistent failures count as errors.
- **Spend guard:** `run` prints the number of calls before starting and requires `--yes` above 60 calls.

**Providers for `run`:** `openai`, `anthropic`, `google`, `azure` (deployment name; set `AZURE_OPENAI_ENDPOINT`), `mistral`, `deepinfra`, `together`, `fireworks`, `groq`, `openrouter`.

**Accepted log formats for `capture`** (JSONL or a JSON array):
- OpenAI-style `{request, response}` logs
- Bare request bodies `{messages, tools, ...}`
- Langfuse-style `{input, output}`
- Simple `{prompt, system, output}`

## Roadmap

- `report`: a single-file HTML migration report to share with your team
- A GitHub Action, an MCP server and a Claude Code skill
- An optional LLM-judge check for open-ended answers

## Contributing to the calendar

Spotted a retirement we're missing? Open a PR that edits `data/retirements.json`, and include the official source URL.

## License

MIT. The CLI, checks and calendar are, and will stay, free and open source.
