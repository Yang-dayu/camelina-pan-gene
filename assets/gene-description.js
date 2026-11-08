// Query-time external annotations. Search jobs run behind the local API;
// this module only submits one gene and reads its local job status.
"use strict";

window.GeneDescription = (() => {
  let active = null;
  const pending = new Set(["queued", "searching", "fetching_annotations"]);
  const terminal = new Set(["ready", "no_hits", "error"]);

  function element(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
      else if (value !== null && value !== undefined && value !== false) node.setAttribute(name, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child !== null && child !== undefined) node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  const text = (value) => typeof value === "string" ? value : "";
  const percent = (value) => Number.isFinite(value) ? `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })}%` : "Not reported";
  const score = (value) => Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 1 }) : "Not reported";
  const evalue = (value) => typeof value === "string" && value.trim() ? value.trim()
    : typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : "Not reported";
  // This is a presentation policy, independent of the provider's search cutoff.
  const FUNCTION_SUMMARY_EVALUE = 1e-5;
  function significance(hit) {
    const raw = hit.evalue;
    const provided = typeof raw === "number" || typeof raw === "string" && raw.trim().length > 0;
    const numeric = provided ? Number(raw) : NaN;
    if (Number.isNaN(numeric) || numeric < 0) return "unknown";
    return numeric <= FUNCTION_SUMMARY_EVALUE ? "supported" : "weak";
  }
  const date = (value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Not reported";
  };

  function link(url, label) {
    try {
      const href = new URL(url);
      if (href.protocol === "https:" || href.protocol === "http:") {
        return element("a", { href: href.href, target: "_blank", rel: "noopener noreferrer" }, label);
      }
    } catch {}
    return element("span", {}, label);
  }

  function clear() {
    if (!active) return;
    clearTimeout(active.timer);
    active.controller.abort();
    active.container.replaceChildren();
    active.container.hidden = true;
    active = null;
  }

  const isCurrent = (session) => active === session && !session.controller.signal.aborted;

  function sourceDetails(session) {
    const data = session.data || {};
    const query = session.query || {};
    const search = data.search || {};
    const row = (label, value) => value ? [element("dt", {}, label), element("dd", {}, value)] : [];
    const source = element("details", { class: "gene-description-source", open: session.source?.open || false },
      element("summary", {}, "Source details"),
      element("dl", {},
        row("Query gene", `${session.args.genome}: ${session.args.geneId}`),
        row("Representative protein", text(query.protein_id)),
        row("Representative transcript", text(query.transcript_id)),
        row("Protein sequence SHA-256", text(query.sequence_sha256) ? element("code", {}, query.sequence_sha256) : ""),
        row("Search service", text(data.provider)),
        row("Search", [text(search.program), text(search.database)].filter(Boolean).join(" · ")),
        row("Taxonomy", text(search.taxonomy)),
        row("Coverage calculation", "Coordinate span of the highest-scoring single local alignment (HSP). Separate HSPs are not merged."),
        row("Function display policy", "Matched-protein functional summaries are shown when E-value is at most 1e-5. This display rule does not establish the query gene's function."),
        row("Submitted", data.submitted_utc ? date(data.submitted_utc) : ""),
        row(data.cached ? "Saved result updated" : "Updated", data.updated_utc ? date(data.updated_utc) : ""),
        row("Original search result", text(data.rid) ? link(`https://blast.ncbi.nlm.nih.gov/Blast.cgi?CMD=Get&RID=${encodeURIComponent(data.rid)}`, data.rid) : ""),
        row("Service message", text(data.error)),
      ));
    session.source = source;
    return source;
  }

  function databaseLinks(annotation) {
    const retrieved = Array.isArray(annotation?.cross_references);
    const references = retrieved ? annotation.cross_references : [];
    const body = element("tbody");
    for (const database of ["InterPro", "KEGG", "TAIR"]) {
      const matching = references.filter((r) => text(r.database).toLowerCase() === database.toLowerCase() && text(r.id));
      const entries = matching.length ? element("ul", {}, matching.map((r) => element("li", {},
        link(r.url, r.id), text(r.name) ? ` — ${r.name}` : "")))
        : element("span", { class: "muted" }, retrieved ? "Not linked in matched entry" : "Not retrieved for this match");
      body.append(element("tr", {}, element("th", { scope: "row" }, database), element("td", {}, entries)));
    }
    return element("table", { class: "gene-description-links", "aria-label": "Matched protein database links" }, body);
  }

  function annotationDetails(hit) {
    const annotation = hit.annotation || {};
    const names = Array.isArray(annotation.gene_names) ? annotation.gene_names.filter((name) => typeof name === "string" && name) : [];
    const organism = text(annotation.organism) || text(hit.organism) || "Not reported";
    const proteinName = text(annotation.protein_name) || text(hit.description) || "Protein name not reported";
    const support = significance(hit);
    const functionContent = support === "supported"
      ? element("p", { class: text(annotation.function) ? "gene-description-function" : "muted" },
        text(annotation.function) || (typeof annotation.function === "string"
          ? "No functional summary was provided in the matched UniProt entry." : "The functional summary was not retrieved for this match."))
      : element("p", { class: "gene-description-uncertain", role: "note" }, support === "weak"
        ? `Weak sequence match (E-value ${evalue(hit.evalue)}). The functional summary is not shown as an annotation for this query. Source links remain available for inspection.`
        : "Match significance was not reported. The functional summary is not shown as an annotation for this query. Source links remain available for inspection.");
    const item = (name, value) => value ? [element("dt", {}, name), element("dd", {}, value)] : [];
    return element("section", { class: "gene-description-entry", "aria-label": `Annotations for ${hit.accession}` },
      element("div", { class: "gene-description-entry-heading" },
        element("h3", {}, proteinName), link(hit.uniprot_url, `UniProt ${hit.accession}`)),
      element("dl", { class: "gene-description-facts" },
        item("Gene name", names.length ? names.join(", ") : Array.isArray(annotation.gene_names) ? "Not listed in matched entry" : "Not retrieved"), item("Organism", organism),
        item("Metadata source", annotation.source_url ? link(annotation.source_url, text(annotation.annotation_source) || "UniProt entry") : null)),
      element("h4", { class: "gene-description-function-title" }, "Matched protein function"), functionContent,
      databaseLinks(annotation),
      element("p", { class: "muted small gene-description-scope" },
        "These are similarity-based annotations of the matched UniProt entry. InterPro links come from that entry and are not an independent scan of this Camelina protein."));
  }

  function hitTable(session, hits) {
    const selected = session.selected;
    const body = element("tbody");
    for (const [index, hit] of hits.entries()) {
      const support = significance(hit);
      const name = text(hit.annotation?.protein_name) || text(hit.description) || "Protein name not reported";
      const button = element("button", { type: "button", class: "gene-description-hit",
        "aria-pressed": String(index === selected), "aria-label": `Show annotations for ${hit.accession}`,
        onclick: () => { if (isCurrent(session)) { session.selected = index; render(session); } },
      }, element("code", {}, text(hit.accession)), element("span", {}, name));
      body.append(element("tr", { class: index === selected ? "gene-description-selected" : "" },
        element("td", {}, button),
        element("td", {}, text(hit.annotation?.organism) || text(hit.organism) || "Not reported"),
        element("td", { class: "num" }, percent(hit.identity)),
        element("td", { class: "num" }, percent(hit.query_coverage)),
        element("td", { class: "num" }, percent(hit.target_coverage)),
        element("td", { class: "num" }, score(hit.bitscore)),
        element("td", { class: "num gene-description-significance" }, evalue(hit.evalue),
          support === "supported" ? null : element("span", { class: "gene-description-evidence-label muted" },
            support === "weak" ? "Weak match" : "Significance unknown"))));
    }
    return element("div", { class: "table-wrap gene-description-hit-wrap" },
      element("table", { class: "gene-description-hits", "aria-label": "External protein matches" },
        element("thead", {}, element("tr", {}, ["Matched protein", "Organism", "Identity", "Query coverage", "Match coverage", "Bit score", "E-value"]
          .map((title) => element("th", { scope: "col" }, title)))), body));
  }

  function render(session) {
    if (!isCurrent(session)) return;
    const data = session.data || { status: "queued" };
    const status = data.status;
    const states = { queued: "Queued", searching: "Searching…", fetching_annotations: "Reading annotations…",
      ready: "Ready", no_hits: "No matches reported", error: "Unavailable" };
    const open = session.panel?.open ?? true;
    const content = element("div", { class: "gene-description-content" });
    if (pending.has(status)) {
      content.append(element("p", { class: "muted gene-description-progress", role: "status" },
        status === "queued" ? "The external protein search is queued. Other query results remain available below."
          : status === "fetching_annotations" ? "Reading names, functional descriptions and database links for the closest matches."
          : "Searching reviewed UniProt proteins. Results will appear here when the external search finishes."));
    } else if (status === "ready") {
      const hits = Array.isArray(data.hits) ? data.hits.slice(0, 3) : [];
      if (hits.length) {
        session.selected = Math.min(session.selected, hits.length - 1);
        content.append(hitTable(session, hits), annotationDetails(hits[session.selected]));
      } else content.append(element("p", { class: "muted" }, "No protein matches were returned."));
    } else if (status === "no_hits") {
      content.append(element("p", { class: "muted" }, "No sequence match was reported by the external search."));
    } else {
      content.append(element("p", { class: "muted" }, session.unavailableProtein
        ? "No usable representative protein is available for this gene."
        : "External annotations could not be retrieved for this query. Other query results remain available."));
    }
    if (text(data.warning)) content.append(element("p", { class: "muted small" }, data.warning));
    content.append(sourceDetails(session));
    const panel = element("details", { class: "gene-description-panel", open },
      element("summary", { class: "gene-description-summary" },
        element("span", { class: "gene-description-title", role: "heading", "aria-level": "2" }, "Gene description"),
        element("span", { class: "gene-description-status muted", "aria-live": "polite", "aria-atomic": "true" }, states[status] || "Unavailable")),
      content);
    session.panel = panel;
    session.container.replaceChildren(panel);
    session.container.hidden = false;
  }

  async function request(session, url, init = {}) {
    const response = await fetch(url, { ...init, signal: session.controller.signal });
    const data = await response.json();
    if (!isCurrent(session)) return null;
    if (!response.ok) {
      session.unavailableProtein = response.status === 422;
      session.data = { ...data, status: "error" };
      return session.data;
    }
    if (!pending.has(data.status) && !terminal.has(data.status)) throw new Error("Unsupported annotation response.");
    return data;
  }

  async function poll(session) {
    if (!isCurrent(session)) return;
    try {
      const endpoint = new URL(session.base);
      endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/" + encodeURIComponent(session.id);
      const data = await request(session, endpoint);
      if (!data || !isCurrent(session)) return;
      session.data = data;
      render(session);
      if (pending.has(data.status)) session.timer = setTimeout(() => poll(session), 5000);
    } catch (error) {
      if (!isCurrent(session) || error.name === "AbortError") return;
      session.data = { ...session.data, status: "error", error: "Could not reach the annotation service." };
      render(session);
    }
  }

  async function load(args) {
    const { container, genome, geneId, geneKey, apiBase } = args;
    const key = JSON.stringify([genome, geneId, geneKey, apiBase]);
    if (active?.key === key && active.container === container && !active.controller.signal.aborted) return;
    clear();
    if (!container || !apiBase) { if (container) container.hidden = true; return; }
    const session = { args, key, container, controller: new AbortController(), selected: 0,
      base: new URL(apiBase, document.baseURI), data: { status: "queued" }, query: null, panel: null, source: null };
    active = session;
    render(session);
    try {
      const data = await request(session, session.base, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ genome, gene_id: geneId, gene_key: geneKey }),
      });
      if (!data || !isCurrent(session)) return;
      session.data = data;
      // Shared sequence caches can serve several genes. Keep this request's
      // own protein identifiers even if GET describes the cache's first gene.
      session.query = data.query || null;
      session.id = text(data.id);
      render(session);
      if (pending.has(data.status)) {
        if (!session.id || session.id.length > 128) throw new Error("Missing annotation job identity.");
        session.timer = setTimeout(() => poll(session), 5000);
      }
    } catch (error) {
      if (!isCurrent(session) || error.name === "AbortError") return;
      session.data = { ...session.data, status: "error", error: "Could not reach the annotation service." };
      render(session);
    }
  }

  return Object.freeze({ load, clear });
})();
