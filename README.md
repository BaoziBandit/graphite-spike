# Graphite WP0 performance spike (throwaway)

Plain JS + 2D canvas, no build step: `index.html` + `main.js` are both the source and the deployed output.
Live: https://baozibandit.github.io/graphite-spike/  (add `?n=1000|5000|10000` to pick a fixture, `?bench` to auto-run the benchmark)

- Synthetic fixtures: 1k / 5k / 10k nodes, ~1.5 edges per node, 6 node types, float64 coords offset to ~1e9, no overlaps (one node per layout cell).
- Uniform-grid spatial index for viewport culling; edges drawn when incident to a visible node.
- Semantic zoom: shapes (zoom < 0.12) → type icons (< 0.5) → titled cards.
- Pan clamp to node bbox + margin; zoom floor = fit all with margin; DPR-aware canvas.
- Auto benchmark: 15 s scripted pan/zoom sweep per count; pass = p99 frame interval ≤ 16.7 ms (+1 ms vsync jitter).

Not to be merged into the real app (see WP0 in the Graphite work packages).
