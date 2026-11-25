# modelshift

[![npm](https://img.shields.io/npm/v/modelshift)](https://www.npmjs.com/package/modelshift) [![ci](https://github.com/angledsapiens/modelshift/actions/workflows/ci.yml/badge.svg)](https://github.com/angledsapiens/modelshift/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Know what breaks before your LLM is switched off.**

Model providers retire models on a schedule, and inference hosts sometimes remove or swap models with no notice at all. `modelshift` is a free, open-source command-line tool that:

1. **Finds** every model ID your code uses and tells you which are retiring, already gone, or being **silently served as a different model**.
2. **Tests** a replacement model on your own real requests, side by side with the current one, and tells you, with honest statistics, whether it's safe to switch.
3. **Reports** the result as a single HTML file, a markdown summary for a pull request, or JSON for scripts. Anything that went wrong during testing is listed at the top, never hidden.

It runs on your machine with your own API keys. Nothing is sent anywhere except to the model providers you choose.

```bash
npx modelshift scan                                    # which models in this repo are retiring? (no keys needed)
npx modelshift capture logs.jsonl                      # turn logged requests into a test set
npx modelshift run --from openai:gpt-4o-2024-08-06 --to openai:gpt-6-luna --html report.html
```

---

## Contents

- [Why this exists](#why-this-exists)
- [Install](#install)
- [Quick start](#quick-start)
- [How to use it](#how-to-use-it)
  - [`scan`: find retiring and missing models](#scan-find-retiring-and-missing-models)
  - [`capture`: build a test set from your logs](#capture-build-a-test-set-from-your-logs)
  - [`import promptfoo`: reuse Promptfoo tests](#import-promptfoo-reuse-promptfoo-tests)
  - [`run`: test the replacement](#run-test-the-replacement)
  - [`report`: share the result](#report-share-the-result)
  - [`mcp`: use it from coding agents](#mcp-use-it-from-coding-agents)
- [The samples file](#the-samples-file)
- [Supported providers](#supported-providers)
- [How the testing is done](#how-the-testing-is-done)
- [Methodology: the statistics](#methodology-the-statistics)
- [Understanding the report](#understanding-the-report)
- [Every part of the report, explained](#every-part-of-the-report-explained)
- [Problems during testing](#problems-during-testing)
- [Understanding a scan](#understanding-a-scan)
- [Error messages and what they mean](#error-messages-and-what-they-mean)
- [Using it in CI (GitHub Action)](#using-it-in-ci-github-action)
- [Cost control](#cost-control)
- [Privacy and security](#privacy-and-security)
- [Limitations: what modelshift can't tell you](#limitations-what-modelshift-cant-tell-you)
- [FAQ and troubleshooting](#faq-and-troubleshooting)
- [Roadmap](#roadmap) · [Contributing](#contributing) · [License](#license)

---

## Why this exists

- **Scheduled retirements.** OpenAI shuts down the GPT-4o, GPT-4o mini, GPT-4.1 and GPT-4.1 mini API snapshots on **14 January 2027**. Anthropic, Google, AWS Bedrock and others retire models every few months. When a model goes, apps either break or start behaving differently.
- **Silent removals and swaps.** Some inference hosts publish no deprecation page, and their model lists carry no deprecation field. When they retire a model, requests may start failing, or may be **quietly answered by a different model**. In November 2026, DeepInfra was answering requests for `gemma-2-9b-it` with `gemma-3-12b-it`, and requests for `Meta-Llama-3-8B-Instruct` with `Llama-4-Scout-17B-16E-Instruct`. The only clue was the `model` field in each response.
- **"Just switch to the new one" is risky.** Prompts are tuned to the model they were written for. A newer, bigger or cheaper model can break your JSON format, call different tools, refuse more, or answer differently in ways that matter to your users. Re-testing by hand is slow, and eyeballing a few outputs can't tell a real change from the model's normal randomness.

`modelshift` is built for exactly this job: migrating from one model to another. It is vendor-neutral, works with closed and open-weight models, and is careful never to claim more certainty than the data supports.

---

## Install

You need **Node.js 20 or newer**. There are no other dependencies.

```bash
npx modelshift --help          # run without installing
npm install -g modelshift      # or install the command globally
```

From source:

```bash
git clone https://github.com/angledsapiens/modelshift.git
cd modelshift
npm install
npm run build
node dist/src/bin.js --help    # same commands as "modelshift"
npm test                       # builds and runs the test suite
```

API keys are read from environment variables (see [Supported providers](#supported-providers)). To keep them in a file, use a `.env` file and Node's built-in loader, and keep that file out of git:

```bash
node --env-file=.env dist/src/bin.js run ...
```

---

## Quick start

**1. See which models in your repo are at risk.** No keys needed:

```bash
npx modelshift scan
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

Add `--live --probe` (with your keys set) to ask each host what it actually serves.

**2. Build a test set** from requests your app really made:

```bash
npx modelshift capture logs.jsonl                 # -> modelshift-samples.jsonl (50 samples, PII redacted)
# or, if you already have Promptfoo tests:
npx modelshift import promptfoo promptfooconfig.yaml
```

**3. Test the replacement** and write a report:

```bash
npx modelshift run --from openai:gpt-4o-2024-08-06 --to openai:gpt-6-luna --html report.html
```

modelshift prints the number of API calls and an approximate cost first. Above 60 calls it stops and asks you to re-run with `--yes`.

**4. Read the verdict.** It is one of *likely safe to switch*, *review before switching*, or *not safe to switch yet*, with a confidence level and the reasons. See [Understanding the report](#understanding-the-report).

**A real example.** [`examples/gpt-4o-migration`](examples/gpt-4o-migration) tests GPT-4o mini against its replacement, GPT-6 Luna, on 20 typical app requests. It found three code changes the new model requires, answers that stay correct but are noticeably terser, and higher token use. The samples, results and HTML report are all there, and you can re-run it with your own key.

---

## How to use it

```
modelshift scan [path] [options]        Find model ids in a repo and check retirements
modelshift capture <logs> [options]     Turn logged requests (JSONL/JSON) into a replayable test set
modelshift import promptfoo [config]    Turn a Promptfoo config's prompts × tests into a test set
modelshift run --from <p:m> --to <p:m>  Replay the test set on old vs new model and compare
modelshift report <results.json...>     Turn run results into a shareable single-file HTML report
modelshift mcp                          Start an MCP server (stdio) so agents can scan and test migrations
```

Models are always written **`provider:model`**, for example `openai:gpt-4o-2024-08-06`, `anthropic:claude-sonnet-5-5`, `deepinfra:google/gemma-3-27b-it` or `bedrock:eu.amazon.nova-lite-v1:0`.

### `scan`: find retiring and missing models

```bash
modelshift scan [path]                       # calendar check of the current folder (or path)
modelshift scan --live                       # also ask each provider which models it lists today
modelshift scan --live --probe               # also send one 1-token request per unlisted model
modelshift scan --markdown > models.md       # PR-comment / ticket summary
modelshift scan --fail-on retiring           # exit 1 if anything is retiring or worse (for CI)
```

| Option | What it does |
|---|---|
| `--live` | Query each relevant provider's live model list with your key. Catches removals the calendar doesn't know about yet. |
| `--probe` | With `--live`: for each model missing from its host's list, send one 1-token request and read which model actually answered. Implies `--live`. |
| `--providers a,b` | Limit live checks to these providers: `openai, anthropic, google, mistral, deepinfra, together, fireworks, groq, openrouter, bedrock`. |
| `--json` | Machine-readable output. |
| `--markdown` | A markdown summary for a pull request or ticket. |
| `--fail-on <level>` | Exit with code 1 if any model is at or above this level: `retired`, `retiring` or `any` ([levels](#fail-on-levels)). |
| `--include-markdown` | Also scan `.md` files (skipped by default, because docs mention models in prose). |
| `--calendar <file>` | Use your own retirement calendar JSON instead of the built-in one. |
| `--today <YYYY-MM-DD>` | Pretend today is another date (for testing). |

**What it scans.** String literals and config values in `.py .ts .tsx .js .jsx .mjs .cjs .json .yaml .yml .toml .ini .cfg .properties .go .rb .java .kt .cs .php .rs .swift .ipynb .sh .tf` and `.env*` files. Variable names, comments and prose don't count, which keeps false matches down. It skips `node_modules`, `.git`, build output, virtual environments, caches and vendored code, and files over 1 MB.

See [Understanding a scan](#understanding-a-scan) for every status and how `--live` and `--probe` work.

### `capture`: build a test set from your logs

```bash
modelshift capture logs.jsonl                     # -> modelshift-samples.jsonl
modelshift capture logs.json -o samples.jsonl --limit 200
modelshift capture logs.jsonl --no-redact
```

| Option | What it does |
|---|---|
| `-o, --out <file>` | Output samples file. Default `modelshift-samples.jsonl`. |
| `--limit <n>` | Keep `n` samples, spread evenly across the log so you don't only test the first hour of traffic. Default 50. |
| `--no-redact` | Keep text exactly as logged. By default, emails, API keys, bearer tokens, card numbers, IBANs, UK National Insurance numbers and phone numbers are replaced with placeholders such as `[REDACTED_EMAIL]`. Redaction is best effort: review samples before sharing them. |

**Accepted log formats** (JSONL, one record per line, or a JSON array):

| Shape | Example |
|---|---|
| OpenAI-style request/response log | `{"request": {"messages": [...], "tools": [...], "temperature": 0}, "response": {"choices": [{"message": {...}}]}}` |
| Bare request body | `{"messages": [...], "tools": [...], "response_format": {"type": "json_object"}}` |
| Langfuse-style | `{"input": [...messages] or "prompt text", "output": "..." or {"content": "..."}}` |
| Simple prompt | `{"prompt": "...", "system": "...", "output": "..."}` |

Tools, temperature, `max_tokens` (or `max_completion_tokens`) and JSON mode are carried over. A logged answer is kept as the sample's `reference`, used mainly when the old model can no longer be called. Lines that can't be understood are skipped and counted.

### `import promptfoo`: reuse Promptfoo tests

```bash
modelshift import promptfoo                          # looks for promptfooconfig.yaml / .yml / .json here
modelshift import promptfoo path/to/promptfooconfig.yaml -o samples.jsonl
```

Each **prompt × test case** becomes one sample. The import is free: it makes no API calls. It understands:

- Prompts written inline, in text files (several prompts split by `---`), in chat-format JSON/YAML files, and in globs.
- `vars`, including list values (which expand into one sample per combination) and `file://` text files.
- `defaultTest`, and tests in YAML, JSON, JSONL or CSV (with `__expected` columns).
- Tools, JSON mode, temperature and max tokens from each provider's `config`, including provider definitions kept in separate files, YAML anchors and `<<` merge keys, and Anthropic-style tool definitions.
- A small subset of Nunjucks templating: `{{ var }}`, dotted paths, and the filters `upper`, `lower`, `trim`, `default`, `dump` and `safe`.

**Assertions translated** into [expected-output rules](#the-samples-file): `equals`, `contains`, `icontains`, `starts-with`, `regex`, `contains-any`, `contains-all` and their `i` variants, `is-json`, `contains-json`, and the `not-` forms of all of these.

**Not translated, and listed with a suggestion:** model-graded and code assertions (`llm-rubric`, `factuality`, `similar`, `javascript`, `python`, `latency` and others). The suggestion is usually to add `--judge` or `--embed` to the run.

**Not imported, each with a stated reason:**
- Assertions on a *transformed* output (for example only the tool name). Checked against the raw output they would always fail and look like a regression.
- Prompt functions written in JavaScript or Python, and prompts using Nunjucks `{% %}` tags.
- Tests generated by code, or fetched from URLs and datasets (`https://`, `huggingface://`, Google Sheets...). Export them to CSV or JSONL first.
- Red-team configs, whose tests are generated when Promptfoo runs.

The command ends by printing the `run` line to use, built from your config's providers, for example `Next: modelshift run --from openai:gpt-4o-2024-08-06 --to anthropic:claude-sonnet-5-5 --samples modelshift-samples.jsonl`.

We tested the importer on Promptfoo's own `examples/` folder. Every YAML file parses, and every config that couldn't be imported stops with a stated reason, such as the ones above.

### `run`: test the replacement

```bash
modelshift run --from openai:gpt-4o-2024-08-06 --to openai:gpt-6-luna
modelshift run --from openai:gpt-4o-2024-08-06 --to openai:gpt-6-luna,anthropic:claude-sonnet-5-5 --html report.html
modelshift run --from deepinfra:google/gemma-3-12b-it --to deepinfra:google/gemma-3-4b-it \
  --judge deepinfra:meta-llama/Llama-3.3-70B-Instruct-Turbo --embed deepinfra:BAAI/bge-m3 --repeats 2
```

| Option | Default | What it does |
|---|---|---|
| `--from <provider:model>` | required | The model you use today (the **baseline**). |
| `--to <provider:model>[,...]` | required | The replacement (the **candidate**). Give several, comma-separated, to compare them; the baseline is only called once. |
| `--samples <file>` | `modelshift-samples.jsonl` | The test set. |
| `--repeats <n>` | 3 | How many times each sample is sent to each model. The baseline's repeats measure its own randomness: the **noise floor**. Use at least 2. |
| `--concurrency <n>` | 4 | Requests in flight at once. Lower it if you hit rate limits. |
| `--temperature <t>` | each sample's own | Override every sample's temperature. |
| `--judge <provider:model>` | off | Add an [LLM judge check](#llm-judge) for open-ended answers. |
| `--embed <provider:model>` | off | Add a [meaning check](#meaning-semantic) using an embedding model. |
| `--prices <file>` | off | Price list for a cost comparison: `{"openai:gpt-6-luna": {"input": 1.25, "output": 10}}` in US dollars per million tokens. |
| `-o, --out <file>` | `modelshift-results.json` | Results JSON. With several candidates you get `-1.json`, `-2.json`... |
| `--html <file>` | off | Also write the HTML report. |
| `--markdown` | off | Print a markdown summary to standard output (the normal summary goes to standard error). |
| `--no-cache` | cache on | Always call the models, ignoring cached answers. |
| `--cache-dir <dir>` | `.modelshift/cache` | Where answers are cached. |
| `--yes` | off | Allow runs of more than 60 API calls. |
| `--fail-on-unsafe` | off | Exit with code 1 if the verdict is *not safe yet* **or** testing was incomplete. For CI. |

If the old model has **already been switched off**, every baseline call fails. modelshift then judges each candidate on its own against each sample's expected output (`expect` rules and, with `--judge`, the logged `reference`). This is listed as a problem in the report so you know the comparison is one-sided.

### `report`: share the result

```bash
modelshift report modelshift-results.json                    # -> modelshift-report.html
modelshift report results-1.json results-2.json -o cmp.html  # several candidates side by side
modelshift report modelshift-results.json --markdown         # markdown for a PR comment or ticket
```

The analysis is recalculated from the raw answers stored in the results file, so older results files get the current checks. Costs are kept as originally recorded, because the price list isn't stored.

### `mcp`: use it from coding agents

`modelshift mcp` starts a dependency-free [MCP](https://modelcontextprotocol.io) server over stdio, so agents such as Claude Code can scan repos and test migrations.

```bash
claude mcp add modelshift -- npx -y modelshift mcp
```

| Tool | What it does | Costs money? |
|---|---|---|
| `scan_models` | Same as `scan` (`path`, `live`, `probe`, `providers`). | Only `probe`, a fraction of a cent per model. |
| `retirement_calendar` | Lists known retirements, filtered by `provider` or a `query`. | No |
| `capture_samples` | Same as `capture`. | No |
| `import_promptfoo` | Same as `import promptfoo`. | No |
| `run_migration_test` | Same as `run` (`from`, `to`, `samples`, `repeats`, `judge`, `embed`, `out`, `html`). Above 60 calls it returns the plan instead of running, and the agent must ask you before retrying with `confirm_spend: true`. | Yes |
| `render_report` | Same as `report`. | No |

A Claude Code skill in [`skills/modelshift/SKILL.md`](skills/modelshift/SKILL.md) teaches an agent the workflow: scan, build samples, test only with your approval, and explain the verdict honestly. Copy it into `.claude/skills/modelshift/` in your project, or into `~/.claude/skills/`.

---

## The samples file

A samples file is JSONL: one JSON object per line, each a request that can be replayed. `capture` and `import promptfoo` write it for you, but you can also write or edit it by hand.

```json
{"id": "refund-1", "messages": [{"role": "system", "content": "You are a support agent."}, {"role": "user", "content": "I want a refund for order 1234"}], "temperature": 0, "expect": {"match": ["refund", "1234"], "notMatch": ["as an AI"]}}
{"id": "extract-7", "messages": [{"role": "user", "content": "Return the name and date of birth as JSON: ..."}], "json": true, "expect": {"json": true, "match": ["\"dob\""]}}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | A unique name, shown in reports. |
| `messages` | yes | Chat messages: `system`, `user`, `assistant` and `tool` roles, each with `content`. |
| `tools` | no | OpenAI-style function tools: `[{"type": "function", "function": {"name", "description", "parameters"}}]`. They are converted for providers that use a different format. |
| `temperature` | no | Sent as is. When left out, the provider's default is used. `--temperature` overrides it. |
| `max_tokens` | no | Output limit. When left out, the provider's default is used (Anthropic needs one, so 1024 is sent). |
| `json` | no | Ask for a JSON object where the provider supports a JSON mode (OpenAI-compatible providers, Azure, Google). Bedrock's Converse API has no JSON mode, so there the prompt's own instructions decide. |
| `reference` | no | The answer logged in production. Used when the old model can't be called (as the judge's reference), and in the similarity check when there's only one old answer to compare. |
| `expect` | no | Your own rules for a correct answer (below). |

### Expected-output rules (`expect`)

| Rule | Passes when |
|---|---|
| `"match": ["pattern", ...]` | The answer matches **every** pattern. |
| `"notMatch": ["pattern", ...]` | The answer matches **none** of the patterns. |
| `"json": true` | The whole answer is valid JSON (a ```` ```json ```` code fence is allowed). |
| `"containsJson": true` | The answer contains a JSON object or array somewhere. |

Patterns are regular expressions and **case-insensitive by default**. Write `"/Pattern/"` with slashes to control the flags yourself, for example `"/Total/"` (case-sensitive) or `"/^ok$/im"`. When the model answers with a tool call, the rules are checked against `toolName({"arguments": ...})`, and `json` / `containsJson` pass, as in Promptfoo.

A sample passes the **assertions** check only when all of its rules pass.

**Check the outcome, not the method.** A rule that's too strict fails on good answers and looks like a regression. Two real mistakes from the [GPT-4o example](examples/gpt-4o-migration): a rule requiring Python's `re` module failed a correct solution written without it, and `"hey"` (meant to catch a casual greeting) matched inside "t*hey*". Use word boundaries (`"\\bhey\\b"`), accept equivalent forms (`"12 June|June 12"`), and when both models fail a sample, check the rule before blaming the models.

---

## Supported providers

| Provider | Model format | Credentials (environment variables) | `run` | `scan --live` | `--embed` |
|---|---|---|---|---|---|
| OpenAI | `openai:gpt-4o-2024-08-06` | `OPENAI_API_KEY` | ✓ | ✓ | ✓ e.g. `text-embedding-3-small` |
| Anthropic | `anthropic:claude-sonnet-5-5` | `ANTHROPIC_API_KEY` | ✓ | ✓ | ✗ (no embeddings API) |
| Google Gemini | `google:gemini-2.5-pro` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | ✓ | ✓ | ✓ e.g. `gemini-embedding-001` |
| Azure OpenAI | `azure:<deployment-name>` | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, optional `AZURE_OPENAI_API_VERSION` (default `2024-10-21`) | ✓ | calendar only | ✓ |
| AWS Bedrock | `bedrock:<model id, inference profile or ARN>` | `AWS_REGION` plus `AWS_BEARER_TOKEN_BEDROCK`, or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`) | ✓ | ✓ (flags LEGACY models) | ✓ Titan and Cohere |
| Mistral | `mistral:mistral-large-latest` | `MISTRAL_API_KEY` | ✓ | ✓ | ✓ `mistral-embed` |
| DeepInfra | `deepinfra:google/gemma-3-27b-it` | `DEEPINFRA_API_KEY` or `DEEPINFRA_TOKEN` | ✓ | ✓ (no key needed) | ✓ e.g. `BAAI/bge-m3` |
| Together AI | `together:meta-llama/Llama-3.3-70B-Instruct-Turbo` | `TOGETHER_API_KEY` | ✓ | ✓ | ✓ if the host offers embeddings |
| Fireworks | `fireworks:accounts/fireworks/models/...` | `FIREWORKS_API_KEY` | ✓ | ✓ | ✓ if the host offers embeddings |
| Groq | `groq:llama-3.3-70b-versatile` | `GROQ_API_KEY` | ✓ | ✓ | ✓ if the host offers embeddings |
| OpenRouter | `openrouter:openai/gpt-4o` | `OPENROUTER_API_KEY` | ✓ | ✓ (no key needed) | ✓ if the host offers embeddings |

`scan` without `--live` needs no keys at all. It also recognises IDs from Cohere and DeepSeek, which are checked against the calendar.

**Keys stay with their provider.** Each key is only ever sent to its own provider's API, over HTTPS.

### Settings a newer model rejects

Newer models sometimes reject request settings that older ones accepted. When that happens, modelshift makes the smallest change that lets the request run, retries it, and reports the change under [Problems during testing](#problems-during-testing) as one **your code will need too**. Requests that don't use the setting are sent unchanged, and any other error is reported as a failed call, not retried.

| The model rejects | modelshift sends instead | What to change in your code |
|---|---|---|
| `temperature` (e.g. GPT-6 Luna only accepts its default of 1) | No temperature, so the model's default is used | Remove `temperature`, or set the value the model accepts. Answers may vary more between runs, which the report's noise checks take into account. |
| `max_tokens` (it asks for `max_completion_tokens`) | `max_completion_tokens` with the same value | Rename the setting. On reasoning models the limit also covers hidden reasoning tokens, so raise it if answers come back cut short. |
| Function tools on Chat Completions at the default reasoning effort | `reasoning_effort: "none"` on requests with tools | Send `reasoning_effort: "none"`, or move to the Responses API. The model may answer differently there, so test that separately. |

This applies to OpenAI and the OpenAI-compatible providers (Azure OpenAI, Mistral, DeepInfra, Together AI, Fireworks, Groq and OpenRouter).

### AWS Bedrock in detail

modelshift talks to Bedrock through the **Converse API**, which works the same way for every chat model on Bedrock (Claude, Llama, Nova, Mistral, Qwen, gpt-oss, DeepSeek...), including tool calls. It signs requests itself (AWS Signature Version 4), so no AWS SDK is needed.

```bash
export AWS_REGION=eu-west-2
export AWS_BEARER_TOKEN_BEDROCK=...            # a Bedrock API key, or:
# export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_SESSION_TOKEN=...
# Signed in with "aws login", an AWS profile or SSO? Export that session's keys:
#   eval "$(aws configure export-credentials --profile <name> --format env)"
#   (PowerShell: aws configure export-credentials --profile <name> --format powershell | Invoke-Expression)

npx modelshift run --from bedrock:eu.amazon.nova-micro-v1:0 --to bedrock:eu.amazon.nova-lite-v1:0 \
  --embed bedrock:amazon.titan-embed-text-v2:0 --repeats 2
```

- **Model IDs:** a base model ID (`amazon.nova-lite-v1:0`), a cross-region inference profile (`us.`, `eu.`, `apac.`, `global.`...), or an ARN. Some newer models can only be called through an inference profile.
- **Region:** `AWS_REGION` (or `AWS_DEFAULT_REGION`), default `us-east-1`. One region per run.
- **Permissions:** `bedrock:InvokeModel`, plus `bedrock:ListFoundationModels` for `scan --live`.
- **`scan --live`** reads Bedrock's model list for your region and flags models Bedrock has marked **LEGACY**, which is Bedrock's deprecation status. An inference profile is checked against the base model it points to. A model missing from the list may be retired, or simply not offered in your region.
- **Embeddings:** `bedrock:amazon.titan-embed-text-v2:0` (one call per text) or `bedrock:cohere.embed-english-v3` / `cohere.embed-multilingual-v3` (batches of 96).
- **Promptfoo configs** with `bedrock:` providers, including the `converse:` and `mantle:` forms, map to these IDs automatically. Bedrock agents, knowledge bases and image or video models are not chat models and are skipped.

---

## How the testing is done

Here is what happens, step by step, when you run `modelshift run`:

1. **Plan and check before spending.** modelshift reads the samples, checks that every model is written `provider:model` and that its credentials are set, then prints a plan: the number of calls, how many are already cached, and an approximate token count (and cost, with `--prices`). Above 60 new calls it stops until you add `--yes`.
2. **Call both models.** Every sample is sent `--repeats` times to the baseline and to each candidate, with the same messages, tools, temperature, token limit and JSON setting. Calls run in parallel (`--concurrency`).
3. **Retry what's temporary.** Rate limits (HTTP 429), overloaded responses (529), server errors (500 to 504), timeouts and network errors are retried up to 4 times with exponential backoff (1.5 s, 3 s, 6 s, with jitter). Errors that won't go away by retrying, such as a wrong key or a missing model, are not retried. Each call times out after 120 seconds.
4. **Cache every successful answer.** Answers are stored in `.modelshift/cache`, keyed by the model, the exact request and the repeat number. Re-running, adding a candidate, or adding the judge only pays for calls not made before. Failed calls are never cached, so they're retried next time.
5. **Optional extra checks.** With `--judge`, a third model compares answers (see [LLM judge](#llm-judge)). With `--embed`, every distinct answer is embedded once to compare meaning (see [Meaning](#meaning-semantic)).
6. **Score each sample.** Each [check](#every-part-of-the-report-explained) turns each answer into a score, usually 1 (pass) or 0 (fail). Per sample, modelshift averages the baseline's repeats and the candidate's repeats, and records how much the baseline's repeats disagree with each other (the noise).
7. **Compare, with statistics.** For each check, the per-sample differences (candidate minus baseline) are tested with a paired bootstrap, corrected for running several checks at once, and compared with the noise floor (see [Methodology](#methodology-the-statistics)).
8. **Look for problems.** Failed calls, samples left out, cut-off answers, and judge or embedding calls that failed are collected and shown at the top of the report (see [Problems during testing](#problems-during-testing)).
9. **Decide the verdict** using fixed rules (see [the verdict](#the-verdict)), and write the results JSON, the terminal summary, and the HTML or markdown report if asked.

Every request is sent to the old and the new model **in the same form**, so the comparison is fair. modelshift never rewrites your prompts.

---

## Methodology: the statistics

LLMs are random: the same model can give different answers to the same question. A good migration test has to separate **real changes** from **normal randomness**, without crying wolf. These are the methods modelshift uses, and why.

### 1. The noise floor: how much the old model disagrees with itself

Each sample is sent to the baseline several times (`--repeats`, default 3). For each check, modelshift measures how much the baseline's own answers differ, as the mean absolute difference between every pair of repeats. Averaged across samples, this is the check's **noise floor**: the size of change you'd expect from randomness alone. A change smaller than the noise floor is never flagged, however consistent it looks.

### 2. Paired comparison

Every sample is answered by both models, so each sample is compared with itself: the score for a sample is *candidate average − baseline average*. Pairing removes the difference between easy and hard samples, which makes the test far more sensitive than comparing two overall pass rates.

### 3. Bootstrap confidence intervals and p-values

modelshift resamples the per-sample differences 2,000 times (with a fixed seed, so a report is reproducible) to get:
- a **95% confidence interval** for the average change: the range the true change very likely lies in, and
- a one-sided **p-value**: how surprising the observed worsening would be if the new model were really no worse.

No assumptions about the shape of the data are needed, which suits pass/fail scores.

### 4. Correcting for running several checks at once

A run tests up to eight checks. Testing each at 95% confidence would raise a false alarm *somewhere* far more often than 5% of the time. So the p-values of the paired checks are adjusted together with the **Holm** method, which keeps the overall false-alarm rate at 5%.

Some checks can never be significant: if only one or two samples changed, no test could rule out chance. Counting them would make the correction stricter for no benefit, so a check only joins the correction if its smallest possible p-value, `2 × ((n − k) / n)^n` for `n` samples of which `k` changed, is below 0.05. (This is the idea behind Tarone's correction.)

### 5. When a check is flagged

A paired check is flagged as **worse** only when **both** are true:
1. its corrected p-value is below 0.05, **and**
2. the average change is bigger than the noise floor (plus a minimum effect size for continuous scores, 0.02 for the meaning check).

A check that is worse on its own but not after the correction is a **near miss**. It makes the verdict *review*, with a note to add samples.

### 6. When the old model is gone: candidate-only mode

If every baseline call fails, there is nothing to pair with. Checks that don't need a baseline (your `expect` rules, JSON validity for `json` samples, refusals, and the judge against the logged `reference`) are scored on the candidate alone, with a 95% interval. A check whose pass rate is below 90% (or whose refusal rate is above 10%) is marked for review. Checks in this mode can never make the verdict *not safe*, because there's no baseline to be worse than; only the errors check, which counts failed calls on both sides, still can. The report lists the dead baseline as a problem.

### 7. Behaviour drift (model-free)

Separately from the checks, modelshift measures how much the answers change in wording. For each sample it compares:
- how similar the baseline's answers are to **each other**, and
- how similar the candidate's answers are to the **baseline's**,

using word overlap (the Jaccard similarity of the sets of words, which works for any language and needs no model). If the candidate is reliably less similar to the old model than the old model is to itself (the 95% interval of the difference is above zero), the report notes **behaviour drift** and the verdict becomes *review*. Drift alone never makes it *not safe*: different wording can be fine.

### 8. Confidence

The confidence level reflects how much data the verdict rests on:

| Samples | Confidence |
|---|---|
| fewer than 20 | low |
| 20 to 49 | medium |
| 50 or more | high |

It is then lowered: to *medium* at most when the old model couldn't be called, or when any problem occurred during testing, and to *low* when a problem stopped part of the test.

### 9. How well it works

We checked the method by simulation:
- **False alarms.** In 1,000 simulated runs where the new model behaves *exactly* like the old one, `run` said *not safe* **1.4%** of the time, within the 5% it's designed for. Without the correction for multiple checks it was 3.3%.
- **Real regressions.** A real 30-point drop in JSON validity and expected-output rules is caught in at least 18 of 20 simulated runs.

Smaller versions of both simulations (200 identical-model runs; 20 runs with a real drop) run in the test suite, in `test/stats.test.ts`.

### 10. What "likely safe" means

It means: *on these samples, no check got worse by more than the old model's own randomness, and every part of the test ran.* It is **never a guarantee**. It can't cover requests your samples don't represent; see [Limitations](#limitations-what-modelshift-cant-tell-you).

---

## Understanding the report

The same results appear in three forms: the **terminal summary** after a run, the **HTML report** (`--html` or `modelshift report`), and the **markdown summary** (`--markdown`) for pull requests. They contain the same parts, in the same order.

A real run on 24 samples from a production app's language-detection and extraction prompts, on DeepInfra:

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

How to read it, top to bottom:

1. **The two models** and the amount of data: 24 samples, each sent twice to each model.
2. **The verdict and confidence.** Here, *not safe to switch yet*, with medium confidence because there are 24 samples.
3. **The reasons.** Each flagged check, with the old and new pass rates, the 95% interval of the change, and the noise floor. Here the judge found the smaller model's answers equivalent only 78% of the time, against 100% for the old model agreeing with itself.
4. **Problems during testing**, if any (none here).
5. **The checks table.** Every check that applied, flagged ones marked `✗`. The JSON-shape and assertions checks also got worse, but on 24 samples their intervals still include zero, so on their own they aren't conclusive.
6. **Performance**: median latency, output tokens and, with `--prices`, cost.
7. **Examples** of answers that got worse, old and new side by side.

The verdict in plain words: the smaller model looks fine at a glance and is faster, but it drops required JSON fields and confuses Indian languages.

### The verdict

| Verdict | Shown as | When |
|---|---|---|
| **Not safe to switch yet** | 🔴 `NOT SAFE TO SWITCH YET` | At least one *fail*-level check (errors, valid JSON, JSON keys, tool calls, refusals, your expected outputs, judge) got worse beyond the noise floor, significant after correction. |
| **Review before switching** | 🟡 `REVIEW BEFORE SWITCHING` | Nothing failed outright, but at least one of these: a near miss; the meaning check flagged; behaviour drift; a check fell short in candidate-only mode; a model was silently redirected; median latency more than doubled; **or part of the test didn't run** (a blocking problem). |
| **Likely safe to switch** | 🟢 `LIKELY SAFE TO SWITCH` | None of the above, and every part of the test ran. |

*Not safe* takes priority over *review*. An incomplete test can still be *not safe*, because a regression found on part of the data is still real, but it can never be *likely safe*.

### Reasons

Each line under the verdict explains one finding:

| Reason starts with | Means |
|---|---|
| `Testing was incomplete (...)` | A problem stopped part of the test, so the model can't be cleared. See [Problems during testing](#problems-during-testing). |
| `<check>: A → B (95% CI of change ... beyond the baseline's own variation of ±N; significant after correcting for K checks)` | This check got worse, for real. |
| `<check>: ... is worse on its own, but not after correcting for K checks. Add samples to confirm.` | A near miss: probably worse, but not proven on this many samples. |
| `semantic: ... Review examples.` | The meaning of the answers changed more than the old model's own variation. |
| `<check>: candidate scores N on its own ...; no baseline to compare.` | Candidate-only mode: the old model couldn't be called, and this check fell short. |
| `behaviour drift: ...` | The wording changed more than the old model's own variation. |
| `latency: median A ms → B ms` | The new model is more than twice as slow. |
| `baseline redirected:` / `candidate redirected:` | The provider served a different model than the one you named, so you're comparing the wrong model. |
| `baseline unavailable: all N baseline calls failed (...)` | The old model may already be gone; candidates are judged on their own. |
| `No regression beyond the baseline's own run-to-run variation was detected.` | Nothing was flagged. |

---

## Every part of the report, explained

### Header (HTML)

The report title, the generation time, and the models compared. With several candidates, a **Candidates compared** table comes first: one row per candidate with its verdict, its score on each check (flagged ones in red), and median latency. A candidate whose test was incomplete is marked **Incomplete**. In the terminal the same table ends each run, with `*` after an incomplete candidate's verdict.

### Verdict box

The verdict, the confidence, the number of samples and repeats, and a one-line explanation. The colour matches the verdict: green, amber or red.

### Reasons

See [Reasons](#reasons) above.

### Problems during testing

A red box (something stopped part of the test) or amber box (warnings only), listing what went wrong. It is only shown when something went wrong. See [Problems during testing](#problems-during-testing).

### "Served as" note (HTML)

The model name each provider reported actually serving, next to the one you requested. Normally they match, or differ only by a dated snapshot name. If they really differ, the run is also flagged as *redirected*.

### Checks table

One row per check that applied to at least one sample.

| Column | Meaning |
|---|---|
| **Check** | The check's name and a one-line description. |
| **Baseline** | The old model's average score on the samples this check applied to. For rate checks, the share of answers that passed (or, for errors and refusals, that failed). |
| **Candidate** | The same for the new model. |
| **Change (95% CI)** | Candidate minus baseline, and the 95% interval of that change. *candidate only* when there was no baseline. |
| **Change vs noise** (HTML) | A small chart: the shaded half is the *worse* side, the grey band around zero is the noise floor, and the dot and line are the change and its interval. Red when the check is flagged. A real regression's line sits entirely on the shaded side, outside the grey band. |
| **Noise** | The noise floor: how much the old model's own repeats disagree on this check. |
| **n** | The number of samples the check could be computed on. |
| **Status** (HTML) / mark (text) | `ok`; `worse` / `✗` (flagged, makes the verdict *not safe*); `review` / `⚠ review` (a review-level flag); `below 90%` (candidate-only mode). |

#### The checks

| Check | What it measures | Applies to | Level |
|---|---|---|---|
| **errors** (Call errors) | Share of calls that failed after retries: HTTP errors, model not found, timeouts. | Every sample. | fail |
| **json-valid** (Valid JSON) | Whether the answer parses as JSON (a ```` ```json ```` fence is allowed). | Samples with `json: true`, or where the old model answers with JSON at least half the time. Tool-call answers are skipped. | fail |
| **json-shape** (Same JSON keys) | Whether the answer's top-level JSON keys are the same as the old model's most common set of keys (a JSON list counts as one shape). Catches dropped or renamed fields. | Samples where the old model answers with JSON. | fail |
| **tool-calls** (Same tool calls) | Whether the answer calls the same set of tools as the old model usually does (or, like it, calls none). | Samples with `tools`, or where the old model called a tool. | fail |
| **refusals** | Share of answers that look like a refusal ("I can't help with...", "As an AI...", "I must decline", in the first 400 characters). Tool calls never count. | Every sample. | fail |
| **assertions** (Your expected outputs) | Share of answers that pass the sample's `expect` rules. | Samples with `expect` rules. | fail |
| **judge** (LLM judge) | Share of answers the judge model rates an acceptable substitute for the old model's answer. | Runs with `--judge`. | fail |
| **semantic** (Meaning) | Average meaning similarity of the new answers to the old ones, against the old answers' similarity to each other. | Runs with `--embed` and `--repeats` 2 or more. | review only |

*fail*-level checks can make the verdict *not safe*. *review*-level checks can only make it *review*.

<a id="llm-judge"></a>
#### LLM judge (`--judge`)

For open-ended answers, such as summaries, advice or support replies, rules can't say whether a new answer is still good. The judge is a third model that answers one question per answer: *is this new answer an acceptable substitute for the reference answer, for this task?* It replies `SAME` or `DIFFERENT`, at temperature 0. It is told to ignore wording, style, ordering and politeness, and to focus on facts, decisions, required format and fields, and missing or added content.

The judge is **calibrated against the old model**. The reference is the old model's first answer. The judge rates the old model's *other* answers against it, which shows how often the old model "disagrees with itself", and then rates every new answer against the same reference. The new model is only flagged if it differs more often than the old model does. This cancels much of a judge's bias.

Tips: use a strong model that is neither the old nor the new one, and use `--repeats 2` or more (with 1 repeat there's no self-agreement to compare with). The judge makes up to `samples × (2 × repeats − 1)` calls, all cached.

<a id="meaning-semantic"></a>
#### Meaning (`--embed`)

An embedding model turns each answer into a vector, and cosine similarity measures how close two answers are in meaning. For each sample, modelshift compares the new answers' similarity to the old ones with the old answers' similarity to each other. The check is flagged *review* when the new answers are reliably more than 0.02 less similar. It's cheaper and more repeatable than a judge, but it measures *sameness*, not *quality*, so it never makes the verdict *not safe* on its own. It needs `--repeats` 2 or more. Every distinct answer is embedded once, in batches, and cached.

### Similarity / behaviour drift row

`similarity  1.00  0.83  drift 0.167 [0.000, 0.417]` means: the old model's answers overlap with each other by 1.00 on average (identical wording), the new answers overlap with the old by 0.83, and the drift is the difference with its 95% interval. Marked `✗` (or ⚠ in HTML) when the interval is entirely above zero. See [Behaviour drift](#7-behaviour-drift-model-free).

### Performance

| Row | Meaning |
|---|---|
| **Latency (median)** | The middle response time of successful calls, for each model. A "—" means the model never answered. More than doubling makes the verdict *review*. |
| **Output tokens (median)** | How long answers are. Big changes affect cost, and sometimes mean the model is more verbose or is cutting answers short. |
| **Cost per call (mean)** | With `--prices`: the average cost of a call, from the token counts each provider reports. |

### Examples of what changed

Up to three examples per check of answers that got worse, the old answer next to the new one, labelled with the check and the sample ID. Errors appear as `[error] <message>`.

### Every sample (HTML)

One expandable row per sample (up to 300; the results JSON has them all), with the input, the old model's first answer and the new model's first answer. Badges show the expected-output pass rate (and what it was before), error counts and the judge's agreement. Rows where something got worse start open.

### Markdown summary

The markdown version (`run --markdown` or `report --markdown`) has the verdict with 🟢 / 🟡 / 🔴, the reasons, problems as a GitHub **Caution** or **Warning** callout, and the checks table with ✅ / ⚠️ / ❌. It is designed for pull-request comments and CI job summaries.

### The results JSON

`modelshift-results.json` keeps everything, so a report can be rebuilt or re-analysed at any time:

| Key | Contents |
|---|---|
| `meta` | The baseline and candidate, repeats, start and finish time, tool version, and the judge and embedding models used. |
| `samples` | The samples exactly as tested. |
| `runs` | Every answer from every model and repeat: text, tool calls, tokens, latency, finish reason, served model or error; plus judge scores and meaning scores. |
| `analysis` | `verdict`, `confidence`, `reasons`, `problems`, `metrics` (each check's numbers, p-values, noise floor and flags), `drift`, `perf` and `examples`. |

---

## Problems during testing

When something goes wrong while testing, modelshift says so at the top of every report, never hides it, and won't call a model safe on the basis of an incomplete test.

Each problem is either:
- **✖ Blocked**: part of the test didn't run. The verdict can't be *likely safe*, confidence drops to low, the first reason says *Testing was incomplete*, and `--fail-on-unsafe` exits with code 1.
- **! Warning**: everything ran, but some results rest on less data than planned. Confidence is at most medium.

A real example, with a candidate model ID that doesn't exist on Bedrock:

```
Verdict: NOT SAFE TO SWITCH YET  (confidence: low — add more samples; never a guarantee)
  - Testing was incomplete (16 of 16 candidate calls failed), so this can't be called safe. See "Problems during testing".
  - errors: 0.0% → 100.0% (95% CI of change 100.0% to 100.0%, beyond the baseline's own variation of ±0.0%)

Problems during testing (1, 1 stopped part of the test):
  ✖ 16 of 16 candidate calls failed
    candidate (bedrock:eu.amazon.nova-nonexistent-v9:0): "HTTP 400: The provided model identifier is invalid." (×16).
    The candidate never answered, so none of its behaviour was tested. The model id may be wrong, not offered in this region, or already retired.
```

| Problem | Level | What it means | What to do |
|---|---|---|---|
| **N of M candidate calls failed** | Blocked if all failed or 20% or more; warning otherwise | Part of the new model's behaviour wasn't tested. The errors are grouped, most common first, with the likely cause. | Follow the hint: fix credentials, model ID or region, or lower `--concurrency` and re-run. Successful answers are cached, so a re-run only repeats the failed calls. |
| **N of M baseline calls failed** | Warning | Fewer samples could be compared. If *all* failed, the old model is probably gone, and candidates are judged on their own against your expected outputs. | If the old model still exists, fix the cause and re-run. If it's gone, add `expect` rules (or keep the logged `reference` and use `--judge`) so the candidate is still tested. |
| **N settings had to change for the candidate (or baseline) model: your code will need these changes too** | Warning | The model rejected a setting your requests use, such as `temperature: 0`. modelshift changed the request to test the model anyway, and lists each change with the number of calls affected. The results show the model with the changes applied. | Make the same changes in your code when you switch. See [Settings a newer model rejects](#settings-a-newer-model-rejects). |
| **N samples had no baseline answer** | Warning | Those samples are left out of the paired checks; they're listed by ID. | Re-run to retry them. |
| **N samples had no candidate answer** | Warning | Only the errors check covers them. | Re-run to retry them. |
| **N samples got no answer from either model** | Warning | Those samples weren't tested at all. | Check those inputs; they may be too long or rejected by both providers. |
| **N answers were cut off by the token limit** | Warning | Answers that hit `max_tokens` can fail JSON or rule checks for that reason alone, which looks like a regression. | Raise `max_tokens` in the samples (or in the Promptfoo config) and re-run. |
| **The judge check didn't run** | Blocked | Every judge call failed, so answer quality wasn't compared. | Check the judge model's key and ID, then re-run. Model answers are cached, so only the judge is called again. |
| **N of M judge calls failed** | Blocked at 20% or more; warning otherwise | The judge check rests on fewer answers than planned. | Re-run to retry; successful judgements are cached. |
| **The meaning check didn't run** | Blocked | No answers could be embedded. | Check the embedding model's key and ID, then re-run. |
| **The meaning check needs --repeats 2 or more** | Warning | With one repeat there's no old-model variation to compare with. | Re-run with `--repeats 2` or more. |
| **N samples missing from the meaning check** | Warning | Some answers couldn't be embedded. | Re-run to retry. |
| **Too few samples to test the X check** | Warning | The check got worse on a few samples, but too few changed for any result to be significant. | Add samples that exercise this check. |

**Error hints.** For failed calls, modelshift looks at the error and adds the likely cause:

| Error looks like | Hint |
|---|---|
| 401, 403, unauthorized, forbidden, access denied, invalid API key, security token, signature | Check the API key or credentials, and that they're allowed to call this model. |
| 429, rate, throttling, quota, too many requests | The provider rate-limited the calls: lower `--concurrency` or raise your quota, then re-run. |
| 404, not found, does not exist, model identifier is invalid, end of life | The model ID may be wrong, not offered in this region, or already retired. |
| timeout, connection reset, fetch failed, DNS errors | Network or timeout problems: re-run to retry. |
| 5xx, overloaded, internal | The provider had server errors: re-run later. |

`scan --live` has its own **Live check incomplete** list: providers whose model list couldn't be read (✖, with the error), providers skipped because no key was set (!), and probes that didn't run. Models from those providers were only checked against the calendar.

---

## Understanding a scan

### Statuses

| Status | Colour | Meaning | Found by |
|---|---|---|---|
| **ALREADY SHUT DOWN** | red | Past its published shutdown date. Calls are failing or will soon. | calendar |
| **NOT SERVED ANYMORE (probe)** | red | The host returned model-not-found for a real request. | `--probe` |
| **SILENTLY REDIRECTED (probe)** | red | The host answered a real request with a different model under this name. Your app isn't running the model it names. | `--probe` |
| **NOT IN MODEL LIST (live)** | yellow | Missing from the host's model list today. Run `--probe` to see whether it fails or is redirected. On Bedrock, it may just not be offered in your region. | `--live` |
| **DEPRECATED BY PROVIDER (live)** | yellow | The provider's model list marks it deprecated or with an expiry date (for Bedrock, the LEGACY status). | `--live` |
| **RETIRING** | yellow | Has a published shutdown date in the future. The number of days left is shown. | calendar |
| **DEPRECATED (date TBA)** | yellow | Deprecated, with no shutdown date announced yet. | calendar |
| **CHECK ALIAS** | cyan | An undated alias, such as `gpt-4o`, whose dated snapshots are retiring. Find out which snapshot it points to. | calendar |

Each entry shows the replacement the provider recommends (when there is one), every file and line where the ID is used, and the source of the retirement date.

### How the checks work

1. **Find model IDs.** Model IDs are recognised in string literals and config values by provider-specific patterns: OpenAI, Anthropic, Google, Mistral, Cohere, DeepSeek and Bedrock IDs, and `org/model` IDs for open-weight models. Fine-tuned OpenAI models (`ft:gpt-4o-mini-...`) follow their base model. Gateway IDs like `openai/gpt-4o-mini` are resolved to the real model.
2. **Check the retirement calendar.** [`data/retirements.json`](data/retirements.json) is copied from the providers' official deprecation pages, and every entry cites its source.
3. **Live check (`--live`).** Each relevant provider's model-list endpoint is read with your key. An open-weight ID is only checked against hosts your code actually references, because ID formats differ between hosts and guessing would cause false alarms.
4. **Probe (`--probe`).** For models missing from a list, modelshift sends one request with a 1-token answer and reads the `model` field the host reports. The result is *missing* (a real model-not-found), *silently redirected* (another model answered), or *still served* (only missing from the list). Each probe costs a fraction of a cent.

<a id="fail-on-levels"></a>
### `--fail-on` levels

| Level | Fails (exit 1) on |
|---|---|
| `retired` | Already shut down, or not served anymore. |
| `retiring` | The above, plus silently redirected, deprecated by provider, and retiring. |
| `any` | Every status in the table above. |

---

## Error messages and what they mean

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. For `scan --fail-on` and `run --fail-on-unsafe`, nothing was flagged. |
| `1` | Something was flagged (`scan --fail-on`, `run --fail-on-unsafe`), a usage error, or the spend guard stopped a large run. |
| `2` | An unexpected error, printed as `modelshift: <message>`. A missing API key also ends here. |

### Setup and usage errors

| Message | Cause and fix |
|---|---|
| `Model must be "provider:model" (e.g. openai:gpt-4o-2024-08-06), got "..."` | The model was written without a provider. Add one, for example `openai:`. |
| `Unknown provider "x". Supported: openai, deepinfra, ...` | That provider isn't supported (yet). See [Supported providers](#supported-providers). |
| `Missing API key for <provider>: set <VARIABLE>` | Set the environment variable named in the message. |
| `Missing AZURE_OPENAI_ENDPOINT for azure:<deployment>` | Set it to `https://<resource>.openai.azure.com`. |
| `Missing AWS credentials for bedrock: set AWS_BEARER_TOKEN_BEDROCK ...` | Set a Bedrock API key or AWS access keys; see [AWS Bedrock in detail](#aws-bedrock-in-detail). |
| `Anthropic has no embeddings API; use e.g. --embed openai:text-embedding-3-small ...` | Choose an embedding model from another provider. |
| `Usage: modelshift run --from <provider:model> --to <provider:model> ...` | `--from` or `--to` is missing. |
| `Samples file not found: ... Create one with "modelshift capture <logs.jsonl>".` | Create a samples file, or point `--samples` at yours. |
| `No samples in <file>.` | The samples file is empty or no line could be read. |
| `This will make N paid API calls. Re-run with --yes to proceed, or lower --repeats / use fewer samples.` | The spend guard: more than 60 calls. Add `--yes` if the plan looks right. |
| `--fail-on must be one of: retired, retiring, any` | Use one of those three levels. |
| `Unknown option --x. Did you mean --y?` | A misspelt or unsupported option. modelshift stops rather than ignore it, so a typo such as `--fail-on-unsafee` can't silently switch off a CI gate. Run `modelshift --help` for the list. |
| `--x needs a value.` | An option such as `--from` or `--samples` was given without a value. Both `--from openai:gpt-4o` and `--from=openai:gpt-4o` work. |
| `Not a directory: <path>` | `scan` was given a path that isn't a folder. |
| `No usable requests found in <file> (N lines skipped).` | The log isn't in one of the [accepted formats](#capture-build-a-test-set-from-your-logs). |
| `Results file not found: ...` / `... is not a modelshift results file.` | `report` needs the JSON written by `run`. |

### Warnings during a run

| Message | Meaning |
|---|---|
| `warning: N outputs could not be embedded with <model>: <error>` | Part of the meaning check failed. It's also listed in the report's problems. |

Failed model calls are not printed as warnings while the run is going. They are grouped under [Problems during testing](#problems-during-testing) at the end.

### Provider errors you may see in reports

| Error | Usual cause |
|---|---|
| `HTTP 401` / `HTTP 403` | Wrong or expired key, or the key isn't allowed to use this model. On Bedrock: missing `bedrock:InvokeModel` permission, or the model needs one-time access approval in the console. |
| `HTTP 400: The provided model identifier is invalid.` (Bedrock) | Wrong model ID, not available in this region, or it needs an inference profile (`us.`, `eu.`...). |
| `HTTP 404` / `model not found` / `does not exist` | Wrong model ID, or the model has been removed. |
| `HTTP 429 ... (after 4 attempts)` | Rate limited even after retries. Lower `--concurrency` or raise your quota. |
| `HTTP 5xx` / `HTTP 529` / `overloaded` | Provider-side trouble. Re-run later; cached answers aren't requested again. |
| `timeout (after 4 attempts)` | No answer within 120 seconds, four times. Usually a very long output or an overloaded host. |

### Import errors (`import promptfoo`)

| Message | Meaning |
|---|---|
| `No Promptfoo config found. Give its path: ...` | No `promptfooconfig.yaml/.yml/.json` in this folder. |
| `Could not import <file>: no prompts that modelshift can replay (...)` | Every prompt was a JS/Python function or couldn't be read; the reasons are in brackets. |
| `... (red-team configs generate their tests when Promptfoo runs)` | Red-team configs can't be imported. |
| `Could not import <file>: no test cases that modelshift can read (...)` | Tests come from code, a URL or a dataset. Export them to CSV or JSONL. |
| `Note: prompt X: prompt functions (JS/Python) can't be imported; skipped.` | That prompt was skipped; the others were imported. |
| `Note: tests from <ref> are generated by code; ...` / `... are fetched when Promptfoo runs; ...` | Those tests were skipped. |
| `Note: N prompt × test combinations use Nunjucks tags ({% %}), ...; skipped` | Templates with logic aren't evaluated. |
| `Note: tools from <file> can't be loaded; samples are imported without tools` | The tools file is code or missing. |
| `Note: N provider tools aren't function tools (e.g. built-in search) and were left out` | Built-in tools can't be replayed. |
| `Note: Bedrock providers use region X: set AWS_REGION=X before modelshift run` | Bedrock region comes from the environment, not the config. |
| `Providers without a modelshift adapter: ...` | Those providers can't be called by `run`. |
| `Not translated: <assertion> ×N: <hint>` | Those assertions weren't converted; follow the hint (usually `--judge` or `--embed`). |
| `<type> (transformed output) ×N` | Assertions on transformed outputs were skipped to avoid false regressions. |

YAML errors name the line: `line N: tabs can't be used for indentation in YAML`, `multiple YAML documents aren't supported`, `YAML tags (like !!str) aren't supported`, `unknown alias *name`, `unterminated quoted string`, `complex keys aren't supported`, or `unexpected content ... (check the indentation)`. modelshift has its own small YAML reader with no dependencies; if your config uses an unsupported YAML feature, convert that file to JSON.

---

## Using it in CI (GitHub Action)

### Daily watch for retirements

Opens (and later closes) an issue when a model you use is retiring, removed or silently redirected: [`examples/workflows/modelshift-watch.yml`](examples/workflows/modelshift-watch.yml).

```yaml
- uses: angledsapiens/modelshift@v0
  with:
    probe: "true"        # live lists + 1-token probes
    fail-on: retiring
  env:
    DEEPINFRA_API_KEY: ${{ secrets.DEEPINFRA_API_KEY }}
```

Or without the action:

```yaml
on:
  schedule: [{ cron: "0 7 * * *" }]
jobs:
  models:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx modelshift scan --live --fail-on retiring
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

### Pull-request gate for a model change

Replays your samples on the current and proposed models, comments the verdict on the pull request, uploads the HTML report, and fails when the result is *not safe yet* or the test was incomplete: [`examples/workflows/modelshift-gate.yml`](examples/workflows/modelshift-gate.yml).

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

### Action inputs and outputs

| Input | Default | For | Meaning |
|---|---|---|---|
| `command` | `scan` | both | `scan` or `run`. |
| `path` | `.` | scan | Folder to scan. |
| `live` | `false` | scan | Check live model lists. |
| `probe` | `false` | scan | Probe unlisted models (implies `live`). |
| `providers` | all relevant | scan | Comma-separated providers to check live. |
| `fail-on` | `retiring` | scan | `retired`, `retiring` or `any`. |
| `from` / `to` | — | run | Current model and replacement(s). |
| `samples` | `modelshift-samples.jsonl` | run | Samples file. |
| `repeats` | `3` | run | Repeats per sample per model. |
| `judge` | — | run | Optional judge model. |
| `fail` | `true` | both | Fail the step when flagged (scan: at the `fail-on` level; run: *not safe* or testing incomplete). |
| `comment` | `false` | both | Post or update a pull-request comment (needs `pull-requests: write`). |
| `version` | `latest` | both | modelshift version from npm, or `source` to build the action's own checkout. |

Outputs: `status` (`ok` or `flagged`), `markdown` (path to the summary) and, for `run`, `report` (path to the HTML report). Every result is also written to the job summary. `run` in the action uses `--yes`, so set your samples and repeats with cost in mind.

---

## Cost control

- **You see the plan first.** Every run prints the number of API calls, how many are already cached, and an approximate token count (and cost with `--prices`) before spending anything.
- **Spend guard.** Above 60 new calls (judge calls included), `run` stops until you add `--yes`. Through MCP, the agent must ask you first.
- **Cache.** Successful answers are reused, so re-runs, extra candidates and adding a judge only pay for new calls. The baseline is called once even with several candidates.
- **The calls:** `samples × repeats × (1 + candidates)`, plus up to `samples × (2 × repeats − 1)` judge calls per candidate, plus a few embedding batches.
- **Cheap first pass.** Start with `--repeats 2` and 20 to 50 samples. Add samples where the result is a near miss.
- **Probes** in `scan --probe` use a 1-token answer: a fraction of a cent each.

---

## Privacy and security

- **Local-first.** modelshift runs on your machine. Requests go only to the model providers you name, using your own keys. There is no telemetry.
- **Keys** are read from environment variables and only ever sent to their own provider. They are never written to results, reports or the cache.
- **The cache** (`.modelshift/cache`) holds your prompts and the models' answers. It gets its own `.gitignore`, so it isn't committed by accident. Delete the folder to clear it.
- **Reports and results files contain your samples' text.** Review them before sharing outside your team.
- **Redaction** in `capture` is on by default, but best effort. Check samples from sensitive logs before testing with them.
- **No code runs from your configs.** The Promptfoo importer reads files; it never executes JavaScript or Python from them.

---

## Limitations: what modelshift can't tell you

- **It only knows your samples.** A clean result means no regression *on these samples*. Requests unlike your samples aren't covered. Use samples spread across your real traffic (`capture --limit` spreads them for you).
- **Small samples mean wide intervals.** With fewer than 20 samples, only large changes can be detected. The confidence level says so.
- **Checks measure what they measure.** Rules, JSON and tool checks are precise but narrow. The judge and meaning checks are broader but depend on the judge or embedding model. None of them replaces a human look at the examples.
- **One turn at a time.** Each sample is one request. Multi-turn conversations are replayed with the logged history, not as a live conversation, and tool results aren't fed back.
- **Tool arguments** aren't compared yet, only which tools were called.
- **Bedrock has no JSON mode** in the Converse API, so JSON-mode samples rely on the prompt there.
- **The calendar** is only as current as its last update; `--live` and `--probe` catch what it misses.

---

## FAQ and troubleshooting

**How many samples do I need?** At least 20 for medium confidence, 50 or more for high. Spread them across your real use cases. More samples matter more than more repeats.

**How many repeats?** The default of 3 measures the old model's randomness well. 2 is the minimum for the noise floor, the judge and the meaning check.

**Why "review" and not a clear answer?** Something deserves a human look but isn't proven to be worse: a near miss, changed wording or meaning, a slower model, a redirected model, or an incomplete test. The reasons and problems say which.

**The verdict says "not safe", but the examples look fine to me.** Look at the flagged check. For example, JSON keys may have changed in a way your code depends on, or the judge may see a difference in facts. If the difference truly doesn't matter, adjust that sample's `expect` rules.

**Can I compare more than one replacement?** Yes: `--to a,b,c`. The old model is called once and each candidate gets its own verdict, plus a comparison table.

**The old model is already gone. Can I still test?** Yes. Keep the logged answers as `reference` and add `expect` rules; candidates are then judged on their own, and the report says so.

**A run failed halfway (rate limits, network).** Just run the same command again. Successful answers are cached, so only the failed calls are repeated.

**I use an AWS profile or `aws login`, not access keys.** Export that session's keys into the environment: `eval "$(aws configure export-credentials --profile <name> --format env)"`.

**Can I use my own judge prompt or checks?** Not yet. Your own rules go in each sample's `expect`.

---

## Roadmap

- Hosted retirement alerts across many repos (email or Slack)
- Prompt adaptation hints for the new model
- More log importers (LangSmith, OpenTelemetry GenAI spans)
- Multi-turn conversations, and tool-call order and argument checks

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the details.

- **Retirement calendar:** spotted a retirement we're missing or a wrong date? Use the [retirement report](https://github.com/angledsapiens/modelshift/issues/new?template=retirement.yml) form, or open a pull request that edits [`data/retirements.json`](data/retirements.json) and cites the official source.
- **Code:** `npm test` builds and runs the full suite, and CI runs it on Linux, Windows and macOS. modelshift has no runtime dependencies, and we'd like to keep it that way.
- **Sign-off:** sign your commits with `git commit -s` ([Developer Certificate of Origin](https://developercertificate.org/)). There's no contributor licence agreement.
- **Security problems:** report them privately; see [SECURITY.md](SECURITY.md).
- Bugs and ideas are welcome as [issues](https://github.com/angledsapiens/modelshift/issues/new/choose).

## License

MIT. The CLI, checks, calendar, report, GitHub Action and MCP server are, and will stay, free and open source.
