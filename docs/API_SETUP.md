# AI Provider Setup (OpenAI-compatible endpoints, incl. GonkaRouter)

The renderer never talks to an AI endpoint directly. All requests are made by
backend services in the main process; API keys live in the protected secret
store (`secrets.json`, mode 0600, OS-keychain encrypted where available) and
are never written to the database, logs, diagnostics, or the renderer.

## OpenAI-compatible provider

Settings → AI providers → **OpenAI-compatible endpoint**:

```text
Provider:  OpenAI-compatible

Base URL:  https://api.openai.com/v1          (or your gateway's /v1 URL)
Model:     gpt-4o-mini                        (any ID your endpoint lists)
API key:   paste your key, then press Save
```

Works with OpenAI, OpenRouter, Groq, Together, LM Studio, Ollama
(`http://localhost:1234/v1`), and any OpenAI-compatible gateway.

### How the Base URL is resolved

The app appends `/chat/completions` to your base URL automatically:

| You enter | Request goes to |
| --- | --- |
| `https://api.openai.com/v1` | `https://api.openai.com/v1/chat/completions` |
| `https://api.gonkarouter.io/v1/` (trailing slash) | `…/v1/chat/completions` |
| `https://host/v1/chat/completions` (full endpoint) | used as-is — never doubled |
| `http://localhost:1234` (root-mounted server) | `http://localhost:1234/chat/completions` |

Rules enforced: the URL must be a complete `http(s)://` address (the settings
form and the backend both reject e.g. `api.gonkarouter.io/v1` without a
protocol); trailing slashes are normalized; a base that already ends with
`/chat/completions` is never double-appended.

### Model IDs

The model string is passed to the endpoint **verbatim** — IDs containing `/`,
`.`, `-`, digits and mixed case are fully supported, e.g.
`zai-org/GLM-5.3-Flash`, `meta-llama/Llama-3.3-70B-Instruct-Turbo`,
`gpt-4o-mini`. Verify the exact identifier against your provider's current
model list; the app never alters or hard-codes it.

### Saving and testing the key

1. Paste the key into **API key** and press **Save** — it is stored locally and
   shown only as a masked hint (`gk-…4f2a`). The **trash button** next to it
   removes the stored key.
2. Press **Test connection**. This makes a real, minimal request
   (`Reply with exactly: pong`) — success is reported only when the model
   actually answers, with latency and the endpoint/model used:
   `Connection successful — model responded correctly ("pong") in 1.8s.`
3. Every change (base URL, model, temperature, max tokens, JSON mode, header
   style) persists immediately and survives app restarts (verified).

### Interpreting test/connection errors

| Message | Meaning / fix |
| --- | --- |
| `No API key is set` | Save a key first. |
| `…not a valid URL — include http:// or https://` | Base URL is malformed. |
| `Authentication failed (HTTP 401/403)` | Wrong key, or the gateway expects the `x-api-key` header (see below). |
| `Not found (HTTP 404) — check the base URL path (usually ends with /v1) and the model name` | Wrong base path or model ID. |
| `Rate-limited (HTTP 429)` | Key works; provider is throttling. |
| `The endpoint returned HTTP 5xx` | Provider-side failure; retry later. |
| `Could not reach the endpoint — …` | Connectivity/DNS/timeout. |
| `The endpoint answered, but the reply contained no message content` | Model name wrong or model cannot chat. |
| `AI_PROVIDER_INVALID_RESPONSE` during analysis | Endpoint replied 200 with an error or empty content; details are in the expandable Technical details area. |

## GonkaRouter

GonkaRouter exposes an OpenAI-compatible Chat Completions endpoint. In the app:

```text
Base URL:  https://api.gonkarouter.io/v1
Model:     zai-org/GLM-5.3-Flash        (or any model your account offers —
                                         confirm the ID in your GonkaRouter
                                         account/docs before use)
API key:   <your own key — paste it in Settings, never in files or chat>
```

**Authentication.** GonkaRouter documents both `Authorization: Bearer` and
`x-api-key`. The provider defaults to `Bearer`, which GonkaRouter accepts. If
your gateway/account requires `x-api-key`, change **API key header** in the
provider form (Bearer / x-api-key / Send both) — this affects only the
OpenAI-compatible provider, not Anthropic.

**JSON mode.** Some gateways reject the optional `response_format` parameter.
The app automatically retries once without it on HTTP 400/422, so analysis
keeps working either way. If your gateway errors on it consistently, turn off
**Request JSON response format** in the provider form.

**Status of GonkaRouter in this QA:** the integration is *compatible by
construction and verified against a standards-faithful mock gateway*
(`scripts/mock-gonka.ts`) — full workflow: test → analysis → audit scores →
metadata, plus 37 automated provider tests including GonkaRouter-style
auth headers and base-URL handling. A **live request against
api.gonkarouter.io has NOT been made** because no GonkaRouter API key exists
in this environment. Enter your key in Settings → AI and press Test connection
to complete that verification (see `docs/QA_REPORT.md`).

## Offline fallback (no key required)

The **local heuristic analyzer** is always available and clearly labeled
"local heuristic (not an AI model)" everywhere it appears. Import, inspection,
captions, editing, rendering and export never require an AI provider or
internet access.

## Testing provider wiring without any real key (developers)

```text
npx tsx scripts/mock-gonka.ts 8901
```

Runs a local OpenAI-compatible gateway (`http://127.0.0.1:8901/v1`, key
`gk-test-key-123`, any model name) that answers connection tests, discovery,
scoring and metadata with schema-valid payloads — useful to verify the app's
provider plumbing end-to-end with zero external dependencies.
