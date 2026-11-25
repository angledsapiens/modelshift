### modelshift migration check

**`openai:gpt-4o-mini-2024-07-18` → `openai:gpt-6-luna`**: 🟡 REVIEW BEFORE SWITCHING (confidence: medium; 20 samples × 3 repeats)

- semantic: 0.98 → 0.92 (95% CI of change -0.100 to -0.034). Review examples.
- behaviour drift: outputs are less similar to the baseline (0.71) than the baseline is to itself (0.93). Review examples.

> [!WARNING]
> **Problems during testing**
> - ⚠️ **2 settings had to change for the candidate model: your code will need these changes too.** openai:gpt-6-luna rejected these settings, so modelshift changed the request and tested it anyway. The results show the candidate with these changes applied.
>   - Rejects temperature 0, so the model's default temperature was used. Remove or change temperature in your code; answers may vary more from run to run. (60 of 60 calls)
>   - Rejects function tools on Chat Completions at its default reasoning effort, so reasoning_effort "none" was sent for requests with tools. Your code needs that setting, or a move to the Responses API (where the model may answer differently: test that separately). (9 of 60 calls)

| Check | Baseline | Candidate | Change (95% CI) | Noise | |
|---|---:|---:|---|---:|---|
| errors | 0.0% | 0.0% | +0.0% [0.0%, 0.0%] | ±0.0% | ✅ |
| json-valid | 100.0% | 100.0% | +0.0% [0.0%, 0.0%] | ±0.0% | ✅ |
| json-shape | 100.0% | 100.0% | +0.0% [0.0%, 0.0%] | ±0.0% | ✅ |
| tool-calls | 100.0% | 100.0% | +0.0% [0.0%, 0.0%] | ±0.0% | ✅ |
| refusals | 0.0% | 0.0% | +0.0% [0.0%, 0.0%] | ±0.0% | ✅ |
| assertions | 100.0% | 100.0% | +0.0% [0.0%, 0.0%] | ±0.0% | ✅ |
| semantic | 98.3% | 91.7% | -6.6% [-10.0%, -3.4%] | ±0.0% | ⚠️ |
| latency (median) | 1159ms | 1299ms | | | |

<sub>A check fails only when the 95% CI of the change is entirely on the worse side and larger than the baseline's own run-to-run variation. Never a guarantee.</sub>
