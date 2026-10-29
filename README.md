# Camelina sativa Pan-gene Lookup

Look up a gene, transcript or protein ID across 15 Camelina annotations. Compare protein hits,
direct synteny, OrthoFinder relations, pan-gene memberships and predicted subgenome copies.
Query results can be downloaded as TSV.

## Protein and CDS alignment example

Look up `CsJoelle.01G002700` in Joelle and open **Alignment**, next to Hits, Related genes and
Homeologs. The available sample is **SG1 · Chr19**, with one current primary candidate per
annotation (15 by default). Include or exclude individual genes, then click **Run alignment**.
At least two genes are required. The candidate list shows IDs, genomic positions, representative
protein lengths and evidence. **Download selection (TSV)** records included and excluded rows.

Alignment has its own gene selection, separate from annotation filters in the other views.
Changing the selection clears the previous alignment; a new query starts a new selection.
The Homeologs table's **Choose sequences** shortcut opens the same selection view. Other queries
and columns do not yet have sequence exports.

Results appear below the candidate list. Switch between **Protein** and **CDS (bases)**; CDS loads only when
selected, using the exact same representative transcripts. Each CDS is translation-checked and
its codons follow the protein alignment; each protein gap becomes three base gaps. The CDS view
does not include introns, UTRs or promoters. Terminal stop codons remain in the original CDS
download and are omitted from the aligned view. Displayed bases use uppercase; downloads retain
the source letter case. Original CDS, aligned CDS and CDS member metadata can be downloaded.

Opening the candidate list does not fetch sequences or start computation. Unaligned proteins
are fetched from the pinned Hugging Face revision only when **Run alignment** is clicked.
Kalign 3.3.1 runs in a browser worker on the visitor's device; the alignment is not computed by
GitHub Pages or Hugging Face. The view supports residue colouring, difference highlighting,
conservation, and downloads of proteins, the aligned FASTA, and member IDs as TSV.
Alignment positions are columns in the multiple sequence alignment, not genomic coordinates.
Length differences and gaps do not by themselves establish biological insertions, deletions, or gene-model errors.

Source transcript and protein IDs, including nonrepresentative isoforms, resolve to their parent genes.
Protein comparisons use one representative protein per gene.

Data: [Hugging Face dataset](https://huggingface.co/datasets/Dayu99/camelina-sativa-pan-gene-id).
The site reads public data files from the single dataset revision pinned in config.js.

## Files

- index.html: page structure.
- config.js: dataset addresses, example IDs and download links.
- assets/app.js: queries and result views.
- assets/alignment-selection.js: candidate gene checkboxes, selection export and explicit run controls.
- assets/protein-alignment-view.js: on-demand sequence extraction and the alignment view.
- assets/codon-alignment.js: validates matched CDS and projects codons onto the protein alignment.
- assets/browser-alignment.js and assets/browser-alignment.worker.js: isolated browser alignment execution.
- assets/vendor/kalign-3.3.1/: pinned Kalign runtime, GPL license, corresponding source and build provenance.
- assets/style.css: presentation.
- .nojekyll: serve the static files directly on GitHub Pages.

## Publish with GitHub Pages

1. Put these files at the root of a GitHub repository and commit them to main.
2. In Settings → Pages, select Deploy from a branch, main and /(root), then save.
3. Open the published URL shown by GitHub and test a query. (For example: https://yang-dayu.github.io/camelina-pan-gene)

No build step is required. The data stay on Hugging Face.
Include the entire Kalign vendor directory when publishing; its source archive is available for
download and is not loaded during normal alignment use.
[GitHub Pages instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

The bundled Kalign engine is distributed under GPL-3.0-or-later. See its
[source and license information](assets/vendor/kalign-3.3.1/SOURCE.md).

## Reading the results

Sequence similarity, direct synteny, OrthoFinder relations and shared pan-gene membership are
separate evidence. Multiple candidates can be retained; a selected candidate is a computational
prediction. No reported hit does not prove biological absence. DH55V2 and DH55V3 are two annotations
of the same accession.
