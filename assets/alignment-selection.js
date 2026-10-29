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
      const lines = members.map((member) => [
        options.queryId, options.label, available(member) && selected.has(key(member)) ? 1 : 0,
        member.genome, member.gene_id, member.chromosome, member.start, member.end,
        member.length, member.evidence, member.state,
        Array.isArray(member.flags) ? member.flags.join(";") : member.flags,
      ].map(tsvValue).join("\t"));
      return [fields.join("\t"), ...lines].join("\n") + "\n";
    }

    function refresh() {
      const total = selectedMembers().length;
      count.textContent = `${total} of ${eligible.length} genes selected`;
      minimum.textContent = total < 2 ? "Choose at least two genes to run an alignment." : "Protein and matching CDS views will use this selection.";
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
      const evidence = member.evidence || "Not available";
      const evidenceNode = onDetails && usable
        ? button(evidence, () => onDetails(member), `badge evidence-help state-${member.state || "unknown"}`)
        : element("span", { class: "muted" }, evidence);
      const row = element("tr", { "data-genome": member.genome, "data-gene-id": member.gene_id || "", class: usable ? "" : "alignment-unavailable" },
        element("td", { class: "alignment-include" }, checkbox),
        element("th", { scope: "row" }, member.genome),
        element("td", {}, usable ? element("code", {}, member.gene_id) : element("span", { class: "muted" }, "Not available")),
        element("td", { class: "loc" }, location(member)),
        element("td", { class: "num" }, integer(member.length)),
        element("td", { class: "evidence" }, evidenceNode));
      body.append(row);
      if (usable) {
        checkboxes.set(key(member), checkbox);
        rows.set(key(member), row);
      }
    }

    const table = element("table", { class: "alignment-candidates" },
      element("thead", {}, element("tr", {}, ["Include", "Annotation", "Gene", "Genomic location", "Protein (aa)", "Evidence"]
        .map((label) => element("th", { scope: "col" }, label)))), body);
    const picker = element("article", { class: "alignment-picker target" },
      element("header", { class: "alignment-selection-header target-header" },
        element("h3", {}, "Choose sequences", options.label ? element("span", { class: "pill" }, options.label) : null), count),
      element("p", { class: "alignment-selection-intro muted" },
        "Include or exclude genes before running the alignment. This selection affects Alignment only."),
      element("div", { class: "alignment-selection-actions" }, selectAll, clear),
      element("div", { class: "table-wrap" }, table),
      element("div", { class: "alignment-run-controls" }, run, save, minimum));
    if (members.length !== eligible.length) picker.append(element("p", { class: "alignment-selection-note muted small" },
      "Genes without an available sequence cannot be selected."));
    container.replaceChildren(picker, output);
    refresh();
    return { output, selectedMembers, selectionTsv };
  }

  return Object.freeze({ key, render });
})();
