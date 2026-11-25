# Example: GPT-4o mini → GPT-6 Luna

OpenAI shuts down the `gpt-4o-mini-2024-07-18` API snapshot on 14 January 2027 and names `gpt-6-luna` as its replacement. This example tests that switch on 20 requests shaped like a typical app's traffic.

| File | What it is |
|---|---|
| [`samples.jsonl`](samples.jsonl) | The 20 requests, each with rules for a correct answer |
| [`report.html`](report.html) | The HTML report (download it and open it in a browser) |
| [`summary.txt`](summary.txt) / [`summary.md`](summary.md) | The terminal summary and the pull-request summary |
| [`results.json`](results.json) | Every answer from both models, for `modelshift report` |

The requests cover customer support (inside and outside the refund policy), JSON extraction (invoice, contact, dates), classification with fixed labels, tool calls (the right tool, not the wrong one, and none when none is needed), strict formats (exactly three bullets, a markdown table, SQL and Python in code blocks, a word limit), translation, a formal rewrite, date arithmetic and one borderline request (locked out of your own house).

## Result

**Review before switching** (medium confidence), run on 25 November 2026 with 3 repeats per request.

- **Three code changes are required.** GPT-6 Luna rejects `temperature: 0` (only its default of 1 is allowed) and `max_tokens` (use `max_completion_tokens`), and on Chat Completions it only accepts function tools with `reasoning_effort: "none"`. modelshift applied each change so the model could be tested, and listed them at the top of the report.
- **Answers stay correct.** Every rule passed on both models, and neither refused anything.
- **Wording changes noticeably.** The answers are less similar to GPT-4o mini's (0.71) than GPT-4o mini's are to each other (0.93), and the meaning check fell from 98% to 92%. GPT-6 Luna is more direct and terser ("We're open Monday to Friday, 9am to 5pm." instead of a friendly paragraph). It also adds formatting GPT-4o mini didn't: in plain-prose replies such as support answers, it used markdown bold (`**NW-48213**`) in 7 of 39 answers and em dashes in 5, against none for GPT-4o mini. Shown in a plain-text chat widget, SMS or email, the asterisks appear literally. If your product's tone or display matters, read the examples in the report before switching.
- **Slightly slower, more tokens.** Median latency rose from 1.16 s to 1.30 s. GPT-6 Luna wrote about 25% less visible text but billed about twice the output tokens (6,660 against 3,270 in total), because the count includes hidden reasoning.

## Not in this run: empty answers at small token limits

These samples set no token limit. In a separate check, GPT-6 Luna returned an **empty answer with no error** for a one-word classification when `max_completion_tokens` was 5, 10 or 20: hidden reasoning used the whole budget first (`finish_reason: "length"`). It answered at 50 and above, or at any limit with `reasoning_effort: "none"`. GPT-4o mini answered correctly with 5. If your samples carry a small `max_tokens`, modelshift reports these as "empty: hidden reasoning used the whole token limit".

The whole run (120 chat calls plus embeddings) cost a few cents.

## Run it yourself

```bash
export OPENAI_API_KEY=sk-...
npx modelshift run \
  --from openai:gpt-4o-mini-2024-07-18 --to openai:gpt-6-luna \
  --samples examples/gpt-4o-migration/samples.jsonl --repeats 3 \
  --embed openai:text-embedding-3-small --yes --html report.html
```

Your numbers will differ a little: GPT-6 Luna runs at temperature 1, so its answers vary between runs. To test your own app, replace the samples with requests from your logs (`npx modelshift capture logs.jsonl`).
