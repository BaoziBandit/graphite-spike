# Graphite WP0 performance spike (throwaway)

Plain JS + 2D canvas, no build step. `docs/` is both the source and what GitHub Pages serves.
Live: https://baozibandit.github.io/graphite-spike/

URL params: `?n=1000|5000|10000` fixture · `?bench` auto-run · `?secs=N` seconds per count (default 15) · `?renderer=v1` old renderer for A/B.

## Renderers
- **v2 (default):** vector geometry built once per fixture into `Path2D`s per spatial tile (4096 world units) and node type, in tile-local coordinates (float64 world, small local offsets). Each frame: cull tiles, then one `fill`/`stroke` per type per visible tile under the canvas transform, so the browser re-rasterizes vectors at full resolution every frame. No bitmap caching anywhere.
  LOD (same thresholds on every device): zoom < 0.02 grid-cell clusters (nodes would be under ~2-3 px) · < 0.12 shapes · ≥ 0.2 vector type icons · ≥ 0.5 titled cards (screen-space text, on-screen nodes only). Edges skipped only when they'd be under 2 px.
- **v1:** per-frame grid-index query and per-node path building (original spike).

## Benchmark
15 s scripted pan/zoom sweep per count; first 1 s discarded. Refresh rate is detected at startup from idle frames. PASS columns: p99 frame time ≤ 16.7 ms (60 fps floor) and ≤ native refresh interval, each + 1 ms jitter allowance.

## Test shells (Tauri v2)
`src-tauri/` wraps `docs/` with no plugins, no commands, no capabilities, and a strict CSP. Built by `.github/workflows/tauri-spike.yml` on tag push (`v*`): Windows NSIS installer (unsigned) and debug-signed arm64 Android APK, attached to the GitHub Release.

Not to be merged into the real app (see WP0 in the Graphite work packages).
