// Project validated CDS codons onto an existing protein alignment. This module
// does not realign nucleotides or infer a CDS from an amino-acid sequence.
(() => {
  "use strict";

  // Standard nuclear genetic code, with T/C/A/G ordering within each codon row.
  const CODE = {
    TTT: "F", TTC: "F", TTA: "L", TTG: "L",
    TCT: "S", TCC: "S", TCA: "S", TCG: "S",
    TAT: "Y", TAC: "Y", TAA: "*", TAG: "*",
    TGT: "C", TGC: "C", TGA: "*", TGG: "W",
    CTT: "L", CTC: "L", CTA: "L", CTG: "L",
    CCT: "P", CCC: "P", CCA: "P", CCG: "P",
    CAT: "H", CAC: "H", CAA: "Q", CAG: "Q",
    CGT: "R", CGC: "R", CGA: "R", CGG: "R",
    ATT: "I", ATC: "I", ATA: "I", ATG: "M",
    ACT: "T", ACC: "T", ACA: "T", ACG: "T",
    AAT: "N", AAC: "N", AAA: "K", AAG: "K",
    AGT: "S", AGC: "S", AGA: "R", AGG: "R",
    GTT: "V", GTC: "V", GTA: "V", GTG: "V",
    GCT: "A", GCC: "A", GCA: "A", GCG: "A",
    GAT: "D", GAC: "D", GAA: "E", GAG: "E",
    GGT: "G", GGC: "G", GGA: "G", GGG: "G",
  };
  const BASES = {
    A: "A", C: "C", G: "G", T: "T",
    R: "AG", Y: "CT", S: "CG", W: "AT", K: "GT", M: "AC",
    B: "CGT", D: "AGT", H: "ACT", V: "ACG", N: "ACGT",
  };
  const DNA = /^[ACGTRYSWKMBDHVN]+$/i;
  const IDENTIFIERS = ["genome", "gene_id", "protein_id", "transcript_id"];
  const codonCache = new Map();

  function require(condition, message) {
    if (!condition) throw new Error(message);
  }

  function identity(row) {
    require(row && IDENTIFIERS.every((field) => typeof row[field] === "string" && row[field].length > 0),
      "A protein or CDS record has incomplete gene/isoform identifiers.");
    return JSON.stringify([row.genome, row.gene_id]);
  }

  // An ambiguous codon keeps its IUPAC bases. A single possible translation
  // is retained (GCN -> A); multiple possibilities give X (NNN -> X).
  // A codon whose every expansion is a stop gives *, never X.
  function translateCodon(codon) {
    // Source case can encode masking. Normalize only the lookup key, retaining
    // the original codon in every output and in the identity checks below.
    const key = codon.toUpperCase();
    if (!codonCache.has(key)) {
      const possible = new Set();
      for (const first of BASES[key[0]]) {
        for (const second of BASES[key[1]]) {
          for (const third of BASES[key[2]]) possible.add(CODE[first + second + third]);
        }
      }
      codonCache.set(key, possible.size === 1 ? [...possible][0] : "X");
    }
    return codonCache.get(key);
  }

  function validateCDS(protein, cds) {
    const label = `${protein.genome}/${protein.gene_id}`;
    for (const field of IDENTIFIERS) {
      require(protein[field] === cds[field], `The CDS uses a different gene or representative isoform: ${label}.`);
    }
    if (protein.gene_key !== undefined && cds.gene_key !== undefined) {
      require(protein.gene_key === cds.gene_key, `The CDS gene key differs from the protein: ${label}.`);
    }
    if (protein.sha256 && cds.protein_sha256) {
      require(protein.sha256 === cds.protein_sha256, `The CDS belongs to a different representative protein: ${label}.`);
    }
    require(typeof cds.sequence === "string" && DNA.test(cds.sequence) &&
      typeof cds.alignment_cds === "string" && DNA.test(cds.alignment_cds),
      `The CDS contains unavailable or unsupported DNA characters: ${label}.`);
    if (cds.length !== undefined) {
      require(Number.isInteger(cds.length) && cds.length === cds.sequence.length,
        `The original CDS length is inconsistent: ${label}.`);
    }
    require(Object.hasOwn(cds, "terminal_stop"), `The CDS terminal-stop status is not declared: ${label}.`);
    const stop = cds.terminal_stop;
    require(stop === null || typeof stop === "string" && stop.length === 3 && DNA.test(stop) && translateCodon(stop) === "*",
      `The declared terminal codon is not a definite stop: ${label}.`);
    require(cds.sequence === cds.alignment_cds + (stop || ""),
      `The original CDS differs from its declared coding region and terminal stop: ${label}.`);
    require(cds.alignment_cds.length === protein.sequence.length * 3,
      `The CDS length does not match this representative protein: ${label}.`);

    let ambiguousCodons = 0;
    for (let offset = 0; offset < cds.alignment_cds.length; offset += 3) {
      const codon = cds.alignment_cds.slice(offset, offset + 3);
      const translated = translateCodon(codon);
      require(translated !== "*", `The CDS has an internal stop at codon ${offset / 3 + 1}: ${label}.`);
      require(translated === protein.sequence[offset / 3],
        `The CDS translation differs from the representative protein at codon ${offset / 3 + 1}: ${label}.`);
      if (!/^[ACGT]{3}$/i.test(codon)) ambiguousCodons++;
    }
    return ambiguousCodons;
  }

  function validateProteinRows(proteins, alignedRows) {
    require(Array.isArray(proteins) && proteins.length > 0 && Array.isArray(alignedRows) &&
      proteins.length === alignedRows.length, "The protein and aligned-protein record counts differ.");
    const names = new Set(), genes = new Set(), aligned = new Map();
    let columns = null;
    for (const row of alignedRows) {
      require(row && typeof row.name === "string" && !aligned.has(row.name) &&
        typeof row.sequence === "string" && /^[A-Z-]+$/.test(row.sequence),
        "The protein alignment has an invalid or duplicate record.");
      if (columns === null) columns = row.sequence.length;
      require(row.sequence.length === columns, "The protein alignment rows have different column counts.");
      aligned.set(row.name, row.sequence);
    }
    for (const protein of proteins) {
      const key = identity(protein);
      require(typeof protein.name === "string" && /^[A-Za-z0-9_.:|,-]{1,200}$/.test(protein.name) &&
        !names.has(protein.name) && !genes.has(key), "The selected proteins have duplicate or invalid identifiers.");
      require(typeof protein.sequence === "string" && /^[A-Z]+$/.test(protein.sequence),
        `The original protein sequence is unavailable: ${protein.name}.`);
      if (protein.length !== undefined) {
        require(Number.isInteger(protein.length) && protein.length === protein.sequence.length,
          `The representative protein length is inconsistent: ${protein.name}.`);
      }
      require(aligned.get(protein.name)?.replace(/-/g, "") === protein.sequence,
        `The alignment does not preserve the original protein: ${protein.name}.`);
      names.add(protein.name);
      genes.add(key);
    }
    return { aligned, columns };
  }

  function validateAndProject(proteins, alignedRows, cdsRows) {
    const { aligned: alignedProteins, columns } = validateProteinRows(proteins, alignedRows);
    require(Array.isArray(cdsRows), "The CDS sequence list is unavailable.");
    const coding = new Map();
    for (const cds of cdsRows) {
      const key = identity(cds);
      require(!coding.has(key), `The CDS list repeats a gene: ${cds.genome}/${cds.gene_id}.`);
      coding.set(key, cds);
    }

    const excludedStops = [];
    const aligned = proteins.map((protein) => {
      const cds = coding.get(identity(protein));
      require(cds, `No matching representative CDS is available for ${protein.genome}/${protein.gene_id}.`);
      const ambiguousCodons = validateCDS(protein, cds);
      let offset = 0;
      const codons = [];
      for (const residue of alignedProteins.get(protein.name)) {
        if (residue === "-") codons.push("---");
        else {
          codons.push(cds.alignment_cds.slice(offset, offset + 3));
          offset += 3;
        }
      }
      const sequence = codons.join("");
      require(offset === cds.alignment_cds.length && sequence.length === columns * 3 &&
        sequence.replace(/-/g, "") === cds.alignment_cds,
        `Codon projection did not preserve the complete coding sequence: ${protein.name}.`);
      if (cds.terminal_stop) {
        excludedStops.push({ name: protein.name, genome: protein.genome, gene_id: protein.gene_id, codon: cds.terminal_stop });
      }
      return {
        name: protein.name, genome: protein.genome, gene_id: protein.gene_id,
        gene_key: protein.gene_key ?? cds.gene_key,
        protein_id: protein.protein_id, transcript_id: protein.transcript_id,
        sequence, original_cds: cds.sequence, alignment_cds: cds.alignment_cds,
        terminal_stop: cds.terminal_stop, protein_length: protein.sequence.length,
        cds_length: cds.sequence.length, ambiguous_codons: ambiguousCodons,
      };
    });
    return { aligned, alignmentLength: columns * 3, proteinAlignmentLength: columns, excludedStops };
  }

  window.CodonAlignment = Object.freeze({ validateAndProject });
})();
