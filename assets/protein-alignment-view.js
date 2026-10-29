// Published representative isoforms and locally supplied FASTA records share
// one protein alignment. Matching CDS codons follow that same alignment.
"use strict";

window.ProteinAlignmentView = (() => {
  let active = null;
  let alignmentResizeObserver = null;

  function element(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== null && value !== false) node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child !== null && child !== undefined) node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  function require(condition, message) {
    if (!condition) throw new Error(message);
  }

  async function sha256(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function checkPacketContext(data, options, molecule) {
    const { example, manifest, homeologs } = options;
    require(data.schema === 1 && data.molecule === molecule, "Unsupported sequence file format.");
    require(data.run === manifest.run && data.source_database_sha256 === manifest.source_database_sha256,
      "The sequences and lookup data belong to different versions.");
    require(data.query.id === homeologs.id && data.query.genome === options.queryGenome &&
      data.query.gene_key === homeologs.k && data.query.group === homeologs.group,
      "The sequence example does not belong to this query.");
    require(data.slot.subgenome === example.subgenome &&
      JSON.stringify(data.slot.chromosomes) === JSON.stringify(options.chromosomes),
      "The sequence example belongs to a different subgenome column.");
    require(data.sequences.length === data.sequence_count && data.sequence_count === manifest.target_genomes.length,
      "The example has an incomplete annotation list.");
  }

  async function fetchPacket(descriptor, base, signal) {
    const response = await fetch(new URL(descriptor.path, base), { signal });
    require(response.ok, `Sequence download returned HTTP ${response.status}.`);
    const bytes = await response.arrayBuffer();
    require(await sha256(bytes) === descriptor.sha256, "The sequence file checksum does not match this example.");
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // Reject a stale example before starting an alignment, even if IDs look familiar.
  async function fetchSequences(options, signal) {
    const { example, manifest, members } = options;
    const data = await fetchPacket(example, options.downloadBase, signal);
    checkPacketContext(data, options, "protein");

    const sequences = new Map();
    for (const row of data.sequences) {
      require(!sequences.has(row.genome), `Repeated annotation: ${row.genome}.`);
      require(manifest.target_genomes.includes(row.genome) && row.sequence.length === row.length &&
        /^[A-Z]+$/.test(row.sequence), `Invalid representative protein: ${row.genome}.`);
      require(await sha256(new TextEncoder().encode(row.sequence)) === row.sha256,
        `Protein checksum mismatch: ${row.genome}.`);
      sequences.set(row.genome, row);
    }
    return members.map((member, index) => {
      const row = sequences.get(member.genome);
      require(row && row.gene_id === member.gene_id && row.chromosome === member.chromosome &&
        row.start === member.start && row.end === member.end, `The selected candidate changed in ${member.genome}.`);
      return { ...row, name: `s${String(index + 1).padStart(4, "0")}` };
    });
  }

  async function fetchCds(options, proteins, signal) {
    const data = await fetchPacket(options.example.cds, options.downloadBase, signal);
    checkPacketContext(data, options, "CDS");
    require(data.genetic_code?.id === 1, "The CDS requires an unsupported genetic code.");
    require(data.source_protein_file_sha256 === options.example.sha256,
      "The CDS export belongs to a different representative-protein set.");
    const byGenome = new Map();
    for (const row of data.sequences) {
      require(!byGenome.has(row.genome) && options.manifest.target_genomes.includes(row.genome),
        "The CDS export has a repeated or unknown annotation.");
      require(row.sequence.length === row.length && /^[ACGTRYSWKMBDHVN]+$/i.test(row.sequence),
        `Invalid CDS sequence: ${row.genome}.`);
      require(await sha256(new TextEncoder().encode(row.sequence)) === row.sha256 &&
        await sha256(new TextEncoder().encode(row.alignment_cds)) === row.alignment_cds_sha256,
        `CDS checksum mismatch: ${row.genome}.`);
      byGenome.set(row.genome, row);
    }
    return proteins.map((protein) => {
      const row = byGenome.get(protein.genome);
      require(row && row.gene_id === protein.gene_id && row.gene_key === protein.gene_key &&
        row.transcript_id === protein.transcript_id && row.protein_id === protein.protein_id &&
        row.protein_sha256 === protein.sha256, `The CDS isoform differs from the protein in ${protein.genome}.`);
      return { ...row, name: protein.name };
    });
  }

  const sequenceKey = (row) => JSON.stringify([row.genome, row.gene_id]);
  const isUser = (row) => row.source === "user";

  // Keep the published packet checks above intact. Local records never enter
  // those checks or become part of a Hugging Face request.
  async function selectedSequences(options, signal) {
    const references = options.members.filter((member) => !isUser(member));
    const published = references.length
      ? await fetchSequences({ ...options, members: references }, signal) : [];
    const byKey = new Map(published.map((row) => [sequenceKey(row), row]));
    const rows = [];
    for (const [index, member] of options.members.entries()) {
      let row;
      if (isUser(member)) {
        require(typeof member.sequence === "string" && /^[ACDEFGHIKLMNPQRSTVWYBZX]+$/.test(member.sequence),
          `The local protein is invalid: ${member.gene_id}.`);
        row = {
          source: "user", input_type: member.input_type, genome: "User", gene_id: member.gene_id,
          protein_id: member.gene_id, transcript_id: member.cds ? member.gene_id : "Not supplied",
          sequence: member.sequence, length: member.sequence.length,
          sha256: await sha256(new TextEncoder().encode(member.sequence)),
          description: member.description, notes: member.notes, local_cds: member.cds,
        };
      } else {
        row = { ...byKey.get(sequenceKey(member)), source: "reference" };
      }
      rows.push({ ...row, name: `s${String(index + 1).padStart(4, "0")}` });
    }
    require(new Set(rows.map(sequenceKey)).size === rows.length, "The selection repeats a sequence identifier within the same source.");
    return rows;
  }

  async function selectedCds(options, proteins, signal) {
    const references = proteins.filter((row) => !isUser(row));
    const published = references.length ? await fetchCds(options, references, signal) : [];
    const byKey = new Map(published.map((row) => [sequenceKey(row), row]));
    const rows = [];
    for (const protein of proteins) {
      if (isUser(protein)) {
        require(protein.local_cds, `No CDS was supplied for ${protein.gene_id}.`);
        const cds = protein.local_cds;
        rows.push({
          ...cds, source: "user", input_type: "CDS", name: protein.name,
          genome: protein.genome, gene_id: protein.gene_id,
          protein_id: protein.protein_id, transcript_id: protein.transcript_id,
          protein_sha256: protein.sha256,
          sha256: await sha256(new TextEncoder().encode(cds.sequence)),
          description: protein.description, notes: protein.notes,
        });
      } else {
        rows.push({ ...byKey.get(sequenceKey(protein)), source: "reference", name: protein.name });
      }
    }
    return rows;
  }

  function download(text, filename, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = element("a", { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const tsvValue = (value) => value === null || value === undefined ? "" : String(value).replace(/[\t\r\n]/g, " ");

  function fasta(rows) {
    return rows.map((row) => `>${row.genome}|${row.gene_id} protein=${tsvValue(row.protein_id)} transcript=${tsvValue(row.transcript_id)}`
      + (isUser(row) ? ` source=user input_type=${row.input_type}` : "") + "\n"
      + row.sequence.match(/.{1,80}/g).join("\n")).join("\n") + "\n";
  }

  function memberTable(rows) {
    const fields = ["genome", "gene_id", "protein_id", "transcript_id", "chromosome", "start", "end", "length", "sha256",
      "source", "input_type", "description", "notes"];
    return [fields.join("\t"), ...rows.map((row) => fields.map((key) =>
      tsvValue(Array.isArray(row[key]) ? row[key].join("; ") : row[key])).join("\t"))].join("\n") + "\n";
  }

  function cdsMemberTable(proteins, cdsRows) {
    const fields = ["genome", "gene_id", "protein_id", "transcript_id", "protein_length_aa",
      "cds_length_nt", "coding_cds_length_nt", "terminal_stop", "protein_sha256", "cds_sha256",
      "source", "input_type", "description", "notes"];
    return [fields.join("\t"), ...proteins.map((protein, index) => {
      const cds = cdsRows[index];
      return [protein.genome, protein.gene_id, protein.protein_id, protein.transcript_id,
        protein.length, cds.length, cds.alignment_cds.length, cds.terminal_stop || "",
        protein.sha256, cds.sha256, protein.source, protein.input_type, protein.description,
        protein.notes?.join("; ")].map(tsvValue).join("\t");
    })].join("\n") + "\n";
  }

  function downloadButton(label, onclick) {
    return element("button", { type: "button", class: "secondary", onclick }, label);
  }

  function colour(residue, isCds) {
    if (isCds) return "ACGT".includes(residue) ? `base-${residue}` : residue === "-" ? "gap" : "unknown";
    if ("AVLIMFWY".includes(residue)) return "hydrophobic";
    if ("KRH".includes(residue)) return "basic";
    if ("DE".includes(residue)) return "acidic";
    if ("STNQ".includes(residue)) return "polar";
    if ("CGP".includes(residue)) return "special";
    return residue === "-" ? "gap" : "unknown";
  }

  // Conservation uses all displayed rows as its denominator; gaps and X are
  // not counted as residues, so a mostly empty column cannot look conserved.
  function columnSummary(rows, isCds) {
    return Array.from({ length: rows[0].sequence.length }, (_, index) => {
      const counts = new Map();
      for (const row of rows) {
        const residue = isCds ? row.sequence[index].toUpperCase() : row.sequence[index];
        const known = (isCds ? "ACGT" : "ACDEFGHIKLMNPQRSTVWY").includes(residue);
        if (known) counts.set(residue, (counts.get(residue) || 0) + 1);
      }
      const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return { residue: sorted[0]?.[0] || "-", fraction: (sorted[0]?.[1] || 0) / rows.length };
    });
  }

  function renderAlignment(container, rows, result, mode = "protein") {
    alignmentResizeObserver?.disconnect();
    const isCds = mode === "CDS";
    const summary = columnSummary(rows, isCds);
    const reference = rows.find((row) => row.genome === "Joelle") || rows[0];
    const differences = element("input", { type: "checkbox", onchange: () => {
      viewport.classList.toggle("msa-highlight-differences", differences.checked);
    } });
    const viewport = element("div", { class: "msa-scroll", tabindex: "0", role: "region",
      "aria-label": `${isCds ? "CDS" : "Protein"} multiple sequence alignment; scroll horizontally to see all columns` });
    const ruler = element("div", { class: "msa-track msa-ruler" }, summary.map((_, index) =>
      element("span", { class: "msa-aa" }, index === 0 || (index + 1) % 10 === 0 ? index + 1 : "")));
    const table = element("table", { class: "msa-table" });
    table.append(element("thead", {}, element("tr", {},
      element("th", { class: "msa-label", scope: "col" }, "Annotation / gene"),
      element("th", { scope: "col", "aria-label": isCds ? "Aligned coding bases" : "Aligned amino acids" }, ruler))));
    const tbody = element("tbody");
    for (const row of rows) {
      const track = element("div", { class: "msa-track", "aria-label": `${row.genome}: ${row.sequence}` });
      for (const [index, residue] of [...row.sequence].entries()) {
        const displayResidue = isCds ? residue.toUpperCase() : residue;
        const referenceResidue = isCds ? reference.sequence[index].toUpperCase() : reference.sequence[index];
        track.append(element("span", {
          class: `msa-aa msa-${colour(displayResidue, isCds)}${isCds && (index + 1) % 3 === 0 ? " msa-codon-end" : ""}`
            + (displayResidue !== referenceResidue ? " msa-difference" : ""),
          title: `Alignment column ${index + 1}: ${displayResidue === "-" ? "gap" : displayResidue}`
            + (isCds ? `; protein alignment column ${Math.floor(index / 3) + 1}, codon base ${index % 3 + 1}` : ""),
          "aria-hidden": "true",
        }, displayResidue));
      }
      const label = element("th", { class: "msa-label", scope: "row" },
        element("strong", {}, row.genome), element("code", {}, row.gene_id),
        element("small", {}, `${row.length.toLocaleString("en-US")} ${isCds ? "nt" : "aa"}`
          + (isCds && row.terminal_stop ? " incl. stop" : "")));
      tbody.append(element("tr", { "data-genome": row.genome }, label, element("td", {}, track)));
    }
    const bars = element("div", { class: "msa-track msa-conservation" });
    for (const [index, column] of summary.entries()) {
      bars.append(element("span", { class: "msa-aa",
        title: `Column ${index + 1}: ${Math.round(column.fraction * 100)}% share ${column.residue}` },
      element("i", { style: `height:${Math.round(column.fraction * 100)}%` })));
    }
    table.append(tbody, element("tfoot", {}, element("tr", {},
      element("th", { class: "msa-label", scope: "row" }, "Conservation"), element("td", {}, bars))));
    viewport.append(table);
    const firstReferenceColumn = reference.sequence.search(/[^-]/);
    const rangeLabel = element("span", { class: "muted small", "aria-live": "polite" });
    const updateRange = () => {
      if (!viewport.isConnected) return;
      const labelWidth = table.querySelector(".msa-label").getBoundingClientRect().width;
      const first = Math.floor(Math.max(0, viewport.scrollLeft - 10) / 11) + 1;
      const visible = Math.max(1, Math.floor((viewport.clientWidth - labelWidth - 20) / 11));
      rangeLabel.textContent = `Columns ${first}–${Math.min(summary.length, first + visible - 1)} of ${summary.length}`;
    };
    viewport.addEventListener("scroll", updateRange, { passive: true });
    const jump = (column) => { viewport.scrollLeft = column ? column * 11 + 10 : 0; updateRange(); };
    const navigation = element("div", { class: "msa-navigation" },
      downloadButton("Start", () => jump(0)),
      downloadButton(`First ${reference.genome} ${isCds ? "base" : "residue"}`, () => jump(firstReferenceColumn)),
      downloadButton("End", () => { viewport.scrollLeft = viewport.scrollWidth; updateRange(); }), rangeLabel);
    container.replaceChildren(
      element("div", { class: "msa-view-controls" },
        element("label", {}, differences, ` Highlight differences from ${reference.genome}`),
        element("span", { class: "muted small" }, `${rows.length} ${isCds ? "CDS sequences" : "proteins"} · `
          + `${result.alignmentLength.toLocaleString("en-US")} alignment columns`)),
      navigation, viewport,
      element("p", { class: "muted small" }, isCds
        ? "CDS codons follow the protein alignment: each protein gap becomes three base gaps. Numbers are CDS alignment columns, not genomic coordinates. "
          + "Terminal stop codons are retained in the original CDS download and excluded from this view. Ambiguous bases do not contribute to conservation. "
          + "Bases are displayed in uppercase; downloads retain source case."
        : "Scroll horizontally for the full alignment. Numbers refer to alignment columns; “-” is a gap and X is an unknown residue. "
          + "Conservation is the most frequent known residue divided by all displayed proteins, including rows with gaps."),
      element("div", { class: "msa-colour-key", "aria-label": "Residue colour key" },
        (isCds ? [["base-A", "A"], ["base-C", "C"], ["base-G", "G"], ["base-T", "T"], ["unknown", "Ambiguous"]]
          : [["hydrophobic", "Hydrophobic"], ["basic", "Basic"], ["acidic", "Acidic"], ["polar", "Polar"], ["special", "C / G / P"]])
          .map(([key, label]) => element("span", { class: `msa-${key}` }, label))),
    );
    // Start with the reference's first residue visible while retaining every
    // leading column. Start/End and the scrollbar expose the full alignment.
    requestAnimationFrame(() => { if (viewport.isConnected) jump(firstReferenceColumn); });
    alignmentResizeObserver = new ResizeObserver(updateRange);
    alignmentResizeObserver.observe(viewport);
  }

  function cancel(onlyDialog = false) {
    // Opening ordinary evidence details must not cancel an inline alignment.
    if (onlyDialog && active && !active.dialog) return;
    alignmentResizeObserver?.disconnect();
    alignmentResizeObserver = null;
    if (active) {
      active.controller.abort();
      active.dialog?.classList.remove("alignment-dialog");
      active = null;
    }
  }

  function close() {
    const dialog = active?.dialog;
    cancel();
    if (dialog?.open) dialog.close();
  }

  function methodDetails(options, result, isCds) {
    const hasReferences = options.members.some((member) => !isUser(member));
    const hasUsers = options.members.some(isUser);
    const descriptor = hasReferences ? (isCds ? options.example.cds : options.example) : null;
    const method = isCds
      ? "Each verified CDS codon follows its protein's Kalign alignment. No separate nucleotide alignment is calculated. "
        + "The CDS must translate to that same protein; only a separately declared terminal stop codon is omitted from the aligned view."
      : `${result.algorithm} ${result.version}: ${result.parameters}. All submitted amino acids are retained; import normalizations are recorded in the member table.`;
    return element("details", { class: "group-technical" },
      element("summary", {}, "Alignment method and sequence source"),
      element("p", { class: "muted small" }, method + " "
        + (hasReferences ? "Reference sequences load on demand from the pinned Hugging Face dataset. " : "")
        + (hasUsers ? "User records remain in this browser and are not uploaded. CDS input uses frame 1 and standard nuclear genetic code 1. " : "")
        + "Adding or removing sequences can change alignment columns. Alignment alone does not establish orthology or annotation correctness."),
      element("p", { class: "muted small" },
        descriptor ? element("a", { href: new URL(descriptor.path, options.downloadBase).href }, `${isCds ? "CDS" : "Representative proteins"} and export metadata (JSON)`) : null,
        descriptor ? " · " : null,
        element("a", { href: "assets/vendor/kalign-3.3.1/SOURCE.md" }, "Kalign source and license")));
  }

  async function open(options) {
    cancel();
    const { dialog, body, example, members } = options;
    const references = members.filter((member) => !isUser(member));
    const users = members.filter(isUser);
    const missingCds = users.filter((member) => !member.cds);
    const cdsAvailable = missingCds.length === 0 && (!references.length || Boolean(example?.cds));
    const stem = example?.path.split("/").pop().replace(/\.json$/, "") || "user_sequences";
    const filename = stem + (example && users.length ? "_with_user_sequences" : "");
    const session = { controller: new AbortController(), dialog, displayRequest: 0 };
    active = session;
    if (dialog) {
      dialog.classList.add("alignment-dialog");
      dialog.addEventListener("close", () => { if (active === session) cancel(); }, { once: true });
    }
    const status = element("p", { class: "message", role: "status", "aria-live": "polite" }, "Preparing selected sequences…");
    const view = element("div", { class: "msa-output" });
    const downloads = element("div", { class: "msa-downloads" });
    const actions = element("div", { class: "msa-actions" });
    const proteinButton = downloadButton("Protein", () => showMode("protein"));
    const cdsButton = downloadButton("CDS (bases)", () => showMode("CDS"));
    proteinButton.disabled = true;
    cdsButton.disabled = true;
    proteinButton.setAttribute("aria-pressed", "true");
    cdsButton.setAttribute("aria-pressed", "false");
    const modes = element("div", { class: "segmented msa-modes", role: "group", "aria-label": "Sequence type" }, proteinButton, cdsButton);
    const cdsNote = element("p", { class: "muted small msa-cds-availability" }, cdsAvailable ? ""
      : missingCds.length ? `CDS view is unavailable: no CDS was supplied for ${missingCds.map((member) => member.gene_id).join(", ")}. Deselect these protein-only records to view bases.`
        : "CDS view is unavailable for one or more reference sequences.");
    cdsNote.hidden = cdsAvailable;
    let rows, result, proteinAligned, cdsRows, cdsProjection, cdsTask;

    async function showMode(mode) {
      const request = ++session.displayRequest;
      const isCds = mode === "CDS";
      if (isCds && !cdsAvailable) return;
      proteinButton.setAttribute("aria-pressed", String(!isCds));
      cdsButton.setAttribute("aria-pressed", String(isCds));
      status.classList.remove("error");
      delete view.dataset.complete;
      downloads.replaceChildren();
      try {
        if (!isCds) {
          renderAlignment(view, proteinAligned, result);
          view.append(methodDetails(options, result, false));
          downloads.append(
            downloadButton("Download alignment (FASTA)", () => download(fasta(proteinAligned), `${filename}_kalign_3.3.1.faa`, "text/plain")),
            downloadButton("Download proteins (FASTA)", () => download(fasta(rows), `${filename}_proteins.faa`, "text/plain")),
            downloadButton("Download members (TSV)", () => download(memberTable(rows), `${filename}_members.tsv`, "text/tab-separated-values")),
          );
          status.textContent = `${rows.length} proteins aligned in your browser with ${result.algorithm} ${result.version}.`;
        } else {
          status.textContent = "Loading and validating the matching CDS sequences…";
          view.replaceChildren(element("p", { class: "muted" }, "CDS codons will follow the protein alignment."));
          if (!cdsTask) cdsTask = selectedCds(options, rows, session.controller.signal).catch((error) => { cdsTask = null; throw error; });
          cdsRows = await cdsTask;
          if (session.controller.signal.aborted || active !== session || request !== session.displayRequest) return;
          if (!cdsProjection) cdsProjection = window.CodonAlignment.validateAndProject(rows, result.aligned, cdsRows);
          const alignedByName = new Map(cdsProjection.aligned.map((row) => [row.name, row.sequence]));
          const alignedCds = cdsRows.map((row) => ({ ...row, sequence: alignedByName.get(row.name) }));
          renderAlignment(view, alignedCds, cdsProjection, "CDS");
          view.append(methodDetails(options, result, true));
          downloads.append(
            downloadButton("Download CDS alignment (FASTA)", () => download(fasta(alignedCds), `${filename}_protein_guided_cds.fna`, "text/plain")),
            downloadButton("Download CDS (FASTA)", () => download(fasta(cdsRows), `${filename}_cds.fna`, "text/plain")),
            downloadButton("Download members (TSV)", () => download(cdsMemberTable(rows, cdsRows), `${filename}_cds_members.tsv`, "text/tab-separated-values")),
          );
          status.textContent = `${cdsRows.length} CDS sequences shown in the protein alignment, with codons kept together.`;
        }
        view.dataset.molecule = mode;
        view.dataset.complete = "true";
      } catch (error) {
        if (active !== session || session.controller.signal.aborted || request !== session.displayRequest) return;
        view.replaceChildren();
        status.textContent = `Could not show ${isCds ? "CDS" : "protein"} alignment: ${error.message}`;
        status.classList.add("error");
      }
    }
    const cancelButton = downloadButton("Cancel alignment", () => {
      session.controller.abort();
      status.textContent = "Alignment cancelled. You can run it again.";
      cancelButton.hidden = true;
      retry.hidden = false;
    });
    const retry = downloadButton("Run again", () => open(options));
    retry.hidden = true;
    actions.append(cancelButton, retry);
    body.replaceChildren(
      element(dialog ? "h2" : "h3", {}, example && references.length
        ? `Sequence alignment · ${example.subgenome} · ${options.chromosomes.join(" / ")}` : "Sequence alignment · Your sequences"),
      element("p", { class: "msa-intro" }, references.length
        ? `Sample for ${options.homeologs.id}: one representative isoform per selected annotation. `
          + `The original query is on ${options.homeologs.sg}; reference candidates are from ${example.subgenome}. `
          + (users.length ? `${users.length} locally supplied sequence${users.length === 1 ? " is" : "s are"} also included.` : "")
        : "Only your selected FASTA records are aligned. No reference sequence download is needed."),
      modes, cdsNote, status, actions, downloads, view,
    );
    if (dialog && !dialog.open) dialog.showModal();
    try {
      require(members.length >= 2 && members.length <= 50, "Select between 2 and 50 sequences to make an alignment.");
      rows = await selectedSequences(options, session.controller.signal);
      if (session.controller.signal.aborted || active !== session) return;
      downloads.append(
        downloadButton("Download proteins (FASTA)", () => download(fasta(rows), `${filename}_proteins.faa`, "text/plain")),
        downloadButton("Download members (TSV)", () => download(memberTable(rows), `${filename}_members.tsv`, "text/tab-separated-values")),
      );
      status.textContent = `Aligning ${rows.length} proteins in your browser…`;
      result = await window.ProteinAlignment.run(rows.map(({ name, sequence }) => ({ name, sequence })), {
        signal: session.controller.signal,
        onProgress: (message) => { if (active === session) status.textContent = typeof message === "string" ? message : message.message; },
      });
      if (session.controller.signal.aborted || active !== session) return;
      const aligned = new Map(result.aligned.map((row) => [row.name, row.sequence]));
      proteinAligned = rows.map((row) => ({ ...row, sequence: aligned.get(row.name) }));
      proteinButton.disabled = false;
      cdsButton.disabled = !cdsAvailable;
      await showMode("protein");
      cancelButton.hidden = true;
      retry.hidden = false;
    } catch (error) {
      if (active !== session || session.controller.signal.aborted) return;
      status.textContent = `Could not complete the alignment: ${error.message}`;
      status.classList.add("error");
      cancelButton.hidden = true;
      retry.hidden = false;
    }
  }

  return { open, cancel, close };
})();
