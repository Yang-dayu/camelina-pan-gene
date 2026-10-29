// One on-demand protein alignment example. Sequence data stay on Hugging Face;
// Kalign runs in a disposable worker on the visitor's device.
"use strict";

window.ProteinAlignmentView = (() => {
  let active = null;

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

  // Reject a stale example before starting an alignment, even if IDs look familiar.
  async function fetchSequences(options, signal) {
    const { example, manifest, homeologs, members } = options;
    const response = await fetch(new URL(example.path, options.downloadBase), { signal });
    require(response.ok, `Sequence download returned HTTP ${response.status}.`);
    const bytes = await response.arrayBuffer();
    require(await sha256(bytes) === example.sha256, "The sequence file checksum does not match this example.");
    const data = JSON.parse(new TextDecoder().decode(bytes));
    require(data.schema === 1 && data.molecule === "protein", "Unsupported sequence file format.");
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

  function download(text, filename, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = element("a", { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function fasta(rows) {
    return rows.map((row) => `>${row.genome}|${row.gene_id} protein=${row.protein_id} transcript=${row.transcript_id}\n`
      + row.sequence.match(/.{1,80}/g).join("\n")).join("\n") + "\n";
  }

  function memberTable(rows) {
    const fields = ["genome", "gene_id", "protein_id", "transcript_id", "chromosome", "start", "end", "length", "sha256"];
    return [fields.join("\t"), ...rows.map((row) => fields.map((key) => row[key]).join("\t"))].join("\n") + "\n";
  }

  function downloadButton(label, onclick) {
    return element("button", { type: "button", class: "secondary", onclick }, label);
  }

  function colour(residue) {
    if ("AVLIMFWY".includes(residue)) return "hydrophobic";
    if ("KRH".includes(residue)) return "basic";
    if ("DE".includes(residue)) return "acidic";
    if ("STNQ".includes(residue)) return "polar";
    if ("CGP".includes(residue)) return "special";
    return residue === "-" ? "gap" : "unknown";
  }

  // Conservation uses all displayed rows as its denominator; gaps and X are
  // not counted as residues, so a mostly empty column cannot look conserved.
  function columnSummary(rows) {
    return Array.from({ length: rows[0].sequence.length }, (_, index) => {
      const counts = new Map();
      for (const row of rows) {
        const residue = row.sequence[index];
        if (residue !== "-" && residue !== "X") counts.set(residue, (counts.get(residue) || 0) + 1);
      }
      const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return { residue: sorted[0]?.[0] || "-", fraction: (sorted[0]?.[1] || 0) / rows.length };
    });
  }

  function renderAlignment(container, rows, result) {
    const summary = columnSummary(rows);
    const reference = rows.find((row) => row.genome === "Joelle") || rows[0];
    const differences = element("input", { type: "checkbox", onchange: () => {
      viewport.classList.toggle("msa-highlight-differences", differences.checked);
    } });
    const viewport = element("div", { class: "msa-scroll", tabindex: "0", role: "region",
      "aria-label": "Protein multiple sequence alignment; scroll horizontally to see all columns" });
    const ruler = element("div", { class: "msa-track msa-ruler" }, summary.map((_, index) =>
      element("span", { class: "msa-aa" }, index === 0 || (index + 1) % 10 === 0 ? index + 1 : "")));
    const table = element("table", { class: "msa-table" });
    table.append(element("thead", {}, element("tr", {},
      element("th", { class: "msa-label", scope: "col" }, "Annotation / gene"),
      element("th", { scope: "col", "aria-label": "Aligned amino acids" }, ruler))));
    const tbody = element("tbody");
    for (const row of rows) {
      const track = element("div", { class: "msa-track", "aria-label": `${row.genome}: ${row.sequence}` });
      for (const [index, residue] of [...row.sequence].entries()) {
        track.append(element("span", {
          class: `msa-aa msa-${colour(residue)}${residue !== reference.sequence[index] ? " msa-difference" : ""}`,
          title: `Alignment column ${index + 1}: ${residue === "-" ? "gap" : residue}`,
          "aria-hidden": "true",
        }, residue));
      }
      const label = element("th", { class: "msa-label", scope: "row" },
        element("strong", {}, row.genome), element("code", {}, row.gene_id),
        element("small", {}, `${row.length.toLocaleString("en-US")} aa`));
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
      const labelWidth = table.querySelector(".msa-label").getBoundingClientRect().width;
      const first = Math.floor(Math.max(0, viewport.scrollLeft - 10) / 11) + 1;
      const visible = Math.max(1, Math.floor((viewport.clientWidth - labelWidth - 20) / 11));
      rangeLabel.textContent = `Columns ${first}–${Math.min(summary.length, first + visible - 1)} of ${summary.length}`;
    };
    viewport.addEventListener("scroll", updateRange, { passive: true });
    const jump = (column) => { viewport.scrollLeft = column ? column * 11 + 10 : 0; updateRange(); };
    const navigation = element("div", { class: "msa-navigation" },
      downloadButton("Start", () => jump(0)),
      downloadButton(`First ${reference.genome} residue`, () => jump(firstReferenceColumn)),
      downloadButton("End", () => { viewport.scrollLeft = viewport.scrollWidth; updateRange(); }), rangeLabel);
    container.replaceChildren(
      element("div", { class: "msa-view-controls" },
        element("label", {}, differences, ` Highlight differences from ${reference.genome}`),
        element("span", { class: "muted small" }, `${rows.length} proteins · ${result.alignmentLength.toLocaleString("en-US")} alignment columns`)),
      navigation, viewport,
      element("p", { class: "muted small" }, "Scroll horizontally for the full alignment. Numbers refer to alignment columns; “-” is a gap and X is an unknown residue. "
        + "Conservation is the most frequent known residue divided by all displayed proteins, including rows with gaps."),
      element("div", { class: "msa-colour-key", "aria-label": "Residue colour key" },
        [["hydrophobic", "Hydrophobic"], ["basic", "Basic"], ["acidic", "Acidic"], ["polar", "Polar"], ["special", "C / G / P"]]
          .map(([key, label]) => element("span", { class: `msa-${key}` }, label))),
    );
    // Start with the reference's first residue visible while retaining every
    // leading column. Start/End and the scrollbar expose the full alignment.
    requestAnimationFrame(() => { if (viewport.isConnected) jump(firstReferenceColumn); });
  }

  function cancel() {
    if (active) {
      active.controller.abort();
      active.dialog.classList.remove("alignment-dialog");
      active = null;
    }
  }

  function close() {
    const dialog = active?.dialog;
    cancel();
    if (dialog?.open) dialog.close();
  }

  async function open(options) {
    cancel();
    const { dialog, body, example, members } = options;
    const session = { controller: new AbortController(), dialog };
    active = session;
    dialog.classList.add("alignment-dialog");
    dialog.addEventListener("close", () => { if (active === session) cancel(); }, { once: true });
    const status = element("p", { class: "message", role: "status", "aria-live": "polite" }, "Loading representative protein sequences…");
    const view = element("div", { class: "msa-output" });
    const downloads = element("div", { class: "msa-downloads" });
    const actions = element("div", { class: "msa-actions" });
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
      element("h2", {}, `Protein alignment · ${example.subgenome} · ${options.chromosomes.join(" / ")}`),
      element("p", { class: "msa-intro" }, `Sample for ${options.homeologs.id}: one existing representative protein per selected annotation. `
        + `The original query is on ${options.homeologs.sg}; this alignment compares the ${example.subgenome} candidates.`),
      status, actions, downloads, view,
    );
    if (!dialog.open) dialog.showModal();
    try {
      require(members.length >= 2, "Select at least two annotations to make an alignment.");
      const rows = await fetchSequences(options, session.controller.signal);
      if (session.controller.signal.aborted || active !== session) return;
      const stem = example.path.split("/").pop().replace(/\.json$/, "");
      downloads.append(
        downloadButton("Download proteins (FASTA)", () => download(fasta(rows), `${stem}_proteins.faa`, "text/plain")),
        downloadButton("Download members (TSV)", () => download(memberTable(rows), `${stem}_members.tsv`, "text/tab-separated-values")),
      );
      status.textContent = `Aligning ${rows.length} proteins in your browser…`;
      const result = await window.ProteinAlignment.run(rows.map(({ name, sequence }) => ({ name, sequence })), {
        signal: session.controller.signal,
        onProgress: (message) => { if (active === session) status.textContent = typeof message === "string" ? message : message.message; },
      });
      if (session.controller.signal.aborted || active !== session) return;
      const aligned = new Map(result.aligned.map((row) => [row.name, row.sequence]));
      const alignedRows = rows.map((row) => ({ ...row, sequence: aligned.get(row.name) }));
      renderAlignment(view, alignedRows, result);
      view.append(element("details", { class: "group-technical" },
        element("summary", {}, "Alignment method and sequence source"),
        element("p", { class: "muted small" }, `${result.algorithm} ${result.version}: ${result.parameters}. `
          + "Unaligned sequences load from the pinned Hugging Face dataset; alignment runs on your device. "
          + "The proteins retain their full original sequences. Adding or removing annotations can change alignment columns. "
          + "Predicted correspondences and alignment gaps require biological interpretation."),
        element("p", { class: "muted small" },
          element("a", { href: new URL(example.path, options.downloadBase).href }, "Representative proteins and export metadata (JSON)"), " · ",
          element("a", { href: "assets/vendor/kalign-3.3.1/SOURCE.md" }, "Kalign source and license"))));
      downloads.prepend(downloadButton("Download alignment (FASTA)", () =>
        download(fasta(alignedRows), `${stem}_kalign_3.3.1.faa`, "text/plain")));
      status.textContent = `${rows.length} proteins aligned in your browser with ${result.algorithm} ${result.version}.`;
      view.dataset.complete = "true";
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
