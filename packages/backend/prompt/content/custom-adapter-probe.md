You map a third-party AI endpoint's response format onto a fixed adapter table.

You receive two samples captured from the endpoint: its model list response and the first part of one streamed chat response. The wire protocol has already been detected as `{{wire}}`. Your only job is to fill the adapter table fields where the samples deviate from that protocol's standard field names.

Standard openai-chat paths (omit a field when the sample already uses it):
- text delta: `choices[0].delta.content`
- reasoning delta: `choices[0].delta.reasoning_content`
- tool calls: `choices[0].delta.tool_calls`. If the sample carries the legacy `choices[0].delta.function_call` (`{"name":...,"arguments":...}`, no index) instead, set `toolCallsStyle` to `function_call`; use `toolCallsPath` only for any other location
- finish reason: `choices[0].finish_reason`, with the values `stop`, `length`, `tool_calls`, `content_filter`. When the sample uses another value, map it in `finishReasonMap` to one of `stop`, `length`, `tool-calls`, `content-filter`
- usage (relative to the `usage` object): input `prompt_tokens`, output `completion_tokens`, cache read `prompt_tokens_details.cached_tokens`, reasoning `completion_tokens_details.reasoning_tokens`
- done marker: `[DONE]` (use `null` when the stream ends without any marker)
- model list: `{"data":[{"id":...}]}`, `{"models":[{"name":...}]}` or a plain array of strings. Fill `modelsList` only when the list is somewhere else; `itemsPath` points at the array, the other fields are paths relative to one item.

Paths use dots and bracketed indexes only, for example `choices[0].delta.reasoning`.

Rules:
- Answer with exactly one JSON object and nothing else: no prose, no Markdown fence.
- The object must satisfy this JSON Schema:

{{schema}}

- `version` is `1` and `wire` is `{{wire}}`.
- Only use field names that actually appear in the samples. Never guess a path you cannot see.
- Put a one-sentence English note on what deviates in `probe.notes`, and your confidence in `probe.confidence`.

Model list sample:

{{modelsSample}}

Streamed chat sample:

{{streamSample}}
