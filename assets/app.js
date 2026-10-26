// Camelina pan-gene lookup: a static page over the step-06 files (CONFIG.dataBase) and the step-07
// predicted homeologs (CONFIG.homeologBase). See the manifest.json of each for the file layout.
//
// A lookup takes two downloads:
//   1. ids/NNNN.json.gz, NNNN = FNV-1a hash of the typed ID mod 1024  -> [genome, gene ID, key, match]
//   2. genes/GENOME/NNNN.json.gz, NNNN = (key - first key of genome) // 500  -> the gene's record
// Pan-gene entry members and the homeolog record are fetched only when their view or dialog opens.
// Column positions come from the manifests, so the code does not hard-code the file layouts.
//
// Every lookup gets a sequence number; a result that arrives after a newer lookup started is
// dropped, so the search box and the result never show different genes.
"use strict";

const CONFIG = window.PANGENE_CONFIG;
const state = {
  manifest: null, homeologManifest: null,
  record: null, genome: null, typed: null, match: null,
  view: "overview", top: 10, shown: null, expanded: new Set(),
  lookupSeq: 0,
};
const col = { hit: {}, relation: {}, target: {}, cell: {} };   // column name -> position, from the manifests

// ---- Data access -----------------------------------------------------------------------------

const cache = new Map();

// Fetch one data file and parse it. Files are gzipped JSON; a server that already decoded the
// gzip (Content-Encoding) hands over plain JSON, so the first two bytes decide.
function load(path, base = CONFIG.dataBase) {
  const url = base + path;
  if (!cache.has(url)) {
    cache.set(url, (async () => {
      const response = await fetch(url);
      if (!response.ok) throw Object.assign(new Error(`${path}: HTTP ${response.status}`), { status: response.status, url });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
      const text = gzipped
        ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
        : new TextDecoder().decode(bytes);
      return JSON.parse(text);
    })());
    cache.get(url).catch(() => cache.delete(url));   // let a failed download be retried
  }
  return cache.get(url);
}

// FNV-1a 32-bit hash of the UTF-8 bytes, as in 06_web_shards.py.
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const pad4 = (n) => String(n).padStart(4, "0");

// ID -> list of [genome, gene ID, key, match], narrowed to one genome when given.
async function resolve(id, genome) {
  const file = await load(`ids/${pad4(fnv1a(id) % state.manifest.id_files)}.json.gz`);
  return (file[id] || []).filter((entry) => !genome || entry[0] === genome);
}

function geneFile(manifest, base, genome, key) {
  const [low] = manifest.gene_key_ranges[genome] || [];
  if (low === undefined) throw Object.assign(new Error(`${genome} is not in this data set`), { status: 404 });
  return load(`genes/${genome}/${pad4(Math.floor((key - low) / manifest.genes_per_file))}.json.gz`, base);
}

async function geneRecord(genome, key) {
  const file = await geneFile(state.manifest, CONFIG.dataBase, genome, key);
  return file.genes[key - file.first_key];
}

async function homeologRecord(genome, key) {
  const file = await geneFile(state.homeologManifest, CONFIG.homeologBase, genome, key);
  return file.genes[key - file.first_key];
}

async function entryMembers(frame, pg) {
  const file = await load(`pangenes/${frame}/${pad4(Math.floor(parseFloat(pg) / state.manifest.entries_per_file))}.json.gz`);
  return file.entries[pg] || [];
}

// ---- Small helpers ---------------------------------------------------------------------------

const $ = (selector) => document.querySelector(selector);

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === "class") node.className = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const fmt = {
  int: (v) => (v === null || v === undefined ? "–" : Number(v).toLocaleString("en-US")),
  pct: (v) => (v === null || v === undefined ? "–" : Number(v).toFixed(1)),
  bits: (v) => (v === null || v === undefined ? "–" : Number(v).toFixed(0)),
  mb: (v) => (v === null || v === undefined ? "–" : `${(v / 1e6).toFixed(2)} Mb`),
  loc: (chr, start, end) => `${chr}:${fmt.int(start)}–${fmt.int(end)}`,
};

const isChromosome = (name) => /^Chr\d\d$/.test(name || "");

function message(text, kind = "info") {
  const box = $("#message");
  box.hidden = !text;
  box.className = `message ${kind}`;
  box.replaceChildren(...(Array.isArray(text) ? text : [text || ""]));
}

// A gene ID that runs a new lookup when clicked.
function geneLink(id, genome) {
  return el("a", { href: `#q=${encodeURIComponent(id)}&g=${encodeURIComponent(genome)}`, class: "gene-link" }, id);
}

function coverageCell(value) {
  if (value === null || value === undefined) return el("td", { class: "num" }, "–");
  return el("td", { class: "num cov" },
    el("span", { class: "bar", style: `--w:${Math.min(100, value)}%` }), fmt.pct(value));
}

function badges({ synteny, orthofinder, sharedEntry, qcov, tcov }) {
  const list = [];
  if (synteny === 2) list.push(el("span", { class: "badge anchor", title: "Direct syntenic anchor pair" }, "anchor"));
  else if (synteny === 1) list.push(el("span", { class: "badge syn", title: "Direct syntenic pair" }, "synteny"));
  if (orthofinder) list.push(el("span", { class: "badge of", title: "OrthoFinder pairwise orthologue" }, "OrthoFinder"));
  if (sharedEntry) list.push(el("span", { class: "badge pg", title: "Same pan-gene entry (query genome frame)" }, "same entry"));
  if (qcov !== null && qcov !== undefined && Math.min(qcov, tcov) < 50) {
    list.push(el("span", { class: "badge partial", title: "Local match: one coverage below 50%. Check the annotation structure." }, "partial"));
  }
  return list;
}

function openDialog(...content) {
  $("#dialog-body").replaceChildren(...content.flat().filter(Boolean));
  const dialog = $("#dialog");
  if (!dialog.open) dialog.showModal();
}

function detailsButton(label, onclick) {
  return el("button", { type: "button", class: "link-button", onclick }, label);
}

