from openai import OpenAI

client = OpenAI()
# o3 is mentioned in a comment and must not be detected
resp = client.chat.completions.create(model="gpt-4o-2024-08-06", messages=[])
fallback = client.chat.completions.create(model="gpt-4o", messages=[])
tuned = "ft:gpt-4o-mini-2024-07-18:acme::abc123"
fresh = "gpt-6-luna"
