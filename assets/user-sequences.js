// Parse local FASTA input for the browser alignment. This module neither
// fetches data nor uploads sequences; input identifiers remain display text.
(() => {
  "use strict";

  const limits = Object.freeze({
    maxInputBytes: 2 * 1024 * 1024,
    maxSequences: 50,
    maxProteinLength: 20000,
    maxTotalLength: 250000,
  });
  const PROTEIN = /^[ACDEFGHIKLMNPQRSTVWYBZX]+$/;

  function require(condition, message) {
    if (!condition) throw new Error(message);
  }

  function proteinInput(sequence, id, notes) {
    if (sequence.endsWith("*")) {
      sequence = sequence.slice(0, -1);
      notes.push("One terminal protein stop (*) was removed for alignment.");
    }
    require(sequence.length > 0, `Protein ${id} has no amino-acid sequence.`);
    require(!sequence.includes("*"), `Protein ${id} contains an internal or repeated stop (*).`);
    const normalized = sequence.toUpperCase();
    require(/^[A-Za-z]+$/.test(sequence) && PROTEIN.test(normalized),
      `Protein ${id} contains unsupported residues or characters. Use standard amino acids plus B, Z or X; U, O, J, gaps and digits are not supported.`);
    if (sequence !== normalized) notes.push("Protein letters were normalized to uppercase.");
    if (/^[ACGTN]+$/.test(normalized)) {
      notes.push("This protein uses only A/C/G/T/N. Check the input type if it is a nucleotide sequence.");
    }
    return normalized;
  }

  function parseFasta(text, type) {
    require(type === "protein" || type === "CDS", "Choose Protein or CDS as the input type.");
    require(typeof text === "string", "FASTA input must be text.");
    require(text.length <= limits.maxInputBytes && new TextEncoder().encode(text).length <= limits.maxInputBytes,
      "The FASTA input exceeds the 2 MiB local import limit.");
    const input = text.replace(/^\uFEFF/, "");
    const records = [], ids = new Set();
    let current = null;

    function finish() {
      if (!current) return;
      const sequence = current.parts.join("");
      require(sequence.length > 0, `FASTA record ${current.id} has no sequence.`);
      const notes = [];
      if (current.spaced) notes.push("Spaces and tabs in FASTA sequence lines were removed.");
      let protein, cds;
      if (type === "protein") {
        protein = proteinInput(sequence, current.id, notes);
      } else {
        require(sequence.length <= limits.maxProteinLength * 3 + 3,
          `CDS ${current.id} exceeds the 20,000 amino-acid limit after translation.`);
        require(typeof window.CodonAlignment?.prepareCDS === "function", "The CDS translation module is unavailable. Reload the page.");
        const prepared = window.CodonAlignment.prepareCDS(sequence, current.id);
        const { protein: translated, ...coding } = prepared;
        protein = translated;
        cds = coding;
        notes.push("CDS translated in reading frame 1 using the standard nuclear code (table 1).");
        if (cds.terminal_stop) notes.push(`Terminal stop ${cds.terminal_stop} is retained in the original CDS and excluded from alignment.`);
        if (cds.ambiguous_codons) notes.push(`${cds.ambiguous_codons} ambiguous codon(s) retained; unresolved translations use X.`);
      }
      require(protein.length <= limits.maxProteinLength,
        `Sequence ${current.id} exceeds the 20,000 amino-acid limit after translation, if applicable.`);
      const record = {
        id: current.id, description: current.description,
        input_type: type, sequence: protein, length: protein.length, notes,
      };
      if (cds) record.cds = cds;
      records.push(record);
    }

    for (const [index, line] of input.split(/\r\n|\n|\r/).entries()) {
      if (!line.trim()) continue;
      if (line.startsWith(">")) {
        finish();
        require(records.length < limits.maxSequences, "Import at most 50 FASTA records at a time.");
        const header = line.slice(1).trim();
        require(header.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(header),
          `FASTA header on line ${index + 1} is empty or contains a control character.`);
        const match = /^(\S+)(?:[ \t]+(.*))?$/.exec(header);
        require(match && match[1].length <= 200, `FASTA ID on line ${index + 1} must contain at most 200 characters.`);
        const id = match[1];
        require(!ids.has(id), `FASTA ID ${id} is repeated. Give each sequence a unique ID.`);
        ids.add(id);
        current = { id, description: match[2] || "", parts: [], spaced: false };
      } else {
        require(current, `FASTA sequence on line ${index + 1} needs a preceding >ID header.`);
        current.spaced ||= /[ \t]/.test(line);
        current.parts.push(line.replace(/[ \t]/g, ""));
      }
    }
    finish();
    require(records.length > 0, "Enter at least one FASTA record beginning with >ID.");
    const total = records.reduce((sum, record) => sum + record.length, 0);
    require(total <= limits.maxTotalLength, "The imported proteins exceed the 250,000 amino-acid total limit.");
    return records;
  }

  window.UserSequences = Object.freeze({ parseFasta, limits });
})();
