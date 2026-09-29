# memory.md

## 2026-09-27 — Laya MCP v0.1 scaffolded (Bun)
- Installed Bun 1.4.2 (was missing, Node 22.19 present).
- Created `laya-mcp-server/`: package.json, src/engine.ts, src/server.ts, src/cli.ts, tests/server.test.ts.
- Verified: `bun install` 107 pkgs, `bun test` 10 pass, `--doctor` 16ms degraded, stdio tools/list + tools/call → database_down 0.93.
- Files changed: engine REPO_ID convai→receptron/laya-onnx, 2-file .onnx+.data, heuristic infra boost, bootstrap fetch flag.
- Agent Rules §7.10 honored: deterministic heuristic fallback, no network block.

## 2026-09-27 — Real-weight attempt, reverted to degraded v0.1
- Found truth: convai repo is torch-only; real bundle = receptron/laya-onnx (laya.onnx 3.8MB + .data 1.685GB + laya_config.json + tokenizer/). Inputs are 5 tensors, not 2 — hand-rolled ORT wiring deleted.
- Switched engine to `@receptron/laya@0.1.2` (Laya.load + systemOne batched pass, temps from laya_config). Sandwich aligned to head 192 / 512.
- `--fetch` download stalled at 953/1607MB, C: dropped to 896MB free → aborted, deleted .part, reclaimed to 1.8GB free. Do NOT fetch on this disk.
- Verified after revert: `bun test` 10 pass, stdio gate_boolean → FLAGGED injection (0.85) degraded:true. All green.

## 2026-09-28 — REAL MODEL LIVE (degraded:false)
- Wrote scripts/fetch-weights.ts (Range-resume, 10 retries); library downloader drops at ~65MB, script pulled full 1607MB.
- doctor --fetch: ONNX ready 4.7s, database_down 77.7% real vs 48% heuristic.
- Verified stdio: decide 0.9301, gate 0.9695 FLAGGED, score 2.66 (fixed generic level labels to meaningful rubric).
- Lowered min_confidence 0.65 to 0.4 (real confidence is entropy-based). bun test 10 pass.

## 2026-09-28 — Optimized (cache + timing + decide_all + bench)
- No upstream INT8 bundle (multilingual/int8/quant/laya_int8 all 404) — self-quant deferred.
- Added infer_ms to all tools, LRU cache (sha256, max 1000, only maxProb>=0.6), LAYA_THREADS opt, decide_all combined tool (3Q/1 pass), scripts/bench.ts.
- Measured: load 6.3-7.6s, infer 95-125ms, cache hit 0ms, decide_all ~320ms. Threads default beats 2 (191ms/651ms) and 4 (122ms/412ms) — leave unset.
- bun test 10 pass after each change.

## 2026-09-28 — Install size cut (287→133MB runtime)
- Breakdown: weights 1.69GB + node_modules 323MB = ~2GB. No upstream INT8 (4 paths 404).
- Attempted INT8 self-quant: failed, needs ~3.5GB temp (shape-infer copy), disk has 1.2GB. Cleaned artifacts.
- Landed scripts/prune-ort.ts (drops linux/darwin ORT bins, postinstall hook): 287→133MB saved 154MB, tests green, real infer still degraded:false 77.7%.
- TEMP bloat (2.4GB) is VS Code server copies — left alone.
