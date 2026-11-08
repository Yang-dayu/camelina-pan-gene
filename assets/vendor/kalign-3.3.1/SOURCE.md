# Kalign 3.3.1 browser engine

Kalign is copyright Timo Lassmann and is licensed under GNU GPL version 3 or later;
see [COPYING](COPYING). Biowasm's build recipes are licensed under MIT;
see [LICENSE.biowasm](LICENSE.biowasm). These third-party licenses do not
assign a license to the rest of this website or to its source annotations.

`kalign.js` and `kalign.wasm` are unmodified downloads from the versioned
[Biowasm distribution](https://biowasm.com/cdn/v3/kalign/3.3.1/kalign.js).
Their SHA-256 checksums and source URLs are recorded in `provenance.json`.
The WebAssembly binary is loaded only when an alignment is requested.

## Corresponding source and build instructions

The complete upstream source is available next to this engine as
[source/kalign-3.3.1.tar.gz](source/kalign-3.3.1.tar.gz), and directly at
[upstream commit 1d0bfe30d42c1d970f003c09cbf2b43ce9d3871e](https://github.com/TimoLassmann/kalign/tree/1d0bfe30d42c1d970f003c09cbf2b43ce9d3871e).
No upstream submodules are required for this release.

The Biowasm recipe and its patch are also provided under `source/`:
`v3.3.1.patch`, `compile-kalign.sh`, `compile-tool.sh`, `shared.sh`, and
`Dockerfile-dev`. They are taken from
[Biowasm commit 6b952d26eac6af4ad67045988dc6e7be1b467ffc](https://github.com/biowasm/biowasm/tree/6b952d26eac6af4ad67045988dc6e7be1b467ffc).
The Dockerfile identifies the Emscripten toolchain as `emscripten/emsdk:2.0.25`.
Apply `v3.3.1.patch` to the unpacked source, source `shared.sh` to set
`EM_FLAGS`, then run the commands in `compile-kalign.sh` from the patched
source directory. The two generated engine files are the distributable runtime.
The upstream scripts remain unmodified and refer to Biowasm's normal directory
layout; `compile-tool.sh` documents that layout. This project downloaded the
published binaries; it does not claim to have rebuilt them bit for bit.

Kalign citation: Timo Lassmann (2019), *Kalign 3: multiple sequence alignment of
large data sets*, Bioinformatics. <https://doi.org/10.1093/bioinformatics/btz795>
