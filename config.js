// Where the data files live. The page reads manifest.json, ids/, genes/ and pangenes/ under dataBase
// (step 06) and manifest.json plus genes/ under homeologBase (step 07).
//   Local test:   "sample_data/" and "sample_data/homeologs/"  (small copies, served by serve.ps1)
//   Published:    the Hugging Face dataset, pinned to one commit so the page and the data stay in step, e.g.
//                 "https://huggingface.co/datasets/Dayu99/Camelina-sativa-pan-gene-DB/resolve/<commit>/web/"
//                 "https://huggingface.co/datasets/Dayu99/Camelina-sativa-pan-gene-DB/resolve/<commit>/homeologs/"
// Complete RNA/protein ID lookup, verified against the original annotations.
// All data and download addresses use the same verified dataset revision.
// For a local test with the small sample copies use "sample_data/", "sample_data/homeologs/" and downloadBase null.
// 来源表共用的文字和链接（见下面的 annotationSources）/ Shared texts and links of the annotation-source table
const BIRD_2024 = ["Bird et al. 2024, Genetics", "https://doi.org/10.1093/genetics/iyae183"];
const LU_PROPOSAL = "JGI proposal 507613, PI C. Lu (Montana State University)";
window.PANGENE_CONFIG = {
  // 已核对的 HF 版本 18_genomes_V2_function：18 套注释加 function/ 功能注释，全部文件按哈希核对通过。
  // 标签指向 8d8fd8e2；所有数据地址继续固定到下面同一个完整提交号。
  // Verified HF release 18_genomes_V2_function: 18 annotations plus function/, every file verified by hash.
  // The tag points to 8d8fd8e2; keep every data URL pinned to the same full commit hash below.
  dataBase: "https://huggingface.co/datasets/Dayu99/Camelina-sativa-pan-gene-DB/resolve/8d8fd8e2408a20d16eff79412adc298bdc846e30/web/",
  homeologBase: "https://huggingface.co/datasets/Dayu99/Camelina-sativa-pan-gene-DB/resolve/8d8fd8e2408a20d16eff79412adc298bdc846e30/homeologs/",
  // Load transcript metadata first, then the selected protein and matching CDS shards.
  sequenceBase: "https://huggingface.co/datasets/Dayu99/Camelina-sativa-pan-gene-DB/resolve/8d8fd8e2408a20d16eff79412adc298bdc846e30/sequences/",
  proteinAlignmentExamples: [],
  // The static HF preview does not use the separate local gene-description service.
  geneDescriptionApiBase: null,
  // 功能注释分片（六个工具的原始结果，按转录本），和上面同一个提交；设为 null 就不显示面板。
  // Functional-annotation shards (the six tools' raw results, per transcript), from the same commit as above;
  // null hides the panel.
  functionBase: "https://huggingface.co/datasets/Dayu99/Camelina-sativa-pan-gene-DB/resolve/8d8fd8e2408a20d16eff79412adc298bdc846e30/function/",
  // 这一版的 HF 标签和更早的版本，显示在"关于"和"数据"弹窗里；提交号要和上面的地址一致
  // The HF tag of this release and the earlier releases, shown in the About and Data panels; the commit is the one
  // in the addresses above.
  release: {
    tag: "18_genomes_V2_function",
    earlier: [
      { tag: "18_genomes_V2", commit: "b9eca6e47d70fbba81a7eade72e48f83c34c49c0",
        note: "The same 18 annotations, without the functional annotation" },
      { tag: "full_v1", commit: "526e575e8ed9f078b99f0d49e0360de249a43e23", note: "The first release, 15 annotations" },
    ],
  },
  // Display names and display order only. Data files, links and downloads keep the original IDs
  // ("Suneson" is the Montana State University annotation MSU_CS-sun 2025-07-01, by Samuel Decker).
  genomeLabels: { Suneson: "SunesonDecker2025" },
  genomeOrder: ["DH55V3", "DH55V2", "Suneson", "SunesonJGI", "SunesonFang2023", "SunesonBrock2024",
    "Prytzh", "Acsn226", "Ames1043", "Borowska", "CAM116", "CAM70", "CN113611", "Giessen4", "Joelle",
    "Licalla", "Lindo", "Svalof"],
  // Start-page figures not stored in the manifests, for this data revision only.
  stats: {
    accessions: 14,
    // Gene families = OrthoFinder orthogroups of run 18_genome_V2 (the 1,454,016 genes on Chr01-Chr20), counted per
    // accession on Tempest by validation/gene_family_stats_20261103/gene_family_stats.py (gene_family_stats.json).
    // byAccessions[i] = families present in exactly i + 1 of the 14 accessions; sums to `families`.
    geneFamilies: {
      families: 82506,
      genes: 1421222,
      unassignedGenes: 32794,
      coreGenes: 1082248,
      byAccessions: [13742, 16776, 2612, 1911, 1217, 991, 891, 831, 777, 823, 983, 1311, 2804, 36837],
      onlySuneson: 12287,
      onlyDH55: 1444,
      onlyDH55AndSuneson: 14849,
      // Families with no gene from the 13 JGI-pipeline annotations (SunesonJGI + the 12 JGI-only accessions);
      // all of them are among the DH55/Suneson-only families above.
      withoutJgiPipeline: 23935,
      // The 12 accessions annotated only by the JGI pipeline have 0-4 families found in no other accession.
      jgiOnlyAccessions: 12,
      jgiOnlySpecificMax: 4,
      // 一个家族里有几个同一套注释的基因：含 Prytzh 基因的家族中，含 1 / 2 / 3 / 4 个以上 Prytzh 基因的家族数。
      // 来自 18_genome_V2 的 OrthoFinder 结果 Orthogroups.GeneCount.tsv（Results_Oct30），2026-11-05 在登录节点上统计。
      // 说明三个亚基因组拷贝多数时候不在同一个家族里。
      // Genes of one annotation per family: of the families with a Prytzh gene, how many hold 1 / 2 / 3 / 4 or more
      // Prytzh genes. From the run's OrthoFinder Orthogroups.GeneCount.tsv (Results_Oct30), counted 2026-11-05 on the
      // login node. It shows that the three subgenome copies are usually not in one family.
      genesPerFamily: { genome: "Prytzh", families: 43790, counts: { "1": 29387, "2": 5192, "3": 8519, "4+": 692 } },
    },
  },
  // "Annotations and sources" table, opened from "18 annotations" and "14 accessions". Its numbers are read from
  // annotationStats, written on Tempest by validation/annotation_stats_20261103/annotation_stats.py web (16 checks
  // passed; BUSCO 6.1.0, brassicales_odb12.2). The source texts below are kept by hand; null = still to be supplied.
  annotationStats: "data/annotation_stats.json",
  // 同一批组装的连续性统计；contig 以连续至少 10 个 N 分割 / Contiguity of the same assemblies; split at runs of at least 10 N.
  // 染色体怎么拼的（scaffolding）是 assembly_stats.py 里手工维护的说明 / The chromosome-build notes (scaffolding) are
  // kept by hand in validation/assembly_stats_20261104/assembly_stats.py on Tempest.
  assemblyStats: "data/assembly_stats.json",
  // JGI facts checked 2026-11-04: the 12 pangenome accessions are the genomes of Bird et al. 2024 (same Phytozome
  // v1.1 files, same gene counts) and are now unrestricted on Phytozome. Ten were sequenced under JGI CSP 505836
  // (PI D. Kliebenstein); CAM70, CAM116 and SunesonJGI under JGI proposal 507613 (PI C. Lu, Montana State University),
  // so their data producers are this group. SunesonJGI is unpublished and still listed as restricted on Phytozome.
  annotationSources: {
    // DH55 V3 = the improved DH55 assembly "CsaDH55" of Chaudhary et al. 2026 (Parkin lab, the group behind the 2014
    // DH55 genome); its Helixer annotation has 102,393 protein-coding genes, the count in our DH55V3 table.
    DH55V3: { source: "Improved DH55 assembly (CsaDH55) with Helixer gene models, Parkin lab, AAFC Saskatoon",
      links: [["Chaudhary et al. 2026, Nat. Commun. 17:7992", "https://doi.org/10.1038/s41467-026-74800-8"],
        ["cruciferseq.ca", "https://cruciferseq.ca"], ["ENA PRJEB96055", "https://www.ebi.ac.uk/ena/browser/view/PRJEB96055"]] },
    DH55V2: { source: "Assembly of Kagale et al. 2014 (AAFC Saskatoon), corrected",
      links: [["Nat. Commun. 5:3706", "https://doi.org/10.1038/ncomms4706"]] },
    // The MSU annotation (138 k gene models on the chromosomes) was the reference of Decker et al. 2025; the
    // annotation files themselves are not deposited with that paper.
    Suneson: { source: "Montana State University, S. Decker",
      links: [["Decker et al. 2025, Biology 14:1199", "https://doi.org/10.3390/biology14091199"]],
      status: "used as the reference in that paper; the annotation files are not deposited there", sameAssemblyAs: "SunesonJGI" },
    SunesonJGI: { source: `JGI annotation v1.1 of the Suneson assembly; ${LU_PROPOSAL}`,
      status: "unpublished (JGI analysis completed 2025-10-03)", sameAssemblyAs: "Suneson" },
    SunesonFang2023: { source: "Fang et al. 2023, CC BY 4.0",
      links: [["figshare", "https://doi.org/10.6084/m9.figshare.23750790.v1"]] },
    SunesonBrock2024: { source: "Brock et al. 2024, Hortic. Res.; CoGe genome 69592",
      links: [["doi:10.1093/hr/uhae247", "https://doi.org/10.1093/hr/uhae247"]] },
    CAM70: { source: `Sequenced under ${LU_PROPOSAL}`, links: [BIRD_2024] },
    CAM116: { source: `Sequenced under ${LU_PROPOSAL}`, links: [BIRD_2024] },
    CN113611: { source: "JGI CSP 505836 (BAP), PI D. Kliebenstein", links: [BIRD_2024],
      note: "named CN113691 in Bird et al. 2024 and on the JGI genome portal" },
    // The other accessions of the Camelina pangenome (JGI annotation v1.1 on assembly v1.0)
    jgiPangenome: { source: "JGI CSP 505836 (BAP), PI D. Kliebenstein", links: [BIRD_2024] },
    // Each JGI annotation's own Phytozome page: https://phytozome-next.jgi.doe.gov/info/<name>
    phytozome: {
      Prytzh: "CsativaPrytzh_v1_1", Acsn226: "CsativaAcsn_226_v1_1", Ames1043: "CsativaAmes1043_v1_1",
      Borowska: "CsativaBorowska_v1_1", CAM116: "CsativaCAM116_v1_1", CAM70: "CsativaCAM70_v1_1",
      CN113611: "CsativaCN113611_v1_1", Giessen4: "CsativaGiessen4_v1_1", Joelle: "CsativaJoelle_v1_1",
      Licalla: "CsativaLicalla_v1_1", Lindo: "CsativaLindo_v1_1", Svalof: "CsativaSvalof_v1_1",
      SunesonJGI: "Csativavar_Suneson_v1_1",
    },
    // The acknowledgments the JGI data-use notices ask for / JGI 使用说明要求的致谢
    credits: "JGI data use: the ten CSP 505836 annotations carry the notice “These sequence data were produced under JGI "
      + "CSP 505836, Pangenomic comparison of structural variation driving recurrent network evolution in Brassicaceae "
      + "metabolism (BAP), and made available by the Department of Energy’s Joint Genome Institute”; CAM70, CAM116 and "
      + "SunesonJGI (proposal 507613) carry “These sequence data were made available by the Department of Energy’s "
      + "Joint Genome Institute”.",
  },
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
    ["CsSuneson.01G000100", "SunesonJGI"],
    ["Camsa.SUN.01G000020", "SunesonFang2023"],
    ["CsSunV4_1g00010", "SunesonBrock2024"],
  ],
  // Whole-data downloads for R. downloadBase is the dataset root (same commit as above); null until published.
  // Folders link to browseBase (the Hub's file browser), single files to downloadBase (direct download).
  downloadBase: "https://huggingface.co/datasets/Dayu99/Camelina-sativa-pan-gene-DB/resolve/8d8fd8e2408a20d16eff79412adc298bdc846e30/",
  browseBase: "https://huggingface.co/datasets/Dayu99/Camelina-sativa-pan-gene-DB/tree/8d8fd8e2408a20d16eff79412adc298bdc846e30/",
  downloads: [
    { path: "web/tables/genes.tsv.gz", label: "All genes with their IDs, positions and status" },
    { path: "web/tables/relations/", label: "Related genes per query annotation: pairwise evidence and alignment metrics", folder: true },
    { path: "homeologs/tables/", label: "Predicted SG1/SG2/SG3 copies, group assignments and position-conflict review candidates", folder: true },
    { path: "tables/pangenes/", label: "GENESPACE pan-gene tables, one per reference frame", folder: true },
    { path: "sequences/", label: "All-transcript catalog, protein/CDS shards and their sequence index", folder: true },
    // 功能注释：每套注释的基因表、转录本表和 GO/KEGG 富集文件，加上说明 / functional annotation: per-annotation
    // gene and transcript tables, GO/KEGG enrichment files, and the description
    { path: "function/tables/", label: "Functional annotation per annotation: gene and transcript tables (best Arabidopsis, Swiss-Prot and RefSeq hits, eggNOG, KO, GO, InterPro, Pfam, PANTHER) and GO/KEGG enrichment files", folder: true },
    { path: "function/README.md", label: "How the functional annotation was made: tools and versions, merging rules, file formats and an R enrichment example" },
    { path: "query/query.sqlite", label: "The complete SQLite query database: stored candidate hits, relations and pan-gene tables for batch work in R or Python" },
    { path: "query/README.md", label: "How to use the database: tables, the compressed hit records, R and Python examples; query/05_query_data.py queries it from the command line" },
  ],
};