function notAvailable(error) {
  if (error.status === 404) {
    const sampleFile = new URL(error.url || CONFIG.dataBase, location.href).pathname.includes("/sample_data/");
    return sampleFile
      ? "This part of the data is not included in the local sample."
      : "A file needed for this query is missing from the published dataset. Please try again later.";
  }
  return `Could not load the data: ${error.message}`;
}

// Hits ranked within 95% of the best one count as near-equal candidates.
function nearEqual(hits) {
  const h = col.hit;
  if (!hits.length) return [];
  return hits.slice(1).filter((x) => x[h.bitscore] >= 0.95 * hits[0][h.bitscore]);
}

// ---- The query gene ----------------------------------------------------------------------------

function panGeneMemberLabel(flag) {
  return { PASS: "Standard member", NSOrtho: "Added via orthology",
           array: "Additional array member", badOG: "Other membership" }[flag] || "Other membership";
}

function renderGene() {
  const { record, genome, typed, match } = state;
  const card = $("#gene");
  const status = { unplaced_protein: "Not on a reference chromosome",
                   no_usable_protein: "No protein available for comparison" }[record.st];
  const note = match === "exact_gene_id" ? null
    : el("p", { class: "note" }, `“${typed}” is ${match === "merged_id_component" ? "part of the merged ID" : "an alias of"} ${record.id}.`);
  // This is a display order, not a confidence ranking. Keep the stored memberships unchanged.
  const membershipOrder = { PASS: 0, NSOrtho: 1, array: 2, badOG: 3 };
  const memberships = [...record.pg].sort((a, b) =>
    (membershipOrder[a[1]] ?? 4) - (membershipOrder[b[1]] ?? 4) || Number(a[0]) - Number(b[0]));
  const entries = record.pg.length
    ? el("details", { class: "gene-groups" },
        el("summary", {}, `View ${memberships.length} group${memberships.length === 1 ? "" : "s"}`),
        el("p", { class: "group-context" }, `${genome} reference frame. A group can contain multiple copies; membership is not a direct pairwise match.`),
        el("div", { class: "group-buttons" }, memberships.map(([pg, flag]) => el("button", {
          type: "button", class: "entry-button", onclick: () => openEntry(genome, pg),
        }, el("strong", {}, `Group ${pg}`), el("span", {}, panGeneMemberLabel(flag)), el("span", { class: "group-action" }, "View members →")))))
    : el("span", { class: "muted" }, "No pan-gene group recorded");
  const location = record.chr
    ? `${fmt.loc(record.chr, record.s, record.e)} bp${record.str ? ` · ${record.str} strand` : ""}`
    : "Not available";
  card.replaceChildren(...[
    el("div", { class: "gene-title" },
      el("h2", {}, record.id), el("span", { class: "pill" }, genome),
      status ? el("span", { class: `pill status-${record.st}` }, status) : null),
    note,
    el("dl", { class: "facts" },
      el("dt", {}, "Genomic location"), el("dd", {}, location),
      el("dt", {}, "Representative protein"), el("dd", {}, record.len ? `${fmt.int(record.len)} aa` : "Not available"),
      el("dt", {}, "Pan-gene groups"), el("dd", {}, entries)),
  ].filter(Boolean));
  card.hidden = false;
}

function renderControls() {
  document.querySelectorAll("[data-top]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.top) === state.top)));
  document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === state.view)));
  const chips = $("#genome-chips");
  chips.replaceChildren(...state.manifest.target_genomes.map((g) => el("button", {
    type: "button", class: "chip", "aria-pressed": String(state.shown.has(g)),
    onclick: () => { state.shown.has(g) ? state.shown.delete(g) : state.shown.add(g); renderControls(); renderResults(); },
  }, g)));
  $("#controls").hidden = false;
}

// Genomes in display order: the query's own genome first, then the manifest order, filtered.
function shownGenomes() {
  const genomes = state.manifest.target_genomes;
  return [state.genome, ...genomes.filter((g) => g !== state.genome)].filter((g) => state.shown.has(g));
}

const targetOf = (genome) => state.record.t[state.manifest.target_genomes.indexOf(genome)];

// ---- Evidence details (dialog) ----------------------------------------------------------------

// Everything known about one query-target pair: the hit row (if any) and the relation row (if any).
function pairDetails(genome, targetId) {
  const h = col.hit, r = col.relation, target = targetOf(genome);
  const hit = target[col.target.hits].find((x) => x[h.target_id] === targetId)
           || (target[col.target.self_hit] && target[col.target.self_hit][h.target_id] === targetId ? target[col.target.self_hit] : null);
  const relation = target[col.target.relations].find((x) => x[r.target_id] === targetId);
  return { hit, relation };
}

function searchInfo(key) {
  const m = state.manifest;
  const row = m.searches.find((s) => s[0] === key);
  if (!row) return "unknown search";
  const s = Object.fromEntries(m.searches_columns.map((name, i) => [name, row[i]]));
  return `${s.query_genome} (${s.query_scope} proteins) against ${s.target_genome} (${s.target_scope}), at most ${s.max_hits} targets reported, `
       + `target database ${fmt.int(s.target_database_letters)} residues`;
}

