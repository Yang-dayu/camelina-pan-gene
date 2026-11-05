// Select the genes for one alignment without changing annotation filters in
// other views. The caller owns the selected Set and starts the alignment.
"use strict";

window.AlignmentSelection = (() => {
  const key = (member) => JSON.stringify([member.genome, member.gene_id]);
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
  const percentage = (value) => Number.isFinite(value) ? `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })}%` : "–";
  const tsvValue = (value) => value === null || value === undefined ? "" : String(value).replace(/[\t\r\n]/g, " ");

  function locationStatus(status) {
    return { cross_chromosome: "Cross-chromosome", "cross-chromosome": "Cross-chromosome", unplaced: "Unplaced" }[status] || "";
  }

  function candidateLabel(candidate) {
    const labels = [candidate.gene_id, candidate.chromosome || "location unavailable"];
    if (Number.isFinite(candidate.identity)) labels.push(`${percentage(candidate.identity)} identity`);
    if (Number.isFinite(candidate.bitscore)) labels.push(`${integer(candidate.bitscore)} bits`);
    if (candidate.complete === false) labels.push(Number.isFinite(candidate.query_coverage) && Number.isFinite(candidate.target_coverage)
      ? "lower coverage" : "coverage unavailable");
    if (candidate.homeolog_selected) labels.push("predicted pick");
    else if (candidate.recommended) labels.push("suggested");
    return labels.join(" · ");
  }

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
    const hasTranscripts = members.some((member) => Array.isArray(member.transcripts));
    const hasCandidates = members.some((member) => Array.isArray(member.candidates));
    const eligible = members.filter(available);
    if (new Set(eligible.map(key)).size !== eligible.length) throw new Error("The alignment candidate list contains a repeated gene.");
    const selectedMembers = () => eligible.filter((member) => selected.has(key(member)));
    const output = element("section", { class: "alignment-output", "aria-label": "Alignment result" });
    const count = element("span", { class: "alignment-selection-count selection-count", role: "status", "aria-live": "polite", "aria-atomic": "true" });
    const minimum = element("span", { class: "alignment-selection-minimum muted small" });
    const checkboxes = new Map();
    const rows = new Map();
    const button = (label, onclick, className = "selection-button") => element("button", { type: "button", class: className, onclick }, label);

    function selectionTsv() {
      const fields = ["query_id", "sequence_set", "included", "annotation", "gene_id", "chromosome", "start", "end", "protein_length_aa", "evidence", "state", "flags"];
      if (hasTranscripts) fields.push("transcript_key", "transcript_id", "protein_id", "protein_status", "cds_status", "candidate_reason");
      if (hasCandidates) fields.push("candidate_source", "homeolog_selected", "identity_pct", "query_coverage_pct",
        "target_coverage_pct", "bitscore", "evalue", "synteny", "orthofinder", "location_status",
        "metric_reference", "metric_query_genome", "metric_query_gene_id", "metric_query_protein_id", "metric_target_protein_id");
      const lines = members.map((member) => [
        options.queryId, options.label, available(member) && selected.has(key(member)) ? 1 : 0,
        member.genome, member.gene_id, member.chromosome, member.start, member.end,
        member.length, member.evidence, member.state,
        Array.isArray(member.flags) ? member.flags.join(";") : member.flags,
        ...(hasTranscripts ? [member.transcript_key, member.transcript_id, member.protein_id, member.protein_status, member.cds_status, member.reason] : []),
        ...(hasCandidates ? [member.candidate_source, member.homeolog_selected ? 1 : 0, member.identity,
          member.query_coverage, member.target_coverage, member.bitscore, member.evalue,
          member.synteny ? 1 : 0, member.orthofinder ? 1 : 0, member.location_status,
          member.metric_reference, member.metric_query_genome, member.metric_query_gene_id,
          member.metric_query_protein_id, member.metric_target_protein_id] : []),
      ].map(tsvValue).join("\t"));
      return [fields.join("\t"), ...lines].join("\n") + "\n";
    }

    function refresh() {
      const total = selectedMembers().length;
      count.textContent = `${total} of ${eligible.length} genes selected`;
      minimum.textContent = total < 2 ? "Choose at least two genes to run an alignment." : "";
      minimum.hidden = total >= 2;
      run.disabled = total < 2;
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
      if (chosen.length >= 2) onRun?.(chosen);
    }, "alignment-run");
    const filename = `${options.queryId || "alignment"}_${options.label || "selection"}`.replace(/[^A-Za-z0-9._-]+/g, "_");
    const save = button("Download selection (TSV)", () => download(selectionTsv(), `${filename}_selection.tsv`), "secondary");
    save.disabled = members.length === 0;
    const body = element("tbody");
    for (const member of members) {
      const usable = available(member);
      const checkbox = element("input", { type: "checkbox", disabled: !usable,
        "aria-label": `Include ${member.gene_id || "unavailable gene"} from ${member.genome}`,
        onchange: (event) => changeSelection(() => {
          if (!usable) return;
          if (event.target.checked) selected.add(key(member));
          else selected.delete(key(member));
        }),
      });
      const evidence = member.evidence || (member.cell && !member.gene_id ? "Why no candidate?" : "Not available");
      const evidenceNode = onDetails && (usable || member.cell)
        ? button(evidence, () => onDetails(member), `badge evidence-help state-${member.state || "unknown"}`)
        : element("span", { class: "muted" }, evidence);
      let geneCell;
      if (hasCandidates && member.candidates?.length) {
        const geneChooser = element("select", {
          class: "alignment-gene", "aria-label": `Gene for ${member.genome}`,
          disabled: typeof options.onGeneChange !== "function",
          onchange: (event) => options.onGeneChange?.(member, event.target.value),
        });
        if (!member.gene_id) geneChooser.append(element("option", { value: "" }, "Choose a gene"));
        else if (!member.candidates.some((candidate) => candidate.gene_id === member.gene_id)) {
          geneChooser.append(element("option", { value: member.gene_id, selected: true }, member.gene_id));
        }
        for (const candidate of member.candidates) {
          geneChooser.append(element("option", { value: candidate.gene_id, selected: candidate.gene_id === member.gene_id,
            title: `${candidateLabel(candidate)}; query coverage ${percentage(candidate.query_coverage)}; target coverage ${percentage(candidate.target_coverage)}` }, candidateLabel(candidate)));
        }
        const source = member.candidate_source === "query" ? "Query gene"
          : member.homeolog_selected ? "Predicted pick" : member.gene_id ? "Sequence alternative" : "";
        const place = locationStatus(member.location_status);
        geneCell = element("td", { class: "alignment-gene-cell" }, geneChooser,
          element("div", { class: "alignment-candidate-tags" },
            source ? element("span", { class: "badge hint" }, source) : null,
            place ? element("span", { class: "badge partial" }, place) : null),
          element("div", { class: "muted small" }, `${member.candidates.length} stored candidate${member.candidates.length === 1 ? "" : "s"}`));
      } else {
        geneCell = element("td", { class: hasCandidates ? "alignment-gene-cell" : "" },
          member.gene_id ? element("code", {}, member.gene_id) : element("span", { class: "muted" }, "Not available"));
      }
      let transcriptCell;
      if (hasTranscripts && !member.gene_id) {
        transcriptCell = element("td", { class: "alignment-transcript-cell" },
          element("span", { class: "muted" }, "No candidate selected under the current rules"),
          member.reason ? element("details", { class: "small alignment-missing-reason" },
            element("summary", {}, "Why?"), element("p", {}, member.reason)) : null);
      } else if (hasTranscripts) {
        const chooser = element("select", {
          class: "alignment-transcript", "aria-label": `Transcript for ${member.gene_id || member.genome}`,
          disabled: !member.transcripts?.length,
          onchange: (event) => options.onTranscriptChange?.(member, event.target.value),
        });
        if (!member.transcript_key) chooser.append(element("option", { value: "" }, "Choose a transcript"));
        for (const t of member.transcripts || []) {
          chooser.append(element("option", { value: t.transcript_key, selected: t.transcript_key === member.transcript_key,
            title: `GFF ID: ${t.transcript_key}; protein: ${t.protein_id || "none"}` },
          `${t.transcript_id}${t.is_representative ? " (default)" : ""} · ${t.protein_length ?? 0} aa`
            + (t.protein_alignment_status !== "supported" ? ` · ${(t.protein_alignment_status || "unavailable").replaceAll("_", " ")}` : "")));
        }
        transcriptCell = element("td", { class: "alignment-transcript-cell" }, chooser,
          element("div", { class: "muted small" }, member.transcript_key
            ? `CDS: ${(member.cds_status || "unavailable").replaceAll("_", " ")}` : "No default protein; choose an available transcript."),
          member.transcript_key && member.is_representative === false
            ? element("div", { class: "muted small alignment-score-reference" }, "Match scores still use the default transcript.") : null);
      }
      if (hasCandidates) {
        const hasCoverage = Number.isFinite(member.query_coverage) && Number.isFinite(member.target_coverage);
        const metrics = element("div", { class: "alignment-match-cell",
          title: "Stored comparison of the original query and target representative proteins. Selecting another transcript does not recalculate these values." },
          element("div", { title: "Identity in the original representative-protein alignment" }, `Protein identity: ${percentage(member.identity)}`),
          element("div", { class: "muted small", title: "Fraction of each protein covered by the original alignment" },
            element("span", { class: "alignment-query-coverage" }, `Query coverage: ${percentage(member.query_coverage)}`), " · ",
            element("span", { class: "alignment-target-coverage" }, `Target coverage: ${percentage(member.target_coverage)}`)),
          element("div", { class: "muted small" }, `${integer(member.bitscore)} bits · E-value ${member.evalue ?? "–"}`),
          member.complete === false && hasCoverage ? element("span", { class: "badge partial", title: "Query or target coverage is below 80%." }, "Lower coverage") : null);
        const tags = geneCell.querySelector(".alignment-candidate-tags");
        if (tags) tags.after(metrics);
        else geneCell.append(metrics);
      }
      const row = element("tr", { "data-genome": member.genome, "data-gene-id": member.gene_id || "", class: usable ? "" : "alignment-unavailable" },
        element("td", { class: "alignment-include" }, checkbox),
        element("th", { scope: "row" }, window.genomeLabel ? window.genomeLabel(member.genome) : member.genome),
        geneCell,
        transcriptCell,
        element("td", { class: "loc" }, location(member)),
        element("td", { class: "num" }, integer(member.length)),
        element("td", { class: "evidence" }, evidenceNode));
      body.append(row);
      if (usable) {
        checkboxes.set(key(member), checkbox);
        rows.set(key(member), row);
      }
    }

    const table = element("table", { class: "alignment-candidates", "aria-label": hasTranscripts ? "Candidate genes and transcripts" : "Candidate genes" },
      element("thead", {}, element("tr", {}, ["Include", "Annotation", "Gene", ...(hasTranscripts ? ["Transcript"] : []), "Genomic location", "Protein (aa)", "Evidence"]
        .map((label) => element("th", { scope: "col" }, label)))), body);
    const picker = element("article", { class: "alignment-picker target", "aria-label": "Alignment selection" },
      element("div", { class: "table-wrap" }, table),
      element("div", { class: "alignment-run-controls" }, run, selectAll, clear, save, count, minimum));
    if (members.length !== eligible.length) picker.append(element("p", { class: "alignment-selection-note muted small" },
      "Genes without an available sequence cannot be selected."));
    container.replaceChildren(picker, output);
    refresh();
    return { output, selectedMembers, selectionTsv };
  }

  return Object.freeze({ key, render });
})();
