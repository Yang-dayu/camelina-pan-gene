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
  const compactGeneId = (id) => {
    const ids = id.split(",");
    return ids.length > 1 ? `${ids[0]} (+${ids.length - 1} IDs)` : id;
  };

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
    return element("div", { class: "alignment-location", title: `${member.chromosome}:${integer(member.start)}–${integer(member.end)} bp` },
      element("span", { class: "alignment-location-chromosome" }, member.chromosome),
      element("span", { class: "alignment-location-range" },
        element("span", { class: "alignment-coordinate" }, integer(member.start)), " – ",
        element("span", { class: "alignment-coordinate" }, integer(member.end)), " bp"));
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
    let orderedMembers = [...members];
    if (Array.isArray(options.order)) {
      const rank = new Map(options.order.map((genome, index) => [genome, index]));
      orderedMembers.sort((a, b) => (rank.get(a.genome) ?? members.length) - (rank.get(b.genome) ?? members.length));
    }
    const selectedMembers = () => orderedMembers.filter((member) => available(member) && selected.has(key(member)));
    const output = element("section", { class: "alignment-output", "aria-label": "Alignment result" });
    const count = element("span", { class: "alignment-selection-count selection-count", role: "status", "aria-live": "polite", "aria-atomic": "true" });
    const minimum = element("span", { class: "alignment-selection-minimum muted small" });
    const checkboxes = new Map();
    const rows = new Map();
    const rowMembers = new Map();
    const memberRows = new Map();
    const orderStatus = element("span", { class: "visually-hidden", role: "status", "aria-live": "polite", "aria-atomic": "true" });
    const button = (label, onclick, className = "selection-button") => element("button", { type: "button", class: className, onclick }, label);

    function selectionTsv() {
      const fields = ["query_id", "sequence_set", "included", "annotation", "gene_id", "chromosome", "start", "end", "protein_length_aa", "evidence", "state", "flags"];
      if (hasTranscripts) fields.push("transcript_key", "transcript_id", "protein_id", "protein_status", "cds_status", "candidate_reason");
      if (hasCandidates) fields.push("candidate_source", "homeolog_selected", "identity_pct", "query_coverage_pct",
        "target_coverage_pct", "bitscore", "evalue", "synteny", "orthofinder", "location_status",
        "metric_reference", "metric_query_genome", "metric_query_gene_id", "metric_query_protein_id", "metric_target_protein_id");
      const lines = orderedMembers.map((member) => [
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
      resetOrder.disabled = orderedMembers.every((member, index) => member === members[index]);
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
      // Keep the calculation's input order stable; display order is passed separately.
      const chosen = eligible.filter((member) => selected.has(key(member)));
      if (chosen.length >= 2) onRun?.(chosen, selectedMembers());
    }, "alignment-run");
    const resetOrder = button("Reset order", () => changeOrder([...members]));
    const filename = `${options.queryId || "alignment"}_${options.label || "selection"}`.replace(/[^A-Za-z0-9._-]+/g, "_");
    const save = button("Download selection (TSV)", () => download(selectionTsv(), `${filename}_selection.tsv`), "secondary");
    save.disabled = members.length === 0;
    const body = element("tbody");
    const rowAnimations = new Map(), landings = new Map();
    const easing = "cubic-bezier(0.2, 0.8, 0.2, 1)";
    const motionAllowed = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches && typeof body.animate === "function";

    // FLIP keeps rows at their current visual positions while their new layout settles.
    function animateRows(update, excluded = drag?.row) {
      const before = new Map([...body.children].map((row) => [row, row.getBoundingClientRect().top]));
      for (const animation of rowAnimations.values()) animation.cancel();
      rowAnimations.clear();
      update();
      if (!motionAllowed()) return;
      for (const row of body.children) {
        if (!row.isConnected || row === excluded) continue;
        const delta = (before.get(row) ?? row.getBoundingClientRect().top) - row.getBoundingClientRect().top;
        if (Math.abs(delta) < 0.5) continue;
        const animation = row.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
          { duration: 220, easing });
        rowAnimations.set(row, animation);
        animation.onfinish = () => { if (rowAnimations.get(row) === animation) rowAnimations.delete(row); };
      }
    }

    function liftPreview() {
      const bounds = drag.row.getBoundingClientRect();
      const viewport = body.closest(".table-wrap").getBoundingClientRect();
      const left = Math.max(0, bounds.left, viewport.left);
      const right = Math.min(innerWidth, bounds.right, viewport.right);
      const preview = element("div", { class: "alignment-drag-preview", "aria-hidden": "true", inert: true,
        style: `left:${left}px;top:${bounds.top}px;width:${Math.max(0, right - left)}px;` });
      const copy = drag.row.cloneNode(true);
      copy.classList.remove("alignment-dragging");
      const originals = drag.row.querySelectorAll("input, select");
      copy.querySelectorAll("input, select").forEach((control, index) => {
        control.value = originals[index].value;
        if (control.tagName === "INPUT") control.checked = originals[index].checked;
      });
      [...copy.children].forEach((cell, index) => {
        const width = drag.row.children[index].getBoundingClientRect().width;
        cell.style.width = cell.style.minWidth = cell.style.maxWidth = `${width}px`;
      });
      const previewTable = element("table", { class: "alignment-preview-table",
        style: `width:${bounds.width}px;margin-left:${bounds.left - left}px;` }, element("tbody", {}, copy));
      preview.append(previewTable);
      document.body.append(preview);
      drag.preview = preview;
      drag.previewTop = bounds.top;
      drag.offsetY = drag.startY - bounds.top;
      if (motionAllowed()) preview.animate([{ opacity: 0.45 }, { opacity: 1 }], { duration: 110, easing });
    }
    function followPreview() {
      if (drag?.preview) drag.preview.style.transform = `translate3d(0, ${drag.y - drag.offsetY - drag.previewTop}px, 0)`;
    }
    function settlePreview(finished) {
      const preview = finished.preview;
      if (!preview) return;
      const landing = { preview, animation: null, cleanup: () => {
        preview.remove();
        if (landings.get(finished.row) === landing) {
          landings.delete(finished.row);
          finished.row.classList.remove("alignment-dragging");
        }
      } };
      landings.set(finished.row, landing);
      if (!motionAllowed() || !body.isConnected) { landing.cleanup(); return; }
      const from = preview.style.transform;
      const delta = finished.row.getBoundingClientRect().top - finished.previewTop;
      landing.animation = preview.animate([{ transform: from }, { transform: `translate3d(0, ${delta}px, 0)` }],
        { duration: 180, easing, fill: "forwards" });
      landing.animation.finished.then(landing.cleanup, landing.cleanup);
    }

    function changeOrder(next, moved, excluded) {
      const changed = next.some((member, index) => member !== orderedMembers[index]);
      orderedMembers = next;
      animateRows(() => body.append(...orderedMembers.map((member) => memberRows.get(member))), excluded);
      refresh();
      if (changed) options.onOrderChange?.(orderedMembers);
      if (moved) orderStatus.textContent = `${window.genomeLabel ? window.genomeLabel(moved.genome) : moved.genome} moved to position ${orderedMembers.indexOf(moved) + 1} of ${members.length}.`;
      else orderStatus.textContent = "Default annotation order restored.";
    }

    let drag = null, scrollFrame = 0;
    function moveDragTarget() {
      const target = document.elementFromPoint(drag.x, drag.y)?.closest("tr[data-genome]");
      if (!target || target === drag.row || target.parentElement !== body) return;
      const bounds = target.getBoundingClientRect();
      const reference = drag.y < bounds.top + bounds.height / 2 ? target : target.nextSibling;
      if (reference === drag.row || reference === drag.row.nextSibling) return;
      animateRows(() => body.insertBefore(drag.row, reference));
      // Moving a captured element can release its pointer capture.
      drag.handle.setPointerCapture(drag.pointerId);
    }
    function scrollDrag() {
      if (!drag?.moved) return;
      if (!body.isConnected) { finishDrag({ pointerId: drag.pointerId }, true); return; }
      followPreview();
      const top = document.querySelector(".topbar")?.getBoundingClientRect().bottom || 0;
      const edge = 64;
      const delta = drag.y < top + edge ? -Math.min(18, (top + edge - drag.y) / 3)
        : drag.y > innerHeight - edge ? Math.min(18, (drag.y - innerHeight + edge) / 3) : 0;
      if (delta) { window.scrollBy(0, delta); moveDragTarget(); }
      scrollFrame = requestAnimationFrame(scrollDrag);
    }
    function finishDrag(event, cancelled = false) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const finished = drag;
      drag = null;
      cancelAnimationFrame(scrollFrame);
      if (finished.handle.hasPointerCapture(finished.pointerId)) finished.handle.releasePointerCapture(finished.pointerId);
      if (cancelled) animateRows(() => body.append(...orderedMembers.map((member) => memberRows.get(member))), finished.row);
      else if (finished.moved && body.isConnected) changeOrder([...body.children].map((row) => rowMembers.get(row)), finished.member, finished.row);
      settlePreview(finished);
      finished.handle.focus({ preventScroll: true });
    }

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
          title: member.gene_id || "Choose a gene",
          disabled: typeof options.onGeneChange !== "function",
          onchange: (event) => options.onGeneChange?.(member, event.target.value),
        });
        if (!member.gene_id) geneChooser.append(element("option", { value: "" }, "Choose a gene"));
        else if (!member.candidates.some((candidate) => candidate.gene_id === member.gene_id)) {
          geneChooser.append(element("option", { value: member.gene_id, selected: true }, compactGeneId(member.gene_id)));
        }
        for (const candidate of member.candidates) {
          geneChooser.append(element("option", { value: candidate.gene_id, selected: candidate.gene_id === member.gene_id,
            title: `${candidateLabel(candidate)}; query coverage ${percentage(candidate.query_coverage)}; target coverage ${percentage(candidate.target_coverage)}` }, compactGeneId(candidate.gene_id)));
        }
        const source = member.candidate_source === "query" ? "Query gene"
          : member.homeolog_selected ? "Predicted pick" : member.gene_id ? "Sequence alternative" : "";
        const place = locationStatus(member.location_status);
        geneCell = element("td", { class: "alignment-gene-cell" }, geneChooser,
          member.gene_id?.includes(",") ? element("code", { class: "alignment-full-gene-id" },
            member.gene_id.split(",").flatMap((id, index) => [index ? ", " : "", element("span", {}, id)])) : null,
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
            element("summary", {}, "Why?"), element("p", {}, plainReason(member.reason))) : null);
      } else if (hasTranscripts) {
        const chooser = element("select", {
          class: "alignment-transcript", "aria-label": `Transcript for ${member.gene_id || member.genome}`,
          title: member.transcript_id || "Choose a transcript",
          disabled: !member.transcripts?.length,
          onchange: (event) => options.onTranscriptChange?.(member, event.target.value),
        });
        if (!member.transcript_key) chooser.append(element("option", { value: "" }, "Choose a transcript"));
        for (const t of member.transcripts || []) {
          chooser.append(element("option", { value: t.transcript_key, selected: t.transcript_key === member.transcript_key,
            title: `GFF ID: ${t.transcript_key}; protein: ${t.protein_id || "none"}; ${t.protein_length ?? 0} aa${t.is_representative ? "; default" : ""}` },
          t.transcript_id
            + (t.protein_alignment_status !== "supported" ? ` · ${(t.protein_alignment_status || "unavailable").replaceAll("_", " ")}` : "")));
        }
        transcriptCell = element("td", { class: "alignment-transcript-cell" }, chooser,
          member.transcript_key && member.is_representative
            ? element("div", { class: "muted small" }, "Default transcript") : null,
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
      const handle = element("button", { type: "button", class: "alignment-drag-handle",
        "aria-label": `Reorder ${window.genomeLabel ? window.genomeLabel(member.genome) : member.genome}`,
        title: "Drag to reorder; use Arrow Up or Arrow Down when focused.",
        "aria-keyshortcuts": "ArrowUp ArrowDown Home End",
        onpointerdown: (event) => {
          if (event.button !== 0 || event.isPrimary === false || drag) return;
          event.preventDefault();
          const landing = landings.get(row);
          if (landing) { landing.animation?.cancel(); landing.cleanup(); }
          handle.focus({ preventScroll: true });
          drag = { member, row, handle, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
            startY: event.clientY, moved: false };
          handle.setPointerCapture(event.pointerId);
        },
        onpointermove: (event) => {
          if (!drag || drag.pointerId !== event.pointerId) return;
          drag.x = event.clientX; drag.y = event.clientY;
          if (!drag.moved && Math.abs(drag.y - drag.startY) < 5) return;
          event.preventDefault();
          if (!drag.moved) {
            drag.moved = true;
            liftPreview();
            row.classList.add("alignment-dragging");
            scrollFrame = requestAnimationFrame(scrollDrag);
          }
          followPreview();
          moveDragTarget();
        },
        onpointerup: (event) => finishDrag(event),
        onpointercancel: (event) => finishDrag(event, true),
        onkeydown: (event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || drag) return;
          event.preventDefault();
          const index = orderedMembers.indexOf(member);
          const destination = event.key === "Home" ? 0 : event.key === "End" ? members.length - 1
            : Math.max(0, Math.min(members.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
          if (destination === index) return;
          const next = orderedMembers.filter((value) => value !== member);
          next.splice(destination, 0, member);
          changeOrder(next, member);
          handle.focus({ preventScroll: true });
          handle.scrollIntoView({ block: "nearest", inline: "nearest" });
        },
      });
      handle.innerHTML = '<svg viewBox="0 0 12 18" aria-hidden="true"><circle cx="3" cy="3" r="1.5"/><circle cx="9" cy="3" r="1.5"/><circle cx="3" cy="9" r="1.5"/><circle cx="9" cy="9" r="1.5"/><circle cx="3" cy="15" r="1.5"/><circle cx="9" cy="15" r="1.5"/></svg>';
      const row = element("tr", { "data-genome": member.genome, "data-gene-id": member.gene_id || "", class: usable ? "" : "alignment-unavailable" },
        element("td", { class: "alignment-include" }, checkbox),
        element("th", { scope: "row" }, element("div", { class: "alignment-annotation" }, handle,
          element("span", {}, window.genomeLabel ? window.genomeLabel(member.genome) : member.genome))),
        geneCell,
        transcriptCell,
        element("td", { class: "loc" }, location(member)),
        element("td", { class: "num" }, integer(member.length)),
        element("td", { class: "evidence" }, evidenceNode));
      body.append(row);
      rowMembers.set(row, member);
      memberRows.set(member, row);
      if (usable) {
        checkboxes.set(key(member), checkbox);
        rows.set(key(member), row);
      }
    }
    body.append(...orderedMembers.map((member) => memberRows.get(member)));

    const table = element("table", { class: "alignment-candidates", "aria-label": hasTranscripts ? "Candidate genes and transcripts" : "Candidate genes" },
      element("thead", {}, element("tr", {}, ["Include", "Annotation", "Gene", ...(hasTranscripts ? ["Transcript"] : []), "Genomic location", "Protein (aa)", "Evidence"]
        .map((label) => element("th", { scope: "col" }, label)))), body);
    const picker = element("article", { class: "alignment-picker target", "aria-label": "Alignment selection" },
      element("p", { class: "alignment-order-help muted small" }, "Drag the handles to set the order of the alignment rows.", orderStatus),
      element("div", { class: "table-wrap" }, table),
      element("div", { class: "alignment-run-controls" }, run, selectAll, clear, resetOrder, save, count, minimum));
    if (members.length !== eligible.length) picker.append(element("p", { class: "alignment-selection-note muted small" },
      "Genes without an available sequence cannot be selected."));
    container.replaceChildren(picker, output);
    refresh();
    return { output, selectedMembers, selectionTsv };
  }

  return Object.freeze({ key, render });
})();
