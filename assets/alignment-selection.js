// Select the genes for one alignment without changing annotation filters in
// other views. The caller owns the selected Set and starts the alignment.
"use strict";

window.AlignmentSelection = (() => {
  let nextUserId = 0;
  const key = (member) => member.source === "user"
    ? JSON.stringify(["user", member.selection_id])
    : JSON.stringify([member.genome, member.gene_id]);
  const available = (member) => member.available !== false && typeof member.gene_id === "string" && member.gene_id.length > 0;

  function element(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
      else if (value !== false && value !== null && value !== undefined) node.setAttribute(name, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child !== null && child !== undefined) node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  const integer = (value) => Number.isFinite(value) ? value.toLocaleString("en-US") : "–";
  const tsvValue = (value) => value === null || value === undefined ? "" : String(value).replace(/[\t\r\n]/g, " ");

  function location(member) {
    if (!member.chromosome || !Number.isFinite(member.start) || !Number.isFinite(member.end)) return "Not available";
    return `${member.chromosome}:${integer(member.start)}–${integer(member.end)} bp`;
  }

  function download(text, filename) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/tab-separated-values;charset=utf-8" }));
    const link = element("a", { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function render(container, options) {
    const { members, selected, onSelectionChange, onRun, onDetails } = options;
    const userMembers = options.userMembers || [];
    const allMembers = [...members, ...userMembers];
    const draft = options.importDraft || { type: "protein", text: "" };
    const eligible = allMembers.filter(available);
    if (new Set(eligible.map(key)).size !== eligible.length) throw new Error("The alignment candidate list contains a repeated gene.");
    const selectedMembers = () => eligible.filter((member) => selected.has(key(member)));
    const output = element("section", { class: "alignment-output", "aria-label": "Alignment result" });
    const count = element("span", { class: "alignment-selection-count selection-count", role: "status", "aria-live": "polite", "aria-atomic": "true" });
    const minimum = element("span", { class: "alignment-selection-minimum muted small" });
    const checkboxes = new Map();
    const rows = new Map();
    const button = (label, onclick, className = "selection-button") => element("button", { type: "button", class: className, onclick }, label);

    function selectionTsv() {
      const fields = ["query_id", "sequence_set", "included", "annotation", "gene_id", "chromosome", "start", "end", "protein_length_aa", "evidence", "state", "flags",
        "source", "input_type", "description", "notes", "cds_available"];
      const lines = allMembers.map((member) => [
        options.queryId, options.label, available(member) && selected.has(key(member)) ? 1 : 0,
        member.genome, member.gene_id, member.chromosome, member.start, member.end,
        member.length, member.evidence, member.state,
        Array.isArray(member.flags) ? member.flags.join(";") : member.flags,
        member.source === "user" ? "user" : "reference", member.input_type || "protein",
        member.description, (member.notes || []).join("; "),
        member.source === "user" ? (member.cds ? 1 : 0) : (options.referenceCdsAvailable === false ? 0 : 1),
      ].map(tsvValue).join("\t"));
      return [fields.join("\t"), ...lines].join("\n") + "\n";
    }

    function refresh() {
      const chosen = selectedMembers();
      const total = chosen.length;
      const knownLength = chosen.reduce((sum, member) => sum + (member.length || 0), 0);
      count.textContent = `${total} of ${eligible.length} ${userMembers.length ? "sequences" : "genes"} selected`;
      minimum.textContent = total < 2 ? "Choose at least two sequences to run an alignment."
        : total > 50 ? "Select at most 50 sequences. Exclude some rows before running."
        : knownLength > 250000 ? "The selected proteins exceed 250,000 aa. Exclude some rows before running."
        : chosen.some((member) => member.source === "user" && !member.cds)
          ? "Protein view only: a selected user protein has no CDS. Exclude it to enable the CDS view."
          : options.referenceCdsAvailable === false && chosen.some((member) => member.source !== "user")
            ? "Protein view only: matching reference CDS sequences are unavailable."
          : "Protein and matching CDS views will use this selection.";
      run.disabled = total < 2 || total > 50 || knownLength > 250000;
      selectAll.disabled = total === eligible.length;
      clear.disabled = total === 0;
      for (const member of eligible) {
        const checked = selected.has(key(member));
        checkboxes.get(key(member)).checked = checked;
        rows.get(key(member)).classList.toggle("alignment-excluded", !checked);
      }
    }

    function changeSelection(update) {
      const before = selectedMembers().map(key).join("\n");
      update();
      refresh();
      if (before !== selectedMembers().map(key).join("\n")) onSelectionChange?.(selectedMembers());
    }

    const selectAll = button("Select all genes", () => changeSelection(() => eligible.forEach((member) => selected.add(key(member)))));
    const clear = button("Clear genes", () => changeSelection(() => selected.clear()));
    const run = button("Run alignment", () => {
      const chosen = selectedMembers();
      if (chosen.length >= 2 && chosen.length <= 50) onRun?.(chosen);
    }, "alignment-run");
    const filename = `${options.queryId || "alignment"}_${options.label || "selection"}`.replace(/[^A-Za-z0-9._-]+/g, "_");
    const save = button("Download selection (TSV)", () => download(selectionTsv(), `${filename}_selection.tsv`), "secondary");
    save.disabled = allMembers.length === 0;
    const body = element("tbody");
    for (const member of allMembers) {
      const usable = available(member);
      const checkbox = element("input", { type: "checkbox", disabled: !usable,
        "aria-label": `Include ${member.gene_id || "unavailable gene"} from ${member.genome}`,
        onchange: (event) => changeSelection(() => {
          if (!usable) return;
          if (event.target.checked) selected.add(key(member));
          else selected.delete(key(member));
        }),
      });
      const isUser = member.source === "user";
      const evidence = isUser ? "User supplied; no correspondence evidence assigned" : member.evidence || "Not available";
      const evidenceNode = !isUser && onDetails && usable
        ? button(evidence, () => onDetails(member), `badge evidence-help state-${member.state || "unknown"}`)
        : element("span", { class: "muted" }, evidence);
      const identifier = element("div", {}, usable ? element("code", {}, member.gene_id) : element("span", { class: "muted" }, "Not available"));
      if (isUser && member.description) identifier.append(element("small", { class: "alignment-user-description" }, member.description));
      const evidenceCell = element("td", { class: "evidence" }, evidenceNode);
      if (isUser) {
        if (member.notes?.length) evidenceCell.append(element("details", { class: "alignment-import-notes" },
          element("summary", {}, "Input notes"), element("ul", {}, member.notes.map((note) => element("li", {}, note)))));
        evidenceCell.append(button(`Remove ${member.gene_id}`, () => {
          userMembers.splice(userMembers.indexOf(member), 1);
          selected.delete(key(member));
          userChanged();
        }, "link-button alignment-remove"));
      }
      const row = element("tr", { "data-genome": member.genome, "data-gene-id": member.gene_id || "", class: usable ? "" : "alignment-unavailable" },
        element("td", { class: "alignment-include" }, checkbox),
        element("th", { scope: "row" }, member.genome,
          isUser ? element("small", { class: "alignment-user-type" }, member.input_type === "CDS" ? "CDS + translated protein" : "Protein only") : null),
        element("td", {}, identifier),
        element("td", { class: "loc" }, location(member)),
        element("td", { class: "num" }, integer(member.length)),
        evidenceCell);
      body.append(row);
      if (usable) {
        checkboxes.set(key(member), checkbox);
        rows.set(key(member), row);
      }
    }

    // Importing does not fetch reference sequences or start a worker. The
    // caller retains these rows only for the current query in browser memory.
    let fileRead = 0;
    function userChanged() {
      fileRead++;
      if (options.onUserChange) options.onUserChange();
      else render(container, { ...options, userMembers, importDraft: draft });
    }
    const importStatus = element("p", { class: "alignment-import-status muted small", role: "status", "aria-live": "polite" }, draft.status || "");
    if (draft.error) importStatus.classList.add("error");
    function message(text, error = false) {
      draft.status = text;
      draft.error = error;
      importStatus.textContent = text;
      importStatus.classList.toggle("error", error);
    }
    function add(text, type) {
      try {
        const parsed = window.UserSequences.parseFasta(text, type);
        if (userMembers.length + parsed.length > 50) throw new Error("Keep at most 50 imported sequences. Remove some rows before adding more.");
        const ids = new Set(userMembers.map((member) => member.gene_id));
        for (const entry of parsed) {
          if (ids.has(entry.id)) throw new Error(`An imported sequence already uses the FASTA ID ${entry.id}. Use distinct IDs.`);
          ids.add(entry.id);
        }
        const additions = parsed.map((entry) => ({ ...entry, source: "user", genome: "User",
          gene_id: entry.id, selection_id: `user:${++nextUserId}` }));
        userMembers.push(...additions);
        additions.forEach((member) => selected.add(key(member)));
        draft.text = "";
        message(`Added ${additions.length} ${type === "CDS" ? "CDS sequences and their translations" : "protein sequences"}. Review the selected rows before running.`);
        userChanged();
      } catch (error) {
        message(error.message, true);
      }
    }
    const updatePlaceholder = () => {
      textarea.placeholder = typeSelect.value === "CDS"
        ? ">my_cds\nATGCCAGAACCAACTATTGATGAATAA" : ">my_sequence\nMPEPTIDE";
    };
    const typeSelect = element("select", { id: "alignment-import-type", onchange: () => { draft.type = typeSelect.value; updatePlaceholder(); } },
      element("option", { value: "protein" }, "Protein"), element("option", { value: "CDS" }, "CDS (coding DNA)"));
    typeSelect.value = draft.type || "protein";
    const textarea = element("textarea", { id: "alignment-import-fasta", rows: "5", spellcheck: "false",
      oninput: () => { draft.text = textarea.value; } });
    textarea.value = draft.text || "";
    updatePlaceholder();
    const addPaste = button("Add pasted sequences", () => { fileRead++; add(textarea.value, typeSelect.value); });
    const file = element("input", { id: "alignment-import-file", type: "file", accept: ".fa,.fasta,.faa,.fna,.fas,.txt,text/plain",
      onchange: async () => {
        const chosenFile = file.files?.[0];
        if (!chosenFile) return;
        const request = ++fileRead;
        const type = typeSelect.value;
        if (chosenFile.size > 2 * 1024 * 1024) {
          message("The FASTA file is too large. Choose an uncompressed file of at most 2 MiB.", true);
          file.value = "";
          return;
        }
        message("Reading FASTA file locally…");
        try {
          const text = await chosenFile.text();
          if (!picker.isConnected || request !== fileRead) return;
          add(text, type);
        } catch (error) {
          if (picker.isConnected && request === fileRead) message(`Could not read the FASTA file: ${error.message}`, true);
        } finally {
          file.value = "";
        }
      } });
    const clearImported = button("Clear imported sequences", () => {
      userMembers.forEach((member) => selected.delete(key(member)));
      userMembers.splice(0);
      message("Imported sequences cleared.");
      userChanged();
    });
    clearImported.disabled = userMembers.length === 0;
    const importer = element("section", { class: "alignment-import", "aria-labelledby": "alignment-import-heading" },
      element("h4", { id: "alignment-import-heading" }, "Add your own sequences"),
      element("p", { class: "muted small" }, "Paste FASTA or choose a FASTA file. Imported sequences stay in your browser for this query and are cleared by a new lookup or page reload. They are not uploaded."),
      element("div", { class: "alignment-import-type" }, element("label", { for: "alignment-import-type" }, "Input type"), typeSelect),
      element("p", { class: "muted small" }, "CDS must be coding DNA in frame 1, without introns, using the standard nuclear genetic code (table 1). It is translated before protein alignment; the bases then follow the aligned codons. Protein-only input cannot provide a CDS view."),
      element("label", { for: "alignment-import-fasta" }, "FASTA sequences"), textarea,
      element("div", { class: "alignment-import-actions" }, addPaste, clearImported),
      element("div", { class: "alignment-import-file" }, element("label", { for: "alignment-import-file" }, "Or add a FASTA file"), file),
      element("p", { class: "muted small" }, "Unaligned sequences only. Up to 50 imported sequences and 2 MiB per input; each protein is limited to 20,000 aa. At most 50 sequences and 250,000 aa can be aligned together."),
      importStatus);

    const table = element("table", { class: "alignment-candidates" },
      element("thead", {}, element("tr", {}, ["Include", "Annotation / source", "Gene / FASTA ID", "Genomic location", "Protein (aa)", "Evidence"]
        .map((label) => element("th", { scope: "col" }, label)))), body);
    const picker = element("article", { class: "alignment-picker target" },
      element("header", { class: "alignment-selection-header target-header" },
        element("h3", {}, "Choose sequences", options.label ? element("span", { class: "pill" }, options.label) : null), count),
      element("p", { class: "alignment-selection-intro muted" },
        "Include or exclude sequences before running the alignment. This selection affects Alignment only."),
      importer,
      element("div", { class: "alignment-selection-actions" }, selectAll, clear),
      element("div", { class: "table-wrap" }, table),
      element("div", { class: "alignment-run-controls" }, run, save, minimum));
    if (allMembers.length !== eligible.length) picker.append(element("p", { class: "alignment-selection-note muted small" },
      "Genes without an available sequence cannot be selected."));
    container.replaceChildren(picker, output);
    refresh();
    return { output, selectedMembers, selectionTsv };
  }

  return Object.freeze({ key, render });
})();
