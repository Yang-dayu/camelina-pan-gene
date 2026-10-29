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
and columns do not yet have reference sequence exports, but can accept locally supplied FASTA records.

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

## Add your own sequences

In **Alignment**, choose **Protein** or **CDS (coding DNA)** under **Add your own sequences**,
then paste FASTA and click **Add pasted sequences**, or choose an uncompressed FASTA file.
Imported records appear as **User** rows alongside any available reference genes. Include or
exclude individual rows, remove imports, then click **Run alignment**. To align only your own
records without looking up a gene, use **Align your own protein or CDS sequences** above the results.
This aligns the selected records; it does not search the 15 genomes for a new sequence.

User sequences stay in browser memory and are not sent to GitHub, Hugging Face or an alignment
server. A new lookup or page reload clears them. Neither the input sequences nor their IDs are
added to the query URL or saved in browser storage. Importing does not start an alignment or fetch
reference sequences; a user-only alignment requires no reference sequence download.

CDS input must be unaligned, in reading frame 1, without introns, using standard nuclear genetic
code 1. It is translated for the protein alignment, then its original codons are projected onto
that alignment. CDS letter case and an optional terminal stop are retained in the original CDS
download. Internal definite stops and lengths not divisible by three are rejected. IUPAC ambiguous
bases are retained; an unresolved amino acid becomes X. If any selected user record was supplied
as protein only, the CDS view is disabled with an explanation; no bases are inferred from protein.

Each record needs a unique FASTA ID within the imported set. Reference IDs and User IDs remain
separate even if their text matches. The member and selection TSVs record source, input type,
description and import notes. For User rows, IDs are supplied FASTA labels, not assigned database
identifiers or correspondence evidence. Protein letters are normalized to uppercase, an optional
terminal `*` is removed, and spaces/tabs in sequence lines are removed; these changes are recorded
in the notes. Internal protein stops, U/O/J, gaps, digits and unsupported characters are rejected.

Limits: 2 MiB per import, 50 imported records, 20,000 amino acids per protein, and 2–50 selected
sequences totaling at most 250,000 amino acids per alignment. This Kalign build detects its input
alphabet automatically; it rejects a run if nucleotide scoring is detected, including some valid
low-complexity proteins, rather than returning a nucleotide alignment as a protein result.

Source transcript and protein IDs, including nonrepresentative isoforms, resolve to their parent genes.
Protein comparisons use one representative protein per gene.

Data: [Hugging Face dataset](https://huggingface.co/datasets/Dayu99/camelina-sativa-pan-gene-id).
The site reads public data files from the single dataset revision pinned in config.js.

## Files

- index.html: page structure.
- config.js: dataset addresses, example IDs and download links.
- assets/app.js: queries and result views.
- assets/alignment-selection.js: candidate gene checkboxes, selection export and explicit run controls.
- assets/user-sequences.js: local FASTA parsing, input validation and import notes.
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
