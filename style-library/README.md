# Hypit Style Library

This directory stores reusable editing styles outside the Hypit source checkout
and outside individual video projects.

Each style version is immutable. Project edits stay local unless the user
explicitly promotes a verified change into a new style version.

The runtime-facing index is `index.json`. Analysis and reference assets remain
inside each `style-id/version` directory.

Before analyzing a new reference video, compute its SHA-256 and search the
`styles[].sourceSha256` fingerprint in `index.json`. A matching version should reuse
its `analysis/style.json`, `ANALYSIS.md`, `TIMELINE.md` and evidence instead of
running the same transcription or reference breakdown again.

Studio reads the library through:

- `/__studio/style-library`
- `/__studio/style-library/detail`
- `/__studio/style-library/asset`
