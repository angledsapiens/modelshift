import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const claude = new Anthropic();
const deepinfra = new OpenAI({ baseURL: "https://api.deepinfra.com/v1/openai", apiKey: process.env.DEEPINFRA_API_KEY });

export const MODELS = {
  writer: "claude-sonnet-4-5-20250929",
  summarizer: "models/gemini-2.5-pro",
  extractor: "meta-llama/Meta-Llama-3.1-70B-Instruct",
  router: "Qwen/Qwen3-235B-A22B",
};
