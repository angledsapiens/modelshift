---
name: modelshift
description: Check a codebase for LLM models that are retired, retiring, removed or silently redirected by their host, and test whether a replacement model behaves the same before switching. Use when the user mentions a model deprecation or shutdown notice, migrating or upgrading an LLM model, API errors like model_not_found, a host (DeepInfra, Together, OpenRouter, etc.) changing models, or asks which models their code uses.
---

# modelshift: model retirement checks and migration tests

`modelshift` is a CLI (`npx modelshift`) and MCP server. Prefer the MCP tools (`scan_models`, `retirement_calendar`, `capture_samples`, `run_migration_test`, `render_report`) when they are connected; otherwise run the CLI.

## 1. Find what the code uses and what is at risk (free)

```bash
npx modelshift scan                 # retirement calendar only, no keys needed
npx modelshift scan --live --probe  # also ask hosts what they actually serve under each name
```

- `--live` reads each provider's model list with keys from the environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, DEEPINFRA_API_KEY, ...). DeepInfra and OpenRouter work without a key.
- `--probe` sends one 1-token request per model that is missing from a host's list. It costs a fraction of a cent, but say so before running it.
- **SILENTLY REDIRECTED** means the host answers that model name with a different model. Nothing errors, but behaviour has changed. Treat it as urgent as a removal: the code, docs and evals describe a model that is no longer running.
- **CHECK ALIAS** means an undated alias (e.g. `gpt-4o`) whose dated snapshots are retiring.

Report findings with file:line locations and the suggested replacement. Do not edit model ids until the user picks a replacement.

## 2. Build a test set

Best: real traffic. `npx modelshift capture logs.jsonl` turns OpenAI-style request/response logs, Langfuse exports or `{prompt, output}` lines into `modelshift-samples.jsonl` (PII redacted by default).

No logs? Write samples from the prompts in the code: one JSON object per line with `id`, `messages`, optional `json: true`, and `expect: {"match": [regex...], "notMatch": [regex...]}` for what a correct answer must contain. Cover each prompt with varied, realistic inputs, including tricky ones; 20 is the minimum for medium confidence, 50+ for high.

## 3. Compare old vs new (paid: get the user's OK)

```bash
npx modelshift run --from <provider:model> --to <provider:model>[,<provider:model>...] --html modelshift-report.html
```

- The command prints the number of API calls first and refuses above 60 without `--yes`. **Show the plan and get the user's approval before adding `--yes`** (or `confirm_spend: true` in MCP).
- Add `--judge <provider:model>` for open-ended answers (summaries, chat) where regexes can't decide. Use a strong model that is neither the baseline nor the candidate, and `--repeats 2` or more so the judge is calibrated against the baseline's agreement with itself.
- If the old model is already gone, candidates are judged on their own against each sample's `expect` rules.

## 4. Explain the result honestly

- Verdicts: **likely safe**, **review**, **not safe yet**, each with a confidence level. Never describe a result as guaranteed.
- A check counts as worse only when its 95% CI lies entirely on the worse side and exceeds the baseline's own run-to-run noise. A large difference on few samples may still not count: say so and suggest more samples.
- Point the user to the regressed examples in the HTML report, and to any "redirected" warning (the comparison may be against a different model than named).
- When switching, change model ids explicitly rather than relying on host aliases or redirects, and update docs that name the model.