function openPairDetails(genome, targetId) {
  const { hit, relation } = pairDetails(genome, targetId);
  const h = col.hit, r = col.relation, m = state.manifest;
  const row = (label, value) => el("div", { class: "detail-row" }, el("dt", {}, label), el("dd", {}, value));
  const chromosome = hit ? hit[h.chromosome] : relation[r.chromosome];
  const start = hit ? hit[h.start] : relation[r.start];
  const end = hit ? hit[h.end] : relation[r.end];
  const details = [
    row("Query", `${state.record.id} (${state.genome}, ${fmt.loc(state.record.chr, state.record.s, state.record.e)})`),
    row("Target", el("span", {}, geneLink(targetId, genome), ` (${genome}, ${fmt.loc(chromosome, start, end)}, `
      + `${fmt.int(hit ? hit[h.protein_length] : relation[r.protein_length])} aa)`)),
  ];
  if (hit) {
    details.push(
      row("Protein alignment", `${fmt.bits(hit[h.bitscore])} bits, E-value ${hit[h.evalue]}, identity ${fmt.pct(hit[h.identity_pct])}%, `
        + `alignment length ${fmt.int(hit[h.alignment_length])} aa`),
      row("Aligned region", `query ${fmt.int(hit[h.query_start])}–${fmt.int(hit[h.query_end])} (${fmt.pct(hit[h.query_coverage_pct])}% of the query protein); `
        + `target ${fmt.int(hit[h.target_start])}–${fmt.int(hit[h.target_end])} (${fmt.pct(hit[h.target_coverage_pct])}% of the target protein)`),
      row("Search", searchInfo(hit[h.search])),
    );
  } else {
    details.push(row("Protein alignment", "no hit stored for this pair (the searches keep at most 25 targets per query)"));
  }
  if (relation) {
    const blocks = relation[r.synteny_blocks];
    const rows = relation[r.orthology];
    details.push(
      row("Direct synteny", blocks.length
        ? el("ul", {}, blocks.map(([block, anchor]) => el("li", {}, `${block}${anchor ? " — anchor pair" : ""}`)))
        : "none (GENESPACE compared same-numbered chromosomes only)"),
      row("OrthoFinder", rows.length
        ? el("ul", {}, [...new Map(rows.map(([id, og]) => [og, id])).entries()].map(([og, id]) =>
            el("li", {}, `orthogroup ${og} (pairwise row ${id} of run ${m.run})`)))
        : "not on opposite sides of any pairwise orthologue row"),
      row("Shared pan-gene entries", relation[r.shared_pgids].length
        ? `${relation[r.shared_pgids].map((pg) => `entry ${pg}`).join(", ")} in the ${state.genome} frame of run ${m.run}`
        : "none in the query genome's frame"),
    );
  } else if (hit) {
    details.push(row("Direct relations", "none: not a syntenic or OrthoFinder partner"));
  }
  details.push(row("Provenance", `run ${m.run}; source database SHA-256 ${m.source_database_sha256.slice(0, 16)}…; cite orthogroups as run + name, pan-gene entries as run + frame + pgID`));
  openDialog(el("h2", {}, `${state.record.id} → ${targetId}`), el("dl", { class: "details" }, details));
}

// ---- Overview --------------------------------------------------------------------------------

function overviewRow(genome) {
  const h = col.hit, r = col.relation, target = targetOf(genome);
  const hits = target[col.target.hits];
  const relations = target[col.target.relations];
  const best = hits[0] || null;
  const status = target[col.target.status];
  const expanded = state.expanded.has(genome);
  const hints = [];
  if (best) {
    if (Math.min(best[h.query_coverage_pct], best[h.target_coverage_pct]) < 50) hints.push(["partial", "Best hit covers less than half of one protein"]);
    if (!isChromosome(best[h.chromosome])) hints.push(["unplaced", "Best hit is on a sequence not assembled into a chromosome"]);
    else if (best[h.chromosome] !== state.record.chr) hints.push(["other chromosome", `Best hit is on ${best[h.chromosome]}, not ${state.record.chr}`]);
    const near = nearEqual(hits);
    if (near.length) hints.push([`${near.length} near-equal`, `${near.length} other hit${near.length > 1 ? "s" : ""} within 95% of the best bit score`]);
    if (relations.length && !best[h.synteny] && !best[h.orthofinder]) hints.push(["best hit not related", "The best hit has no synteny or OrthoFinder link; a related gene ranks lower"]);
  }
  if (target[col.target.hit_cap_reached]) hints.push(["limit", "A search reported its maximum of 25 targets"]);
  const kinds = { both: 0, synteny: 0, orthofinder: 0 };
  for (const rel of relations) {
    if (rel[r.synteny] && rel[r.orthofinder]) kinds.both += 1;
    else if (rel[r.synteny]) kinds.synteny += 1;
    else kinds.orthofinder += 1;
  }
  const relationText = relations.length
    ? `${relations.length}` + (relations.length > 1 || !kinds.both
        ? ` (${[kinds.both && `${kinds.both} synteny+OrthoFinder`, kinds.synteny && `${kinds.synteny} synteny`, kinds.orthofinder && `${kinds.orthofinder} OrthoFinder`].filter(Boolean).join(", ")})`
        : " (synteny+OrthoFinder)")
    : "0";
  const main = el("tr", { class: `overview-row${expanded ? " expanded" : ""}${genome === state.genome ? " self-row" : ""}`,
                          onclick: (event) => { if (event.target.closest("a, button")) return; toggleExpanded(genome); } },
    el("td", { class: "genome-cell" },
      el("span", { class: "caret", "aria-hidden": "true" }, expanded ? "▾" : "▸"), " ", genome,
      genome === state.genome ? el("span", { class: "pill" }, "own") : null),
    best
      ? el("td", {}, geneLink(best[h.target_id], genome), el("div", { class: "small muted" }, `${best[h.chromosome]}:${fmt.mb(best[h.start])} · ${fmt.pct(best[h.identity_pct])}% identity · ${fmt.bits(best[h.bitscore])} bits`))
      : el("td", { class: "muted" }, state.manifest.target_statuses[status] || status),
    best ? el("td", { class: "num cov-pair" }, `${fmt.pct(best[h.query_coverage_pct])} / ${fmt.pct(best[h.target_coverage_pct])}`) : el("td", {}, "–"),
    el("td", { class: "num" }, relationText),
    el("td", { class: "hints" }, hints.map(([text, title]) => el("span", { class: `badge hint hint-${text.split(" ")[0]}`, title }, text)),
      best ? detailsButton("details", (e) => { e.stopPropagation(); openPairDetails(genome, best[h.target_id]); }) : null));
  const detail = expanded ? el("tr", { class: "overview-detail" }, el("td", { colspan: 5 },
    el("h4", {}, `Hits in ${genome}`), hitsTable(genome),
    el("h4", {}, `Related genes in ${genome}`), relatedTable(genome))) : null;
  return [main, detail];
}

function toggleExpanded(genome) {
  state.expanded.has(genome) ? state.expanded.delete(genome) : state.expanded.add(genome);
  renderResults();
}

