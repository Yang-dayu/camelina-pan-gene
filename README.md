# Camelina sativa Pan-Gene Database

Gene correspondence, homeologs and functional annotation across **18 annotations of 14 Camelina sativa accessions**.

[Website](https://yang-dayu.github.io/camelina-pan-gene/) — check its footer for the deployed data revision.

## Features

- Search gene, transcript or protein IDs from any included annotation.
- Explore candidate counterparts and predicted SG1/SG2/SG3 homeologs, including position-review flags.
- Inspect ranked protein hits, coverage, synteny blocks, OrthoFinder relations and pan-gene memberships.
- Read each transcript's functional results from TAIR10, Swiss-Prot, RefSeq, eggNOG-mapper, KofamScan and InterProScan.
- Select available protein/CDS sequences and transcripts; align proteins in the browser with Kalign and view the projected CDS alignment.
- Download query TSVs, sequences, annotation tables and enrichment inputs.

The interface opens in English by default. Use the language menu for Chinese (`?lang=zh`).

## Data release

All query, sequence, functional-annotation and download URLs are pinned to commit
`8d8fd8e2408a20d16eff79412adc298bdc846e30`, tagged **18_genomes_V2_function**:

[Browse this Hugging Face release](https://huggingface.co/datasets/Dayu99/Camelina-sativa-pan-gene-DB/tree/8d8fd8e2408a20d16eff79412adc298bdc846e30)

The browser fetches static shards on demand; no SQLite download or database server is needed for interactive queries.

## Local preview

From this repository's directory, run:

```bash
python -m http.server 8765
```

Open <http://localhost:8765/>. Internet access is needed for the Hugging Face data.

## GitHub Pages

Publish `index.html`, `config.js`, `assets/`, `data/` and `.nojekyll` at the repository root. In **Settings > Pages**, select **Deploy from a branch > main > /(root)**. No build step is required. Keep all data roots on the same verified commit when updating a release.

## Interpretation and attribution

Correspondence and homeolog calls are computational candidates, not guaranteed unique relationships. A missing hit does not establish biological absence. Read the evidence and review flags before selecting experimental targets.

Annotation and database providers retain their own terms; sources and methods are listed in the website.
For the bundled Kalign engine, see [source and build information](assets/vendor/kalign-3.3.1/SOURCE.md), [GPL license](assets/vendor/kalign-3.3.1/COPYING) and [Biowasm license](assets/vendor/kalign-3.3.1/LICENSE.biowasm).
