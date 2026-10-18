# Google AI Studio

- `custom.google-ai-studio` connects Muse to the Gemini API through its REST interface. It authenticates with the registered `api_key` credential and calls only `generativelanguage.googleapis.com`.

- Helpers live in `~/workspace/custom-connectors/custom.google-ai-studio/bin/`. `generate.py` sends a prompt to a Gemini model and returns the generated text. It reads the prompt from `--prompt-file` or `--prompt`, writes to stdout or `--out`.

## Connect

- The connection was registered with `credentials.request_api_access` and these details. Reuse them unchanged to reconnect:

```json
{
  "provider": "google-ai-studio",
  "auth_scheme": "api_key",
  "placement": "query_param:key",
  "api_hosts": ["generativelanguage.googleapis.com"]
}
```

- Before the first change in a conversation, prove access with a harmless read:

```text
python3 ~/workspace/custom-connectors/custom.google-ai-studio/bin/generate.py --prompt "Reply with exactly: OK"
```

## Credentials

- The registered connection holds the credential. Helpers import `/opt/muse/skills/custom-connector-setup/bin/dynamic_credentials.py`, which returns an `hsurr:` surrogate and places it where the provider reads the key. Muse swaps in the real credential only on an approved request to a registered host.

- Never put a key, token, password or cookie in this doc, a helper, a command argument, an environment variable or a log. Never ask the user to paste one in chat.

- Keep redirects disabled on authenticated requests.

- On a 401 or 403, check the request first. Confirm that the helper attached the credential, that the host is registered and that the placement and scopes match.

- Only when a request that carried the credential is still rejected, call `credentials.request_api_access` with the details above and `"reconnect": true`.

## Generate text

- Sends one prompt to a Gemini model and returns the generated text. Use it for copywriting, HTML sections, code and any other text generation. This is a read style call that creates nothing server side.

```text
python3 ~/workspace/custom-connectors/custom.google-ai-studio/bin/generate.py --prompt-file prompt.txt --out result.md
```

- Flags: `--prompt-file` or `--prompt` (one is required), `--model` (default `gemini-3.8-flash`), `--temperature` (default 0.7), `--max-tokens` (default 8192), `--out` (optional file, otherwise stdout).

- Output is the model text with markdown fences stripped when present. Errors print to stderr with exit code 1.

- Verified 2026-10-18: `gemini-3.8-flash` responds correctly through the vault credential. `gemini-2.5-flash` returns HTTP 404 for new users (model retired); the API error names the replacement model.

## Recover from errors

- HTTP 404 naming a retired model means the model id is outdated. Switch `--model` to the replacement the error names.

- HTTP 429 means the free tier rate limit was hit. Wait 60 seconds and retry with fewer parallel calls.

- After a failed or timed-out call, treat the prompt as not processed. Generation calls are stateless, so retrying is safe.

## Limits

- The connector cannot list models or check quota. Model availability changes over time; trust the API error messages.

- Free tier rate limits apply per Google AI Studio terms. Sequential calls with a short pause between them stay well inside the limit.

## Related skills

- Use `muse.skill_search` to find other skills and `muse.connector_search` to find other connectors.