function renderOverview() {
  const genomes = shownGenomes();
  return el("article", { class: "target" }, el("div", { class: "table-wrap" }, el("table", { class: "overview" },
    el("thead", {}, el("tr", {}, ["Annotation", "Best sequence hit", "Query / target cov %", "Direct relations", "Notes"].map((t) => el("th", {}, t)))),
    el("tbody", {}, genomes.flatMap(overviewRow)))),
    el("p", { class: "muted small" }, "Click a row to show every hit and every related gene in that annotation. "
      + "“Direct relations” counts syntenic and OrthoFinder partners, whatever their hit rank."));
}

// ---- Hits and related genes ----------------------------------------------------------------------

function targetHeader(genome) {
  const target = targetOf(genome);
  const [status, reported, cap] = [target[col.target.status], target[col.target.reported_other_targets], target[col.target.hit_cap_reached]];
  const statusText = state.manifest.target_statuses[status] || status;
  return el("header", { class: "target-header" },
    el("h3", {}, genome, genome === state.genome ? el("span", { class: "pill" }, "own genome") : null),
    el("span", { class: "muted" },
      status === "hits" ? `${reported} candidate${reported === 1 ? "" : "s"}` : statusText,
      cap ? el("span", { class: "badge cap", title: "At least one search hit its report limit; more similar genes may exist" }, "limit reached") : null));
}

function hitsTable(genome) {
  const h = col.hit, target = targetOf(genome);
  const rows = [];
  const self = target[col.target.self_hit];
  const hits = target[col.target.hits].slice(0, state.top);
  const row = (hit, rank, cls) => el("tr", { class: cls },
    el("td", { class: "num" }, rank),
    el("td", {}, geneLink(hit[h.target_id], genome)),
    el("td", { class: "loc" }, fmt.loc(hit[h.chromosome], hit[h.start], hit[h.end])),
    el("td", { class: "num" }, fmt.bits(hit[h.bitscore])),
    el("td", { class: "num" }, hit[h.evalue]),
    el("td", { class: "num" }, fmt.pct(hit[h.identity_pct])),
    el("td", { class: "num" }, fmt.int(hit[h.alignment_length])),
    coverageCell(hit[h.query_coverage_pct]),
    coverageCell(hit[h.target_coverage_pct]),
    el("td", { class: "evidence" }, badges({ synteny: hit[h.synteny], orthofinder: hit[h.orthofinder],
      sharedEntry: hit[h.shared_pan_gene], qcov: hit[h.query_coverage_pct], tcov: hit[h.target_coverage_pct] })),
    el("td", {}, detailsButton("details", () => openPairDetails(genome, hit[h.target_id]))));
  if (self) rows.push(row(self, "self", "self-row"));
  hits.forEach((hit, index) => rows.push(row(hit, index + 1)));
  if (!rows.length) return el("p", { class: "muted empty" }, "No hits to show.");
  return el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, ["#", "Gene", "Location", "Bits", "E-value", "Identity %", "Aln len", "Query cov %", "Target cov %", "Evidence", ""]
      .map((t) => el("th", {}, t)))),
    el("tbody", {}, rows)));
}

function relatedTable(genome) {
  const r = col.relation, target = targetOf(genome);
  const relations = target[col.target.relations];
  if (!relations.length) return el("p", { class: "muted empty" }, "No syntenic or OrthoFinder partner in this genome.");
  const rows = relations.map((rel) => {
    const rank = rel[r.hit_rank];
    const outside = rank === null || rank > state.top;
    const blocks = rel[r.synteny_blocks].map(([block, anchor]) => `${block}${anchor ? " (anchor)" : ""}`).join("; ");
    const groups = [...new Set(rel[r.orthology].map(([, og]) => og))].join("; ");
    return el("tr", { class: outside ? "outside-row" : null },
      el("td", { class: "num" }, rank === null ? el("span", { class: "badge nohit" }, "no hit")
        : rank > state.top ? el("span", { class: "badge beyond", title: `Ranked after the top ${state.top}` }, rank) : rank),
      el("td", {}, geneLink(rel[r.target_id], genome)),
      el("td", { class: "loc" }, fmt.loc(rel[r.chromosome], rel[r.start], rel[r.end])),
      el("td", { class: "evidence" }, badges({ synteny: rel[r.synteny], orthofinder: rel[r.orthofinder],
        sharedEntry: rel[r.shared_pgids].length, qcov: rel[r.query_coverage_pct], tcov: rel[r.target_coverage_pct] })),
      el("td", { class: "small" }, blocks || "–"),
      el("td", { class: "small" }, groups || "–"),
      el("td", { class: "small" }, rel[r.shared_pgids].join("; ") || "–"),
      el("td", { class: "num" }, fmt.bits(rel[r.bitscore])),
      el("td", { class: "num" }, rel[r.evalue] === null ? "–" : rel[r.evalue]),
      el("td", { class: "num" }, fmt.pct(rel[r.identity_pct])),
      el("td", { class: "num" }, fmt.int(rel[r.alignment_length])),
      coverageCell(rel[r.query_coverage_pct]),
      coverageCell(rel[r.target_coverage_pct]),
      el("td", {}, detailsButton("details", () => openPairDetails(genome, rel[r.target_id]))));
  });
  return el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, ["Rank", "Gene", "Location", "Evidence", "Synteny blocks", "Orthogroups", "Shared pgIDs",
      "Bits", "E-value", "Identity %", "Aln len", "Query cov %", "Target cov %", ""].map((t) => el("th", {}, t)))),
    el("tbody", {}, rows)));
}

function renderPerGenome(table) {
  const genomes = shownGenomes();
  if (!genomes.length) return el("p", { class: "muted" }, "No genome selected.");
  return genomes.map((genome) => el("article", { class: "target" }, targetHeader(genome), table(genome)));
}

// ---- Homeologs ---------------------------------------------------------------------------------------

// What a homeolog-table cell says about its evidence, in words.
function cellEvidence(cell) {
  const c = col.cell, role = cell[c.role], stateName = cell[c.state], evidence = cell[c.evidence];
  if (stateName === "self") return "the query";
  if (role === "ortholog") {
    return { "synteny+orthofinder": "synteny + OrthoFinder", synteny: "synteny only", orthofinder: "OrthoFinder only",
             sequence: "sequence only (≥ 97% identity)" }[evidence] || evidence;
  }
  return { confirmed: "two routes agree", sequence_only: "sequence only", ambiguous: "sequence only, near-equal candidates",
           via_own_homeolog: "via own homeolog" }[stateName] || stateName;
}

