// Read schema-2 transcript metadata first, then only the selected protein/CDS shards.
// Exact GFF transcript keys, database identity and compressed-file hashes are checked.
"use strict";

window.TranscriptSequences = (() => {
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const sha256 = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0")).join("");
  const textHash = (text) => sha256(new TextEncoder().encode(text));

  function create(base, queryManifest) {
    const root = new URL(base, document.baseURI);
    const cache = new Map();
    let manifestTask;

    async function manifest() {
      if (!manifestTask) manifestTask = (async () => {
        const response = await fetch(new URL("manifest.json", root));
        require(response.ok, `Sequence index: HTTP ${response.status}.`);
        const m = await response.json();
        require(m.schema === 2 && m.scope === "full" && m.complete === true,
          "The sequence index is not a complete all-transcript export.");
        require(m.run === queryManifest.run && m.source_database_sha256 === queryManifest.source_database_sha256 &&
          JSON.stringify(m.gene_key_ranges) === JSON.stringify(queryManifest.gene_key_ranges) &&
          JSON.stringify(m.target_genomes) === JSON.stringify(queryManifest.target_genomes),
          "The sequences and gene lookup belong to different data versions.");
        require(Number.isInteger(m.genes_per_file) && m.genes_per_file > 0 && m.genetic_code?.id === 1,
          "Unsupported sequence index settings.");
        return m;
      })().catch((error) => { manifestTask = null; throw error; });
      return manifestTask;
    }

    async function gene(member, family, signal) {
      signal?.throwIfAborted();
      const m = await manifest();
      signal?.throwIfAborted();
      const range = m.gene_key_ranges[member.genome];
      require(range && Number.isInteger(member.gene_key) && member.gene_key >= range[0] && member.gene_key <= range[1],
        `Invalid gene key for ${member.genome}/${member.gene_id}.`);
      const block = Math.floor((member.gene_key - range[0]) / m.genes_per_file);
      const relative = `${family}/${member.genome}/${String(block).padStart(4, "0")}.json.gz`;
      const descriptor = m.files[relative];
      require(descriptor, `The sequence index does not list ${relative}.`);
      if (!cache.has(relative)) {
        cache.set(relative, (async () => {
          const response = await fetch(new URL(relative, root));
          require(response.ok, `${relative}: HTTP ${response.status}.`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          require(bytes.length === descriptor.bytes && await sha256(bytes) === descriptor.sha256,
            `Sequence shard checksum mismatch: ${relative}.`);
          const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
          const packet = JSON.parse(text);
          require(packet.schema === 2 && packet.run === m.run && packet.source_database_sha256 === m.source_database_sha256 &&
            packet.genome === member.genome && packet.first_key === descriptor.first_key &&
            packet.molecule === (family === "cds" ? "CDS" : family) && packet.genes.length === descriptor.records,
            `Sequence shard identity mismatch: ${relative}.`);
          return packet;
        })().catch((error) => { cache.delete(relative); throw error; }));
      }
      const task = cache.get(relative);
      cache.delete(relative); cache.set(relative, task);
      while (cache.size > 24) cache.delete(cache.keys().next().value);
      const packet = await task;
      signal?.throwIfAborted();
      const row = packet.genes[member.gene_key - packet.first_key];
      require(row && row.k === member.gene_key && row.id === member.gene_id &&
        ["chromosome", "start", "end"].every((field) => member[field] == null || row[field] === member[field]),
        `Sequence gene identity mismatch: ${member.genome}/${member.gene_id}.`);
      return row;
    }

    function transcript(g, member) {
      const rows = g.transcripts.filter((t) => t.transcript_key === member.transcript_key);
      require(rows.length === 1, `The exact selected transcript is unavailable: ${member.genome}/${member.transcript_key}.`);
      const t = rows[0];
      require(t.transcript_id === member.transcript_id && t.protein_id === member.protein_id,
        `The selected transcript's identifiers changed: ${member.genome}/${member.gene_id}.`);
      return t;
    }

    async function proteins(members, signal) {
      return Promise.all(members.map(async (member, i) => {
        const t = transcript(await gene(member, "protein", signal), member);
        require(t.status === "available" && t.alignment_status === "supported" &&
          typeof t.sequence === "string" && t.sequence.length === t.length &&
          /^[ACDEFGHIKLMNPQRSTVWYBZX]+$/.test(t.sequence),
          `Protein cannot be aligned: ${member.genome}/${member.transcript_id} (${t.alignment_status || t.status}).`);
        require(await textHash(t.sequence) === t.sha256, `Protein checksum mismatch: ${member.genome}/${member.transcript_id}.`);
        signal?.throwIfAborted();
        return { ...member, ...t, gene_key: member.gene_key, gene_id: member.gene_id,
          genome: member.genome, name: `s${String(i + 1).padStart(4, "0")}` };
      }));
    }

    async function cds(proteins, signal) {
      return Promise.all(proteins.map(async (protein) => {
        const t = transcript(await gene(protein, "cds", signal), protein);
        require(t.status === "translation_verified" && typeof t.sequence === "string" &&
          typeof t.alignment_cds === "string" && t.sequence.length === t.length &&
          t.protein_sha256 === protein.sha256 && t.alignment_cds.length === protein.sequence.length * 3,
          `Matching CDS cannot be aligned: ${protein.genome}/${protein.transcript_id} (${t.status}).`);
        require(await textHash(t.sequence) === t.sha256 && await textHash(t.alignment_cds) === t.alignment_cds_sha256,
          `CDS checksum mismatch: ${protein.genome}/${protein.transcript_id}.`);
        signal?.throwIfAborted();
        return { ...protein, ...t, name: protein.name };
      }));
    }

    return Object.freeze({ manifest, catalog: (member, signal) => gene(member, "catalog", signal), proteins, cds,
      indexUrl: new URL("manifest.json", root).href });
  }

  return Object.freeze({ create });
})();
