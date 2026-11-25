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

# 2. Replay on the old and the new model, compare, and write a shareable report
npx modelshift run --from openai:gpt-4o-2024-08-06 --to openai:gpt-6-luna --html modelshift-report.html
npx modelshift run --from deepinfra:google/gemma-3-12b-it --to deepinfra:google/gemma-3-4b-it   --judge deepinfra:meta-llama/Llama-3.3-70B-Instruct-Turbo --repeats 2
```

A real run (24 samples from a production app's language-detection and extraction prompts, on DeepInfra):

```
deepinfra:google/gemma-3-12b-it  →  deepinfra:google/gemma-3-4b-it   (24 samples × 2 repeats)
Verdict: NOT SAFE TO SWITCH YET  (confidence: medium; never a guarantee)
  - judge: 100.0% → 78.3% (95% CI of change -39.1% to -4.3%, beyond the baseline's own variation of ±0.0%; significant after correcting for 2 checks)
  - behaviour drift: outputs are less similar to the baseline (0.83) than the baseline is to itself (1.00).

Check            baseline  candidate  change (95% CI)           noise   n
errors               2.1%       0.0%  -2.1% [-6.3%, 0.0%]        ±4.2%   24
json-shape         100.0%      81.8%  -18.2% [-45.5%, 0.0%]      ±0.0%   11
assertions          91.7%      79.2%  -12.5% [-29.2%, 4.2%]      ±0.0%   24
judge              100.0%      78.3%  -21.7% [-39.1%, -4.3%]     ±0.0%   23 ✗

Examples of changes:
  [json-shape] sample person-7
    baseline : {"name": "", "dob": "", "tob": "", "place": ""}
    candidate: {}
  [assertions] sample lang-9
    baseline : romanized Punjabi
    candidate: romanized Hindi
```

The smaller model looks fine at a glance and is faster, but it drops required JSON fields and confuses Indian languages. The regex checks alone weren't conclusive on 24 samples; the LLM judge, calibrated against the old model's agreement with itself, was.

**How the comparison stays honest:**
- Models are random, so the **baseline runs each sample several times** (`--repeats`, default 3). Its run-to-run variation is the **noise floor**.
- A check is only flagged when the change is statistically significant (paired bootstrap) **and** bigger than that noise floor.
- **Corrected for running several checks at once.** Testing 6 checks at 95% each would raise a false alarm somewhere far more often than 5% of the time, so p-values are Holm-adjusted across the checks. Checks where too few samples changed to ever be significant don't count toward the correction. A check that is worse on its own but not after correction makes the verdict *review*, with a note to add samples. In 1,000 simulated runs where the new model behaves exactly like the old one, `run` said "not safe" 1.4% of the time (3.3% without the correction); a real 30-point drop is still caught.
- **Checks:** call errors (e.g. a removed model), JSON validity, JSON shape (top-level keys), tool calls, refusals, your own per-sample `expect` rules (`match` / `notMatch` regexes, case-insensitive unless written `"/Pattern/"`; `json: true`; `containsJson: true`), plus a model-free similarity drift (is the new model less like the old one than the old one is to itself?). Latency, output tokens and cost (`--prices`) are reported too.
- **Optional LLM judge (`--judge provider:model`)** for open-ended answers. The judge compares each answer with the baseline's first answer and says SAME or DIFFERENT. It also judges the baseline's other repeats against that same answer, so the candidate is only flagged if it differs more often than the old model differs from itself. Use a strong model that is neither the old nor the new one, and `--repeats 2` or more.
- **Optional meaning check (`--embed provider:model`)**, e.g. `openai:text-embedding-3-small` or `deepinfra:BAAI/bge-m3`: compares the meaning of new answers with old ones using embeddings, against how similar the old model's own answers are to each other. Cheaper and more repeatable than a judge. It flags *review* when the new answers are reliably more than 0.02 less similar, and never makes the verdict *not safe* on its own.
- **Verdicts:** *likely safe*, *review*, or *not safe yet*, with a confidence level based on sample count. It never says "guaranteed".
- **Silent swaps:** if a provider serves a different model than the one you named, for the baseline or the candidate, `run` warns you, because you'd be comparing against the wrong model.
- **Old model already gone?** If every baseline call fails, candidates are judged on their own against each sample's expected output. Give several candidates (`--to a,b,c`) to compare them in one table.
- **Resilient:** rate limits (429), overloaded responses and 5xx errors are retried with backoff. Only persistent failures count as errors.
- **Response cache:** successful responses are cached in `.modelshift/cache` (git-ignored automatically), keyed by model, exact request and repeat number. Re-running, re-judging or adding another candidate only pays for new calls, and the old model is called once even with several candidates. `--no-cache` always calls the models.
- **Spend guard:** `run` prints the number of calls before starting and requires `--yes` above 60 calls.

**Providers for `run`:** `openai`, `anthropic`, `google`, `azure` (deployment name; set `AZURE_OPENAI_ENDPOINT`), `mistral`, `deepinfra`, `together`, `fireworks`, `groq`, `openrouter`.

### Already using Promptfoo?

Reuse your existing tests instead of writing new ones:

```bash
npx modelshift import promptfoo promptfooconfig.yaml   # -> modelshift-samples.jsonl
```

Each prompt × test case becomes a sample. That covers text, chat-JSON and `---`-separated prompt files, `vars` (including list values and `file://` text), `defaultTest`, and tests in YAML, JSON, JSONL or CSV.

- **Translated** into expected-output rules: `equals`, `contains`, `icontains`, `starts-with`, `regex`, `contains-any`/`-all` (and the `i` variants), `is-json`, `contains-json`, and their `not-` forms.
- **Not translated:** model-graded and code assertions (`llm-rubric`, `factuality`, `javascript`, `python`...). They are listed with a suggestion, usually `--judge` or `--embed`.

Tools, JSON mode, temperature and max tokens are taken from the providers' `config`, including provider files and YAML anchors / `<<` merge keys. The command prints the `run` line to use with your config's providers.

Some things can't be imported, and each is reported with a reason:
- assertions that check a *transformed* output: on the raw output they would always fail;
- JS/Python prompt functions and Nunjucks `{% %}` tags;
- tests generated by code or fetched from datasets or URLs (export them to CSV/JSONL first);
- red-team configs.

Tested on 73 configs from Promptfoo's own `examples/` folder: every YAML file parses, 61 configs import, and the other 12 are the cases above.

**Accepted log formats for `capture`** (JSONL or a JSON array):
- OpenAI-style `{request, response}` logs
- Bare request bodies `{messages, tools, ...}`
- Langfuse-style `{input, output}`
- Simple `{prompt, system, output}`

## Share the result

```bash
npx modelshift report modelshift-results.json                 # -> modelshift-report.html
npx modelshift report results-a.json results-b.json -o cmp.html  # several candidates side by side
npx modelshift report modelshift-results.json --markdown      # for a PR comment or ticket
```

The report is one self-contained HTML file (no scripts, no external assets, light and dark themes): the verdict, every check with its confidence interval drawn against the noise band, regressed examples side by side, and every sample's input and outputs. It contains your samples' text, so review it before sharing outside your team.

## GitHub Action

Daily watch that opens (and later closes) an issue when a model you use is retiring, removed or silently redirected: [`examples/workflows/modelshift-watch.yml`](examples/workflows/modelshift-watch.yml).

```yaml
- uses: angledsapiens/modelshift@v0
  with:
    probe: "true"        # live lists + 1-token probes
    fail-on: retiring
  env:
    DEEPINFRA_API_KEY: ${{ secrets.DEEPINFRA_API_KEY }}
```

Pull-request gate that replays your samples on the current and proposed model, comments the verdict on the PR, uploads the HTML report and fails on "not safe yet": [`examples/workflows/modelshift-gate.yml`](examples/workflows/modelshift-gate.yml).

```yaml
- uses: angledsapiens/modelshift@v0
  with:
    command: run
    from: openai:gpt-4o-2024-08-06
    to: openai:gpt-6-luna
    comment: "true"
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Every result is also written to the job summary.

## Use it from coding agents (MCP + Claude Code skill)

`modelshift mcp` is a dependency-free MCP server (stdio) with six tools: `scan_models`, `retirement_calendar`, `capture_samples`, `import_promptfoo`, `run_migration_test` and `render_report`.

```bash
claude mcp add modelshift -- npx -y modelshift mcp
```

Paid runs are guarded. Above 60 calls, `run_migration_test` returns the plan instead of running, and the agent must ask you before retrying with `confirm_spend: true`.

The Claude Code skill in [`skills/modelshift/SKILL.md`](skills/modelshift/SKILL.md) teaches an agent the workflow: scan, build samples, test with your approval, and explain the verdict honestly. Copy it to `.claude/skills/modelshift/` in your project or to `~/.claude/skills/`.

## Roadmap

- Hosted retirement alerts across many repos (email or Slack)
- Prompt adaptation hints for the new model
- More log importers (LangSmith, OpenTelemetry GenAI spans)
- Multi-turn conversations and tool-call order/argument checks
- AWS Bedrock adapter

## Contributing to the calendar

Spotted a retirement we're missing? Open a PR that edits `data/retirements.json`, and include the official source URL.

## License

MIT. The CLI, checks, calendar, report, GitHub Action and MCP server are, and will stay, free and open source.