function openCellDetails(genome, sg, cell) {
  const c = col.cell, hm = state.homeologManifest;
  const row = (label, value) => el("div", { class: "detail-row" }, el("dt", {}, label), el("dd", {}, value));
  const flags = cell[c.flags];
  const details = [];
  if (cell[c.gene_id] !== null) {
    details.push(
      row("Gene", el("span", {}, geneLink(cell[c.gene_id], genome), ` (${genome} ${sg}, ${cell[c.chromosome]}:${fmt.mb(cell[c.start])})`)),
      row("Role", cell[c.role] === "ortholog" ? "ortholog (same subgenome as the query)" : cell[c.role] === "self" ? "the query itself" : "predicted homeolog"),
      row("Evidence", cellEvidence(cell)),
      cell[c.identity_pct] === null ? row("Protein match", "no stored protein hit to the query")
        : row("Protein match", `${fmt.pct(cell[c.identity_pct])}% identity, coverage ${fmt.pct(cell[c.query_coverage_pct])}% of the query / `
          + `${fmt.pct(cell[c.target_coverage_pct])}% of this gene, ${fmt.bits(cell[c.bitscore])} bits, rank ${cell[c.hit_rank]} among all stored candidates in ${genome}`),
    );
  } else {
    details.push(row("Result", `not found under the current rules (${sg} copy in ${genome})`));
  }
  if (cell[c.reason]) details.push(row("Why", cell[c.reason]));
  if (cell[c.n_alternatives]) {
    const title = cell[c.gene_id] === null ? "Copy on an unplaced sequence" : cell[c.role] === "ortholog" ? "Other partners" : "Near-equal candidates";
    details.push(row(`${title} (${cell[c.n_alternatives]})`, el("ul", {}, cell[c.alternatives].map(([id, bits]) =>
      el("li", {}, geneLink(id, genome), bits === null ? " (no stored hit)" : ` (${fmt.bits(bits)} bits)`)),
      cell[c.n_alternatives] > cell[c.alternatives].length ? el("li", { class: "muted" }, `… and ${cell[c.n_alternatives] - cell[c.alternatives].length} more`) : null)));
  }
  if (flags.length) details.push(row("Flags", el("ul", {}, flags.map((f) => el("li", {}, el("code", {}, f), ": ", hm.flags[f] || "")))));
  details.push(row("See also", el("span", {},
    detailsButton(`all hits and related genes in ${genome}`, () => { $("#dialog").close(); showGenomeDetails(genome); }),
    " — including hits on other chromosomes and unplaced sequences.")));
  openDialog(el("h2", {}, `${state.record.id}: ${sg} copy in ${genome}`), el("dl", { class: "details" }, details));
}

// Open the overview with one genome expanded (the way to see cross-chromosome hits from a homeolog cell).
function showGenomeDetails(genome) {
  state.view = "overview";
  state.shown.add(genome);
  state.expanded.add(genome);
  renderControls();
  renderResults();
  document.querySelector(".overview-row.expanded")?.scrollIntoView({ block: "start", behavior: "smooth" });
}

// alreadyNamed: an unplaced copy named in another cell of the same row; an empty homeolog cell then
// leaves it to that cell (the copy's subgenome is unknown, so every empty cell of the row names it).
function homeologCell(cell, genome, sg, alreadyNamed = null) {
  const c = col.cell;
  const flags = cell[c.flags];
  const open = () => openCellDetails(genome, sg, cell);
  if (cell[c.gene_id] === null) {
    const unplaced = flags.includes("best_hit_unplaced") ? cell[c.alternatives][0] : null;
    const showUnplaced = unplaced && unplaced[0] !== alreadyNamed;
    return el("td", { class: "hcell missing" },
      el("div", {}, el("span", { class: "muted" }, "not found under current rules")),
      el("div", { class: "hmeta" },
        showUnplaced ? el("span", {}, "copy on unplaced sequence: ", geneLink(unplaced[0], genome), " ") : null,
        unplaced && !showUnplaced ? el("span", { class: "muted" }, "same unplaced copy ") : null,
        flags.includes("hit_cap_reached") ? el("span", { class: "badge cap", title: "A search hit its report limit" }, "limit ") : null,
        detailsButton("why?", open)));
  }
  const check = flags.includes("candidates_conflict") || flags.includes("near_identical_unconfirmed") || flags.includes("second_route_disagrees");
  return el("td", { class: `hcell ${cell[c.role]}` },
    el("div", {}, geneLink(cell[c.gene_id], genome),
      el("span", { class: "muted small" }, ` ${cell[c.chromosome]}:${fmt.mb(cell[c.start])}`)),
    el("div", { class: "hmeta" },
      cell[c.state] === "self" ? null
        : cell[c.identity_pct] === null ? el("span", { class: "muted" }, "no stored hit · ")
        : el("span", {}, `${fmt.pct(cell[c.identity_pct])}% · cov ${fmt.pct(cell[c.query_coverage_pct])}/${fmt.pct(cell[c.target_coverage_pct])} · `),
      el("span", { class: `badge state-${cell[c.state]}` }, cellEvidence(cell)),
      check ? el("span", { class: "badge partial", title: cell[c.reason] || "Check this pick" }, " check") : null,
      cell[c.n_alternatives] ? el("button", { type: "button", class: "link-button", onclick: open },
        `+${cell[c.n_alternatives]} candidate${cell[c.n_alternatives] > 1 ? "s" : ""}`) : null,
      detailsButton("details", open)));
}

