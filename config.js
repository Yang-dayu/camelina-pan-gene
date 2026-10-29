// Where the data files live. The page reads manifest.json, ids/, genes/ and pangenes/ under dataBase
// (step 06) and manifest.json plus genes/ under homeologBase (step 07).
//   Local test:   "sample_data/" and "sample_data/homeologs/"  (small copies, served by serve.ps1)
//   Published:    the Hugging Face dataset, pinned to one commit so the page and the data stay in step, e.g.
//                 "https://huggingface.co/datasets/Dayu99/camelina-sativa-pan-gene-id/resolve/<commit>/web/"
//                 "https://huggingface.co/datasets/Dayu99/camelina-sativa-pan-gene-id/resolve/<commit>/homeologs/"
// Complete RNA/protein ID lookup, verified against the original annotations.
// All data and download addresses use the same verified dataset revision.
// For a local test with the small sample copies use "sample_data/", "sample_data/homeologs/" and downloadBase null.
window.PANGENE_CONFIG = {
  dataBase: "https://huggingface.co/datasets/Dayu99/camelina-sativa-pan-gene-id/resolve/526e575e8ed9f078b99f0d49e0360de249a43e23/web/",
  homeologBase: "https://huggingface.co/datasets/Dayu99/camelina-sativa-pan-gene-id/resolve/526e575e8ed9f078b99f0d49e0360de249a43e23/homeologs/",
  // Small unaligned sequence sets. Proteins load when the alignment opens;
  // the optional matching CDS loads only when its view is selected.
  // Paths are relative to downloadBase, so sequences use the same immutable data revision.
  proteinAlignmentExamples: [
    {
      queryGenome: "Joelle", queryId: "CsJoelle.01G002700", subgenome: "SG1", group: "G1",
      path: "sequences/examples/joelle_01g002700_sg1_chr19.json",
      sha256: "238195e2b61b16089ab3110c74d1e01623f63c2c92af72f9e1bb3203b38fd002",
      cds: {
        path: "sequences/examples/joelle_01g002700_sg1_chr19_cds.json",
        sha256: "2f045ec1d0930b43ff76637c3b1f1e020e4119ae18361754e605ea610b8226b2",
      },
    },
  ],
  // One clickable example per annotation, in the same order as the manifest: [gene ID, genome].
  examples: [
    ["Csa01g000300.DH55", "DH55V3"],
    ["Csa01g001180", "DH55V2"],
    ["CS04g005982", "Suneson"],
    ["CsPrytzh.01G000100", "Prytzh"],
    ["CsAcsn226.01G002800", "Acsn226"],
    ["CsAmes1043.01G002700", "Ames1043"],
    ["CsBorowska.01G002600", "Borowska"],
    ["CsCAM116.01G002900", "CAM116"],
    ["CsCAM70.01G002600", "CAM70"],
    ["CsCN113611.01G002700", "CN113611"],
    ["CsGiessen4.01G002300", "Giessen4"],
    ["CsJoelle.01G002700", "Joelle"],
    ["CsLicalla.01G002800", "Licalla"],
    ["CsLindo.01G002600", "Lindo"],
    ["CsSvalof.01G002800", "Svalof"],
  ],
  // Whole-data downloads for R. downloadBase is the dataset root (same commit as above); null until published.
  // Folders link to browseBase (the Hub's file browser), single files to downloadBase (direct download).
  downloadBase: "https://huggingface.co/datasets/Dayu99/camelina-sativa-pan-gene-id/resolve/526e575e8ed9f078b99f0d49e0360de249a43e23/",
  browseBase: "https://huggingface.co/datasets/Dayu99/camelina-sativa-pan-gene-id/tree/526e575e8ed9f078b99f0d49e0360de249a43e23/",
  downloads: [
    { path: "web/tables/genes.tsv.gz", label: "All genes with their IDs, positions and status (37 MB)" },
    { path: "web/tables/relations/", label: "Related genes per query genome: one row per syntenic or OrthoFinder pair with evidence and alignment metrics (15 files, 38–46 MB each)", folder: true },
    { path: "homeologs/tables/", label: "Predicted SG1/SG2/SG3 copies per query genome, three cells per row, plus group_calls.tsv.gz (15 + 1 files)", folder: true },
    { path: "tables/pangenes/", label: "GENESPACE pan-gene tables, one per reference frame (15 files, 42 MB each)", folder: true },
    { path: "query/query.sqlite", label: "The complete query database (13.6 GB SQLite): all stored candidate hits, relations and pan-gene tables, for batch work in R or Python" },
    { path: "query/README.md", label: "How to use the database: tables, the compressed hit records, R and Python examples; query/05_query_data.py queries it from the command line" },
  ],
};
