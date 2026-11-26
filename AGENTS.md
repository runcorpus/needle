<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Benchmark runs

- GitHub Actions is the publishing path. `.github/workflows/refresh.yml` checks NEEDLE's published run index hourly and schedules the latest due batch for each enabled suite in `data/config.json`. Each mode records the remote MCP server version and Library index snapshot, then publishes its artifacts and updates the ledger and seven-day report.
- Scheduled refreshes run both Corpus modes across Scholar, News, Finance, AgenticRare, and Legal. Each mode runs in its own job and reuses the other mode's recorded snapshots for a shared batch. Local commands default to Corpus (NEEDLE). Use `--harness both` to run the two variants on the same batch.
- Every suite saves each completed question locally and, in GitHub Actions, to the Actions cache. A retry restores completed questions with matching inputs, model settings, runtime, and snapshots, and retries missing or failed questions. The full batch is scored and published after all questions finish.
- Retrieval uses the hosted Corpus MCP endpoint, forwarding the active Eve trace context. MCP requests have no fixed spacing; HTTP 429 responses start a process-coordinated cooldown on each runner using Retry-After or exponential backoff. All MCP POSTs, including initialization and retries, wait for any active cooldown. The server limit remains 60 requests per minute per IP. Virtual corpus attachments and evidence are isolated per question and shared with Eve's delegated agents. Retain Surf's default delegation and JustBash sandbox tools; disable external web search.
- `corpus_search` accepts `corpus`, `q`, `k` (1–10), and optional `meta`, returning `{ hits: [{ url, title, description, meta? }] }` without numeric scores. For NEEDLE document searches, `q` is optional and ignored; catalog searches require it. The final ranking remains capped to the batch's published retrieval depth.
- Give both variants the original question and published retrieval depth from each archived NEEDLE batch. Eve can discover corpora and rerank the URLs it retrieves. Corpus (NEEDLE) sends the original query to the corpus, and Corpus (Agent) can rewrite it. Both return ranked URLs and use the pinned upstream evaluators in `scripts/score-corpus.py`. Reuse the published provider scores and Ultimate from the matching batch.
- For judged suites, use the judge model recorded in the batch. Configure `AI_GATEWAY_API_KEY` in GitHub Actions secrets, or in the ignored `.env.local` for local checks. Use the public JSON serializer in `src/lib/public-run-json.ts` for run artifacts so signed URLs in evidence are stripped before publication.

## Verification

- `bun run bench:refresh --dry-run --upgrade-pending` checks which batches the scheduled job would run.
- `bun run bench:run --sample 1 --harness both` runs one real question per enabled suite through both variants and writes local artifacts under `.evals/local-runs/`. Seven-day reporting uses measured full batches.
- Run `bun test src/`, `bun run typecheck`, and `bun run build` for code changes. Use `bun run build --webpack` when the local sandbox blocks Turbopack’s worker port.

## Git commits

- At the end of each turn that changes this repository, verify and commit the completed changes from that turn. Stage only those changes, including when a file contains other edits. Push when the user asks for it.