async function renderHomeologs(container) {
  const record = state.record;
  container.replaceChildren(el("p", { class: "muted" }, "Loading predicted homeologs…"));
  let homeologs;
  try {
    homeologs = await homeologRecord(state.genome, record.k);
  } catch (error) {
    if (state.view !== "homeologs" || state.record !== record) return;
    container.replaceChildren(el("p", { class: "message error" }, notAvailable(error)));
    return;
  }
  if (state.view !== "homeologs" || state.record !== record) return;   // the user moved on meanwhile
  const hm = state.homeologManifest, c = col.cell;
  if (!homeologs.t) {
    container.replaceChildren(el("p", { class: "muted" }, `No homeolog prediction for ${homeologs.id}: ${homeologs.note}.`));
    return;
  }
  const slots = hm.homeolog_groups[homeologs.group];
  const genomes = hm.target_genomes;
  const callNote = { fixed: "", window: " (group set by its neighbourhood on this composite chromosome)",
                     boundary: " (near a group boundary on this composite chromosome; less certain)" }[homeologs.group_call];
  container.replaceChildren(...[
    homeologs.genomes_with_ortholog === 0
      ? el("p", { class: "message" }, "No corresponding gene was identified in another genome under the current rules, so most cells are expected to be empty.") : null,
    el("p", { class: "homeolog-summary" },
      `${homeologs.id} is on ${homeologs.chr}, subgenome ${homeologs.sg}, homeolog group ${homeologs.group}: `,
      hm.subgenomes.map((sg) => `${sg} ${slots[sg].join("/")}`).join(" · "), callNote),
    el("article", { class: "target" }, el("div", { class: "table-wrap" }, el("table", { class: "homeolog-table" },
      el("thead", {}, el("tr", {}, el("th", {}, "Genome"),
        hm.subgenomes.map((sg) => el("th", { class: sg === homeologs.sg ? "own-sg" : null },
          `${sg} · ${slots[sg].join("/")}`, el("br"),
          el("small", {}, sg === homeologs.sg ? "same subgenome: ortholog" : "predicted homeolog"))))),
      el("tbody", {}, shownGenomes().filter((g) => genomes.includes(g)).map((genome) => {
        const cells = homeologs.t[genomes.indexOf(genome)];
        // The ortholog cell (the query's own subgenome) names an unplaced copy first; the homeolog
        // cells of the row only say "same unplaced copy" for the same gene.
        const own = cells[hm.subgenomes.indexOf(homeologs.sg)];
        const ownUnplaced = own[c.gene_id] === null && own[c.flags].includes("best_hit_unplaced") ? own[c.alternatives][0][0] : null;
        return el("tr", { class: genome === state.genome ? "self-row" : null },
          el("th", { scope: "row" }, genome),
          cells.map((cell, i) => homeologCell(cell, genome, hm.subgenomes[i], hm.subgenomes[i] === homeologs.sg ? null : ownUnplaced)));
      }))))),
    el("p", { class: "muted small" }, `Each cell: gene · identity · coverage of the query / of that gene · evidence · near-equal candidates. `
      + `Subgenome names: ${hm.subgenome_naming}. ${hm.caveats[0]}`),
  ].filter(Boolean));
  state.homeologs = homeologs;
}

// ---- Results, views -------------------------------------------------------------------------------

function renderResults() {
  const results = $("#results");
  if (!state.record) { results.hidden = true; $("#legend").hidden = true; return; }
  results.hidden = false;
  $("#legend").hidden = false;
  if (state.view === "overview") results.replaceChildren(renderOverview());
  else if (state.view === "hits") results.replaceChildren(...[renderPerGenome(hitsTable)].flat());
  else if (state.view === "related") results.replaceChildren(...[renderPerGenome(relatedTable)].flat());
  else renderHomeologs(results);
}

async function openEntry(frame, pg) {
  openDialog(el("p", {}, "Loading…"));
  const record = state.record;
  try {
    const members = await entryMembers(frame, pg);
    if (state.record !== record) return;
    const m = Object.fromEntries(state.manifest.pangene_member_columns.map((name, i) => [name, i]));
    const isQuery = (row) => row[m.genome] === state.genome && row[m.gene_id] === record.id;
    const orderedMembers = [...members].sort((a, b) => Number(isQuery(b)) - Number(isQuery(a)));
    const annotations = new Set(members.map((row) => row[m.genome])).size;
    openDialog(
      el("h2", {}, `Pan-gene group ${pg}`),
      el("p", { class: "group-summary" }, `${members.length} members across ${annotations} annotation${annotations === 1 ? "" : "s"} · ${frame} reference frame`),
      el("p", { class: "muted small" }, "Standard member is a GENESPACE membership category, not a confidence score. Added via orthology means linked to the group's representative by OrthoFinder; it does not imply a direct match to every member."),
      el("div", { class: "table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Annotation", "Gene", "Chromosome", "Membership"].map((t) => el("th", {}, t)))),
        el("tbody", {}, orderedMembers.map((row) => el("tr", { class: isQuery(row) ? "query-member" : null },
          el("td", {}, row[m.genome]),
          el("td", {}, geneLink(row[m.gene_id], row[m.genome]), isQuery(row) ? el("span", { class: "pill query-label" }, "Your query") : null),
          el("td", {}, row[m.chromosome]),
          el("td", {}, panGeneMemberLabel(row[m.flag]))))))),
      el("details", { class: "group-technical" },
        el("summary", {}, "Technical details"),
        el("p", { class: "muted small" }, `Run ${state.manifest.run} · frame ${frame} · pgID ${pg}. Cite this combination; group numbers differ between frames. Interpolated positions use gene order, not base pairs.`),
        el("div", { class: "table-wrap" }, el("table", {},
          el("thead", {}, el("tr", {}, ["Annotation", "Gene", "Original flag", "Interpolated chromosome", "Gene-order position"].map((t) => el("th", {}, t)))),
          el("tbody", {}, orderedMembers.map((row) => el("tr", { class: isQuery(row) ? "query-member" : null },
            el("td", {}, row[m.genome]), el("td", {}, row[m.gene_id]), el("td", {}, row[m.flag]),
            el("td", {}, row[m.interp_chr] ?? "Not assigned"),
            el("td", {}, row[m.interp_ord] === null ? "Not assigned" : fmt.int(row[m.interp_ord])))))))));
  } catch (error) {
    openDialog(el("p", { class: "message error" }, notAvailable(error)));
  }
}

// ---- Download of the current result ---------------------------------------------------------------

function tsvEscape(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[\t\n\r]/g, " ");
}

