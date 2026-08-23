# @actually/market-cache-builder

Precomputes the Polymarket market cache (Gamma fetch → noise/binary filter →
local MiniLM embedding) and pushes it to the worker's `/market-cache` KV so
the MCP server never has to embed 800 market questions itself - only the
one incoming news text per `check_news` call.

## Running once

```bash
WORKER_URL=https://actually-api.example.workers.dev \
WORKER_SHARED_SECRET=<the public-by-design shared secret> \
MARKET_CACHE_WRITE_SECRET=<the private write secret - never share this> \
npm run build-cache -w @actually/market-cache-builder
```

First run downloads the ~33MB `Xenova/all-MiniLM-L12-v2` ONNX model to the
local transformers.js cache; subsequent runs reuse it.

## Inspecting output without touching the live cache

Add `--dry-run` to write the built blob to `./market-cache-blob.json` instead
of PUTing it to the worker - useful for checking the noise/binary filtering
and embedding output before it goes live. `MARKET_CACHE_WRITE_SECRET` is not
required in this mode.

```bash
WORKER_URL=https://actually-api.example.workers.dev \
WORKER_SHARED_SECRET=<the public-by-design shared secret> \
npm run build-cache -w @actually/market-cache-builder -- --dry-run
```

## Running on a cron cadence

Run this on infrastructure you control - **not** inside the Cloudflare
Worker (Workers cannot run ONNX). A cadence of ~30 minutes matches the
extension's own `CACHE_TTL_MINUTES`. Example crontab entry (adjust the path
and env file to match your server):

```cron
*/30 * * * * cd /path/to/actually-monorepo && \
  env $(cat /path/to/market-cache-builder.env | xargs) \
  npm run build-cache -w @actually/market-cache-builder >> /var/log/market-cache-builder.log 2>&1
```

Keep `MARKET_CACHE_WRITE_SECRET` out of version control - store it in the
env file referenced above with permissions restricted to the user running
the cron job.

### No dedicated server? Use the bundled GitHub Actions workflow

This repo has no always-on server of its own, so
`.github/workflows/market-cache-cron.yml` runs this script on a schedule
instead - every 2 hours (not 30 min: GitHub Actions minutes are metered on a
private repo, and 30-minute cadence would burn through the free tier on this
job alone). It needs three **repository secrets** (Settings → Secrets and
variables → Actions → New repository secret - or `gh secret set NAME`):

| Secret | Value |
|---|---|
| `ACTUALLY_WORKER_URL` | Same worker URL as everything else. |
| `ACTUALLY_WORKER_SHARED_SECRET` | The same `WORKER_SHARED_SECRET` configured on the worker. |
| `ACTUALLY_MARKET_CACHE_WRITE_SECRET` | The same `MARKET_CACHE_WRITE_SECRET` configured on the worker - **not** the shared secret above, a distinct private one. |

Trigger a run manually from the Actions tab (`workflow_dispatch`) to
smoke-test before waiting for the schedule.

## Reading the log when something fails

The script tracks which stage it's in (`read_env`, `fetch_markets`,
`load_model`, `build_blob`, `write_dry_run_file`, `put_worker`) and wraps the
whole run in a single try/catch. On failure the log line looks like:

```
[market-cache-builder] failed at step "fetch_markets": Error: ...
```

so a glance at an unattended cron log tells you which stage broke (bad
`WORKER_URL`, expired secret, Gamma API down, model download failure, etc.)
without needing to parse a bare stack trace.