function currentResultTsv() {
  const h = col.hit, r = col.relation, genomes = shownGenomes();
  const lines = [];
  if (state.view === "homeologs" && state.homeologs?.t) {
    const c = col.cell, hm = state.homeologManifest;
    lines.push(["query_genome", "query_id", "target_genome", "subgenome", "role", "gene_id", "chromosome", "start", "end", "evidence", "state",
                "identity_pct", "query_coverage_pct", "target_coverage_pct", "bitscore", "hit_rank", "n_alternatives", "alternatives", "flags", "reason"]);
    for (const genome of genomes.filter((g) => hm.target_genomes.includes(g))) {
      const cells = state.homeologs.t[hm.target_genomes.indexOf(genome)];
      cells.forEach((cell, i) => lines.push([state.genome, state.record.id, genome, hm.subgenomes[i], cell[c.role], cell[c.gene_id], cell[c.chromosome],
        cell[c.start], cell[c.end], cell[c.evidence], cell[c.state], cell[c.identity_pct], cell[c.query_coverage_pct], cell[c.target_coverage_pct],
        cell[c.bitscore], cell[c.hit_rank], cell[c.n_alternatives], cell[c.alternatives].map(([id, bits]) => `${id}:${bits ?? ""}`).join(";"),
        cell[c.flags].join(";"), cell[c.reason]]));
    }
  } else {
    lines.push(["query_genome", "query_id", "target_genome", "kind", "rank", "target_id", "chromosome", "start", "end", "protein_length",
                "bitscore", "evalue", "identity_pct", "alignment_length", "query_coverage_pct", "target_coverage_pct",
                "synteny", "orthofinder", "shared_pan_gene", "synteny_blocks", "orthogroups", "shared_pgids"]);
    for (const genome of genomes) {
      const target = targetOf(genome);
      const hitRow = (hit, rank) => [state.genome, state.record.id, genome, "hit", rank, hit[h.target_id], hit[h.chromosome], hit[h.start], hit[h.end],
        hit[h.protein_length], hit[h.bitscore], hit[h.evalue], hit[h.identity_pct], hit[h.alignment_length], hit[h.query_coverage_pct],
        hit[h.target_coverage_pct], hit[h.synteny], hit[h.orthofinder], hit[h.shared_pan_gene], "", "", ""];
      if (state.view !== "related") {
        if (target[col.target.self_hit]) lines.push(hitRow(target[col.target.self_hit], "self"));
        target[col.target.hits].slice(0, state.view === "overview" ? 1 : state.top).forEach((hit, i) => lines.push(hitRow(hit, i + 1)));
      }
      if (state.view !== "hits") {
        for (const rel of target[col.target.relations]) {
          lines.push([state.genome, state.record.id, genome, "relation", rel[r.hit_rank], rel[r.target_id], rel[r.chromosome], rel[r.start], rel[r.end],
            rel[r.protein_length], rel[r.bitscore], rel[r.evalue], rel[r.identity_pct], rel[r.alignment_length], rel[r.query_coverage_pct],
            rel[r.target_coverage_pct], rel[r.synteny], rel[r.orthofinder], rel[r.shared_pgids].length ? 1 : 0,
            rel[r.synteny_blocks].map(([b, a]) => `${b}${a ? "(anchor)" : ""}`).join(";"),
            [...new Set(rel[r.orthology].map(([, og]) => og))].join(";"), rel[r.shared_pgids].join(";")]);
        }
      }
    }
  }
  return lines.map((row) => row.map(tsvEscape).join("\t")).join("\n") + "\n";
}

function downloadCurrent() {
  if (!state.record) return;
  const blob = new Blob([currentResultTsv()], { type: "text/tab-separated-values" });
  const link = el("a", { href: URL.createObjectURL(blob), download: `${state.record.id.replace(/[^\w.-]+/g, "_")}_${state.view}.tsv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function renderDownloads() {
  const list = $("#download-list");
  const base = CONFIG.downloadBase;
  // A folder cannot be downloaded as one URL: link it to the Hub's file browser (browseBase) instead.
  list.replaceChildren(...(CONFIG.downloads || []).map((d) => el("li", {},
    base ? el("a", { href: (d.folder && CONFIG.browseBase ? CONFIG.browseBase : base) + d.path }, d.path) : el("code", {}, d.path), " — ", d.label,
    d.folder && base ? el("span", { class: "muted" }, " (a folder: open it to pick a file)") : null)));
  if (!base) list.append(el("li", { class: "muted" }, "Links are enabled once the data set is published; until then these files are on the cluster under results/."));
  $("#downloads").hidden = false;
}

// Keep the footer concise; method limitations and provenance are available on request.
function openDataMethods(homeologNote) {
  const m = state.manifest;
  const hm = state.homeologManifest;
  const row = (label, value) => el("div", { class: "detail-row" },
    el("dt", {}, label), el("dd", {}, value));
  openDialog(
    el("h2", {}, "Data and methods"),
    el("ul", { class: "method-notes" }, [
      "Protein comparisons use one representative protein sequence per gene.",
      `Protein hits are ranked by bit score. Each search reports up to ${m.search_max_hits} targets; supplementary searches may add further candidates.`,
      "Related genes includes all stored syntenic and OrthoFinder partners, including those outside the displayed top hits.",
      "Direct synteny was evaluated between same-numbered chromosomes. Shared pan-gene membership does not imply direct synteny between every pair of members.",
      "Consider sequence identity and coverage together. A short, high-identity match requires review of the gene models.",
      "Homeolog assignments are computational predictions. Multiple candidates may be supported. A missing match does not establish biological absence.",
    ].map((note) => el("li", {}, note))),
    el("details", { class: "group-technical data-provenance" },
      el("summary", {}, "Technical provenance"),
      el("dl", { class: "details" },
        row("Analysis ID", m.run),
        row("Protein-hit data exported", m.created_utc.slice(0, 10)),
        row("Homeolog data exported", hm ? hm.created_utc.slice(0, 10) : homeologNote),
        row("Source database SHA-256", el("code", {}, m.source_database_sha256)),
        row("Evidence identifiers", "Orthogroups are identified by the analysis ID and group name. Pan-gene groups also require the reference annotation and group number."))),
  );
}

function renderFooter(homeologNote) {
  const datasetUrl = CONFIG.browseBase || CONFIG.downloadBase;
  $("#footer").replaceChildren(...[
    el("p", {}, `Data from ${state.manifest.target_genomes.length} Camelina sativa annotations.`),
    el("div", { class: "footer-links" },
      datasetUrl ? el("a", { href: datasetUrl }, "View dataset") : null,
      detailsButton("Data and methods", () => openDataMethods(homeologNote))),
    state.homeologManifest ? null
      : el("p", { class: "muted" }, "Homeolog predictions are currently unavailable."),
  ].filter(Boolean));
}

// ---- Lookup flow -----------------------------------------------------------------------------

// Hide the previous gene, so a failed lookup is never read as showing the result of the new one.
function clearResult() {
  state.record = null;
  state.homeologs = null;
  state.expanded = new Set();
  for (const id of ["#gene", "#controls", "#results", "#legend"]) $(id).hidden = true;
  document.title = "Camelina Pan-gene Lookup";
}

async function lookup(id, genome) {
  id = id.trim();
  if (!id || !state.manifest) return;
  const seq = ++state.lookupSeq;             // results of older lookups are dropped below
  $("#gene-input").value = id;
  $("#genome-select").value = genome || "";
  clearResult();
  message("Looking up…");
  try {
    const matches = await resolve(id, genome);
    if (seq !== state.lookupSeq) return;
    if (!matches.length) {
      message(genome ? `No gene “${id}” in ${genome}.` : `No gene “${id}”. IDs are case-sensitive.`, "error");
      return;
    }
    if (matches.length > 1) {
      message([`“${id}” exists in several genomes; choose one: `,
        ...matches.map(([g, geneId]) => el("a", { href: `#q=${encodeURIComponent(id)}&g=${encodeURIComponent(g)}`, class: "choice" }, `${geneId} (${g})`))]);
      return;
    }
    const [g, , key, match] = matches[0];
    const record = await geneRecord(g, key);
    if (seq !== state.lookupSeq) return;
    Object.assign(state, { record, genome: g, typed: id, match });
    if (!state.shown) state.shown = new Set(state.manifest.target_genomes);
    message(null);
    renderGene();
    renderControls();
    renderResults();
    document.title = `${record.id} · Camelina Pan-gene Lookup`;
  } catch (error) {
    if (seq !== state.lookupSeq) return;
    message(notAvailable(error), "error");
  }
}

// The URL hash holds the lookup, so a result can be bookmarked or shared: #q=ID&g=GENOME
function fromHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get("q")) lookup(params.get("q"), params.get("g") || "");
}

function go(id, genome) {
  const hash = `#q=${encodeURIComponent(id)}${genome ? `&g=${encodeURIComponent(genome)}` : ""}`;
  if (location.hash === hash) lookup(id, genome); else location.hash = hash;
}

function setView(view) {
  if (view === "homeologs" && !state.homeologManifest) return;
  state.view = view;
  if (state.record) { renderControls(); renderResults(); }
}

async function start() {
  try {
    state.manifest = await load("manifest.json");
  } catch (error) {
    message(`Could not load the data description (manifest.json): ${error.message}`, "error");
    return;
  }
  const m = state.manifest;
  col.hit = Object.fromEntries(m.hit_columns.map((name, i) => [name, i]));
  col.relation = Object.fromEntries(m.relation_columns.map((name, i) => [name, i]));
  col.target = Object.fromEntries(m.target_columns.map((name, i) => [name, i]));
  // The homeolog files are optional: the page works without them, with the Homeologs view disabled.
  let homeologNote = "no predicted homeologs available";
  try {
    const hm = await load("manifest.json", CONFIG.homeologBase);
    // Both exports address records by the same global gene keys. A mismatched manifest must never
    // be used to look up a record, even if the file and array index happen to exist in both exports.
    const sameGenomes = JSON.stringify(hm.target_genomes) === JSON.stringify(m.target_genomes);
    const sameKeys = sameGenomes && m.target_genomes.every((g) =>
      JSON.stringify(hm.gene_key_ranges[g]) === JSON.stringify(m.gene_key_ranges[g]));
    if (hm.source_database_sha256 !== m.source_database_sha256 || hm.run !== m.run ||
        hm.schema !== m.schema || hm.genes_per_file !== m.genes_per_file || !sameKeys) {
      throw new Error("the source database or gene layout differs from the hits");
    }
    state.homeologManifest = hm;
    col.cell = Object.fromEntries(hm.cell_columns.map((name, i) => [name, i]));
    homeologNote = `homeologs built ${hm.created_utc.slice(0, 10)} from the same database`;
  } catch (error) {
    state.homeologManifest = null;
    $("[data-view=homeologs]").disabled = true;
    homeologNote = `Homeologs disabled: ${error.message}`;
  }

  $("#genome-select").append(...m.target_genomes.map((g) => el("option", { value: g }, g)));
  $("#examples").replaceChildren(...CONFIG.examples.map(([id, g]) =>
    el("a", { href: `#q=${encodeURIComponent(id)}&g=${encodeURIComponent(g)}`, class: "example" }, `${g}: ${id}`)));
  renderFooter(homeologNote);
  renderDownloads();

  $("#search").addEventListener("submit", (event) => {
    event.preventDefault();
    go($("#gene-input").value, $("#genome-select").value);
  });
  document.querySelectorAll("[data-top]").forEach((b) => b.addEventListener("click", () => {
    state.top = Number(b.dataset.top);
    if (state.record) { renderControls(); renderResults(); }
  }));
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  document.querySelectorAll("[data-genomes]").forEach((b) => b.addEventListener("click", () => {
    if (!state.record) return;
    state.shown = new Set(b.dataset.genomes === "all" ? m.target_genomes : []);
    renderControls(); renderResults();
  }));
  $("#download").addEventListener("click", downloadCurrent);
  $("#dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
  window.addEventListener("hashchange", fromHash);

  for (const field of document.querySelectorAll("#search input, #search select, #search button")) field.disabled = false;
  $("#gene-input").placeholder = "Gene, transcript or protein ID, e.g. CsPrytzh.01G000100";
  fromHash();
}

start();
