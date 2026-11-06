// Camelina sativa Pan-Gene Database: a static page over the step-06 files (CONFIG.dataBase) and the step-07
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
  view: "homeologs", evidence: "hits", top: 10, shown: null, expanded: new Set(),
  lookupSeq: 0,
  alignment: null,                         // per-query gene selection; independent of annotation chips
  alignmentSubgenome: null, alignmentRenderSeq: 0,
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

function evidenceField(row, columns, name, fallback = 0) {
  // Older exports do not have the optional cross-chromosome columns.
  return row && columns[name] !== undefined ? row[columns[name]] ?? fallback : fallback;
}

function syntenyRun(kind = 'synteny') {
  return state.manifest.synteny_runs?.[kind]
    || (kind === 'synteny' ? state.manifest.run : null);
}

function blockLabel([block, anchor], run) {
  const source = run ? `${run}: ` : '';
  const name = block || 'syntenic region (no block assigned)';
  return `${source}${name}${anchor ? ' (anchor)' : ''}`;
}

function blocksText(blocks, kind = 'synteny') {
  return (blocks || []).map((block) => blockLabel(block, syntenyRun(kind))).join('; ');
}

function evidenceText(value) {
  const labels = {
    synteny: 'synteny', cross_synteny: 'cross-chromosome synteny', orthofinder: 'OrthoFinder',
    sequence: 'protein sequence', own_homeolog_ortholog: 'found via homeolog', self: 'the query',
  };
  return String(value || '').split('+').map((kind) => labels[kind] || kind)
    .filter(Boolean).join(' + ');
}

function isToVerify(cell) {
  return cell && (cell[col.cell.state] === 'to_verify' || cell[col.cell.role] === 'candidate');
}

function badges({ synteny, crossSynteny = 0, orthofinder, sharedEntry, qcov, tcov }) {
  const list = [];
  if (synteny === 2) {
    list.push(el('span', { class: 'badge anchor', title: 'Direct syntenic anchor pair' }, 'anchor'));
  } else if (synteny === 1) {
    list.push(el('span', { class: 'badge syn', title: 'Direct syntenic pair' }, 'synteny'));
  }
  if (crossSynteny) {
    const source = syntenyRun('cross_synteny') || 'the all-chromosome run';
    const kind = crossSynteny === 2 ? 'anchor pair' : 'syntenic pair';
    list.push(el('span', {
      class: 'badge cross-syn',
      title: `Cross-chromosome ${kind} from ${source}. `
        + 'This does not by itself establish orthology or a translocation.',
    }, crossSynteny === 2 ? 'cross-chr anchor' : 'cross-chr synteny'));
  }
  if (orthofinder) {
    list.push(el('span', { class: 'badge of', title: 'Listed as orthologs by OrthoFinder' }, 'OrthoFinder'));
  }
  if (sharedEntry) {
    list.push(el('span', {
      class: 'badge pg', title: 'Same pan-gene entry (query annotation as reference)',
    }, 'same entry'));
  }
  if (qcov !== null && qcov !== undefined && Math.min(qcov, tcov) < 50) {
    list.push(el('span', {
      class: 'badge partial', title: 'Local match: one coverage below 50%. Check the annotation structure.',
    }, 'partial'));
  }
  return list;
}

function openDialog(...content) {
  window.ProteinAlignmentView?.cancel(true);
  hideEvidenceTooltip();
  $("#dialog-body").replaceChildren(...content.flat().filter(Boolean));
  const dialog = $("#dialog");
  if (!dialog.open) dialog.showModal();
}

function detailsButton(label, onclick) {
  return el("button", { type: "button", class: "link-button", onclick }, label);
}

function showEvidenceTooltip(button, text) {
  let tooltip = $("#evidence-tooltip");
  if (!tooltip) {
    tooltip = el("div", { id: "evidence-tooltip", class: "evidence-tooltip", role: "tooltip" });
    document.body.append(tooltip);
  }
  tooltip.textContent = text;
  tooltip.hidden = false;
  const box = button.getBoundingClientRect();
  const left = Math.max(8, Math.min(box.left, innerWidth - tooltip.offsetWidth - 8));
  const below = box.bottom + 8;
  const top = below + tooltip.offsetHeight <= innerHeight - 8 ? below : box.top - tooltip.offsetHeight - 8;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

function hideEvidenceTooltip() {
  const tooltip = $("#evidence-tooltip");
  if (tooltip) tooltip.hidden = true;
}

function notAvailable(error) {
  if (error.status === 404) {
    const sampleFile = Boolean(CONFIG.localPreview) || new URL(error.url || CONFIG.dataBase, location.href).pathname.includes("/sample_data/");
    return sampleFile
      ? "This query is not included in the selected real queries available in this local preview. Try one of the examples."
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
  const proteinNote = record.st === "no_usable_protein"
    ? "This gene has no usable representative protein for comparison."
    : "Results use this gene's representative protein.";
  const note = match === "exact_gene_id" ? null
    : el("p", { class: "note" }, match === "merged_id_component"
      ? `“${typed}” is part of the merged gene ID ${record.id}. ${proteinNote}`
      : `“${typed}” maps to gene ${record.id}. ${proteinNote}`);
  // This is a display order, not a confidence ranking. Keep the stored memberships unchanged.
  const membershipOrder = { PASS: 0, NSOrtho: 1, array: 2, badOG: 3 };
  const memberships = [...record.pg].sort((a, b) =>
    (membershipOrder[a[1]] ?? 4) - (membershipOrder[b[1]] ?? 4) || Number(a[0]) - Number(b[0]));
  const entries = record.pg.length
    ? el("details", { class: "gene-groups" },
        el("summary", {}, `View ${memberships.length} group${memberships.length === 1 ? "" : "s"}`),
        el("p", { class: "group-context" }, `Reference annotation: ${genomeLabel(genome)}. A group can contain several copies; being in a group is not a direct pairwise match.`),
        el("div", { class: "group-buttons" }, memberships.map(([pg, flag]) => el("button", {
          type: "button", class: "entry-button", onclick: () => openEntry(genome, pg),
        }, el("strong", {}, `Group ${pg}`), el("span", {}, panGeneMemberLabel(flag)), el("span", { class: "group-action" }, "View members →")))))
    : el("span", { class: "muted" }, "No pan-gene group recorded");
  const location = record.chr
    ? `${fmt.loc(record.chr, record.s, record.e)} bp${record.str ? ` · ${record.str} strand` : ""}`
    : "Not available";
  card.replaceChildren(...[
    el("div", { class: "gene-title" },
      el("h2", {}, record.id), el("span", { class: "pill" }, genomeLabel(genome)),
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
  const aligning = state.view === "alignment";
  for (const id of ["#result-download-control", "#genome-controls"]) $(id).hidden = aligning;
  // 排名条数和"排名匹配/相关基因"开关只属于证据页 / The hit count and the list switch belong to the Evidence view
  for (const id of ["#hit-controls", "#evidence-controls"]) $(id).hidden = state.view !== "evidence";
  document.querySelectorAll("[data-top]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.top) === state.top)));
  document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === state.view)));
  document.querySelectorAll("[data-evidence]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.evidence === state.evidence)));
  const total = state.manifest.target_genomes.length;
  const selected = state.shown.size;
  const count = $("#genome-selection-count");
  if (count) count.textContent = `${selected} of ${total} selected`;
  $("[data-genomes=all]").disabled = selected === total;
  $("[data-genomes=none]").disabled = selected === 0;
  const chips = $("#genome-chips");
  chips.replaceChildren(...displayGenomes().map((g) => el("button", {
    type: "button", class: "chip", "aria-pressed": String(state.shown.has(g)),
    onclick: () => { state.shown.has(g) ? state.shown.delete(g) : state.shown.add(g); renderControls(); renderResults(); },
  }, genomeLabel(g))));
  $("#controls").hidden = false;
}

// 显示用的注释名称和顺序（config.js 的 genomeLabels、genomeOrder）；数据文件里仍是原编号和 manifest 的顺序
// Display names and order of the annotations (genomeLabels, genomeOrder in config.js); the data files keep the
// original IDs and the manifest order, and every lookup still indexes by the manifest.
const genomeLabel = (genome) => CONFIG.genomeLabels?.[genome] || genome;
window.genomeLabel = genomeLabel;

function displayGenomes() {
  const genomes = state.manifest.target_genomes;
  const order = (CONFIG.genomeOrder || []).filter((g) => genomes.includes(g));
  return [...order, ...genomes.filter((g) => !order.includes(g))];
}

// Genomes in display order: the query's own genome first, then the display order, filtered.
function shownGenomes() {
  const genomes = displayGenomes();
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
  const row = (label, value) => el('div', { class: 'detail-row' },
    el('dt', {}, label), el('dd', {}, value));
  const chromosome = hit ? hit[h.chromosome] : relation[r.chromosome];
  const start = hit ? hit[h.start] : relation[r.start];
  const end = hit ? hit[h.end] : relation[r.end];
  const length = hit ? hit[h.protein_length] : relation[r.protein_length];
  const details = [
    row('Query', `${state.record.id} (${genomeLabel(state.genome)}, `
      + `${fmt.loc(state.record.chr, state.record.s, state.record.e)} bp)`),
    row('Target', el('span', {}, geneLink(targetId, genome),
      ` (${genomeLabel(genome)}, ${fmt.loc(chromosome, start, end)} bp, ${fmt.int(length)} aa)`)),
  ];
  if (hit) {
    details.push(
      row('Protein alignment', `${fmt.bits(hit[h.bitscore])} bits, E-value ${hit[h.evalue]}, `
        + `identity ${fmt.pct(hit[h.identity_pct])}%, alignment length ${fmt.int(hit[h.alignment_length])} aa`),
      row('Aligned region', `query ${fmt.int(hit[h.query_start])}–${fmt.int(hit[h.query_end])} `
        + `(${fmt.pct(hit[h.query_coverage_pct])}% of the query protein); `
        + `target ${fmt.int(hit[h.target_start])}–${fmt.int(hit[h.target_end])} `
        + `(${fmt.pct(hit[h.target_coverage_pct])}% of the target protein)`),
      row('Search', searchInfo(hit[h.search])),
    );
  } else {
    details.push(row('Protein alignment',
      'No hit stored for this pair. Absence from reported hits does not establish biological absence.'));
  }
  if (relation) {
    const blocks = relation[r.synteny_blocks] || [];
    const cross = evidenceField(relation, r, 'cross_synteny_blocks', []);
    const orthology = relation[r.orthology] || [];
    const blockList = (values, kind) => values.length
      ? el('ul', {}, values.map((block) => el('li', {}, blockLabel(block, syntenyRun(kind)))))
      : 'none recorded';
    details.push(row('Same-chromosome synteny', blockList(blocks, 'synteny')));
    if (syntenyRun('cross_synteny')) {
      details.push(
        row('Cross-chromosome synteny', blockList(cross, 'cross_synteny')),
        row('Cross-chromosome interpretation',
          'Conserved gene order from the all-chromosome run. It can reflect homeology or structural '
          + 'differences; it does not confirm an ortholog or a translocation.'),
      );
    }
    const groups = [...new Map(orthology.map(([id, og]) => [og, id])).entries()];
    details.push(
      row('OrthoFinder', groups.length
        ? el('ul', {}, groups.map(([og, id]) => el('li', {},
            `orthogroup ${og} (pairwise row ${id} of run ${m.run})`)))
        : 'OrthoFinder does not list them as orthologs'),
      row('Shared pan-gene entries', relation[r.shared_pgids].length
        ? `${relation[r.shared_pgids].map((pg) => `entry ${pg}`).join(', ')} `
          + `with ${genomeLabel(state.genome)} as reference annotation, run ${m.run}`
        : "none with the query annotation as reference"),
    );
  } else if (hit) {
    details.push(row('Direct relations', 'none: not a recorded syntenic or OrthoFinder partner'));
  }
  details.push(row('Provenance', `run ${m.run}; source database SHA-256 `
    + `${m.source_database_sha256.slice(0, 16)}…; evidence identifiers require their source run.`));
  openDialog(el('h2', {}, `${state.record.id} → ${targetId}`), el('dl', { class: 'details' }, details));
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
    if (relations.length && !best[h.synteny] && !evidenceField(best, h, 'cross_synteny') && !best[h.orthofinder]) hints.push(["best hit not related", "The best hit has no synteny or OrthoFinder link; a related gene ranks lower"]);
  }
  if (target[col.target.hit_cap_reached]) hints.push(["search list full", "The search list was full (25 matches)"]);
  const kinds = { both: 0, synteny: 0, orthofinder: 0, cross: 0 };
  for (const rel of relations) {
    if (evidenceField(rel, r, 'cross_synteny')) kinds.cross += 1;
    if (rel[r.synteny] && rel[r.orthofinder]) kinds.both += 1;
    else if (rel[r.synteny]) kinds.synteny += 1;
    else if (rel[r.orthofinder]) kinds.orthofinder += 1;
  }
  const relationText = relations.length
    ? `${relations.length}` + (relations.length > 1 || !kinds.both
        ? ` (${[kinds.both && `${kinds.both} synteny+OrthoFinder`, kinds.synteny && `${kinds.synteny} synteny`, kinds.orthofinder && `${kinds.orthofinder} OrthoFinder`, kinds.cross && `${kinds.cross} cross-chr`].filter(Boolean).join(", ")})`
        : " (synteny+OrthoFinder)")
    : "0";
  const main = el("tr", { class: `overview-row${expanded ? " expanded" : ""}${genome === state.genome ? " self-row" : ""}`,
                          onclick: (event) => { if (event.target.closest("a, button")) return; toggleExpanded(genome); } },
    el("td", { class: "genome-cell" },
      el("span", { class: "caret", "aria-hidden": "true" }, expanded ? "▾" : "▸"), " ", genomeLabel(genome),
      genome === state.genome ? el("span", { class: "pill" }, "query annotation") : null),
    best
      ? el("td", {}, geneLink(best[h.target_id], genome), el("div", { class: "small muted" }, `${fmt.loc(best[h.chromosome], best[h.start], best[h.end])} bp · ${fmt.pct(best[h.identity_pct])}% identity · ${fmt.bits(best[h.bitscore])} bits`))
      : el("td", { class: "muted" }, state.manifest.target_statuses[status] || status),
    best ? el("td", { class: "num cov-pair" }, `${fmt.pct(best[h.query_coverage_pct])} / ${fmt.pct(best[h.target_coverage_pct])}`) : el("td", {}, "–"),
    el("td", { class: "num" }, relationText),
    el("td", { class: "hints" }, hints.map(([text, title]) => el("span", { class: `badge hint hint-${text.split(" ")[0]}`, title }, text)),
      best ? detailsButton("details", (e) => { e.stopPropagation(); openPairDetails(genome, best[h.target_id]); }) : null));
  const detail = expanded ? el("tr", { class: "overview-detail" }, el("td", { colspan: 5 },
    el("h4", {}, `Hits in ${genomeLabel(genome)}`), hitsTable(genome),
    el("h4", {}, `Related genes in ${genomeLabel(genome)}`), relatedTable(genome))) : null;
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
    el("h3", {}, genomeLabel(genome), genome === state.genome ? el("span", { class: "pill" }, "query annotation") : null),
    el("span", { class: "muted" },
      status === "hits" ? `${reported} candidate${reported === 1 ? "" : "s"}` : statusText,
      cap ? el("span", { class: "badge cap", title: "The search list was full, so more similar genes may exist" }, "search list full") : null));
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
    el("td", { class: "evidence" }, badges({ synteny: hit[h.synteny], crossSynteny: evidenceField(hit, h, 'cross_synteny'), orthofinder: hit[h.orthofinder],
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
  if (!relations.length) return el("p", { class: "muted empty" }, "No syntenic or OrthoFinder partner in this annotation.");
  const rows = relations.map((rel) => {
    const rank = rel[r.hit_rank];
    const outside = rank === null || rank > state.top;
    const blocks = [blocksText(rel[r.synteny_blocks]), blocksText(evidenceField(rel, r, 'cross_synteny_blocks', []), 'cross_synteny')].filter(Boolean).join('; ');
    const groups = [...new Set(rel[r.orthology].map(([, og]) => og))].join("; ");
    return el("tr", { class: outside ? "outside-row" : null },
      el("td", { class: "num" }, rank === null ? el("span", { class: "badge nohit" }, "no hit")
        : rank > state.top ? el("span", { class: "badge beyond", title: `Ranked after the top ${state.top}` }, rank) : rank),
      el("td", {}, geneLink(rel[r.target_id], genome)),
      el("td", { class: "loc" }, fmt.loc(rel[r.chromosome], rel[r.start], rel[r.end])),
      el("td", { class: "evidence" }, badges({ synteny: rel[r.synteny], crossSynteny: evidenceField(rel, r, 'cross_synteny'), orthofinder: rel[r.orthofinder],
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
    el("thead", {}, el("tr", {}, ["Rank", "Gene", "Location", "Evidence", "Synteny runs / blocks", "Orthogroups", "Shared pgIDs",
      "Bits", "E-value", "Identity %", "Aln len", "Query cov %", "Target cov %", ""].map((t) => el("th", {}, t)))),
    el("tbody", {}, rows)));
}

function renderPerGenome(table) {
  const genomes = shownGenomes();
  if (!genomes.length) return el("p", { class: "muted" }, "No annotation selected.");
  return genomes.map((genome) => el("article", { class: "target", "data-genome": genome }, targetHeader(genome), table(genome)));
}

// ---- Plain wording for flags and reasons ---------------------------------------------------------------

// The data keep their own flag names and reason text, and downloads show them unchanged. The page shows these
// instead. A flag without an entry falls back to the manifest text, a reason without a rule to its original text.
const HOMEOLOG_CAVEAT = "Corresponding genes across annotations are selected using protein matches, OrthoFinder and "
  + "synteny between chromosomes with the same number. Homeologs are predicted from protein similarity and chromosome "
  + "groups. Cross-checked means that the query’s homeolog in its own annotation maps to the same candidate in another "
  + "annotation, or, within the query annotation, the candidate’s best qualifying reverse match is the query. "
  + "Cross-chromosome synteny is shown in Evidence and helps flag positions to verify. Homeolog predictions do not "
  + "require direct synteny.";

const FLAG_TEXT = {
  no_protein_hit: "Chosen by synteny or OrthoFinder. No protein match to the query is stored.",
  candidates_conflict: "Another gene looks better on some measure. It is named under Why. Check before relying on this pick.",
  best_hit_unplaced: "No copy meeting the current rules was found on the expected chromosome, but a good match is on an "
    + "unplaced sequence. It may be the missing copy, not yet assembled into a chromosome.",
  near_identical_unconfirmed: "At least 99% identical to the query, with no second check in support. It may be a "
    + "misplaced copy or the result of gene conversion.",
  chosen_by_second_route: "Another gene scored slightly higher, but this one is within 5% and the check through the "
    + "homeolog points to it.",
  second_route_disagrees: "The check through the query's homeolog points to a different gene, named under Why.",
  confirmed_by_partner: "The usual check gene could not be used here, often because of a fused or split gene model, so "
    + "another partner of the homeolog was used.",
  own_homeolog_unconfirmed: "The homeolog used for this check has no second check of its own.",
  target_group_boundary: "The homeolog group for this gene is uncertain.",
  hit_cap_reached: "The search keeps at most {max} matches per protein, and the list was full. None fell on this "
    + "chromosome, so a copy here may have been cut off.",
  position_conflict: "This gene, or a candidate left out of this cell, is on a chromosome that disagrees with other "
    + "annotations. Its position needs checking.",
};

function flagText(flag) {
  const text = FLAG_TEXT[flag];
  return text ? text.replace("{max}", state.manifest.search_max_hits) : state.homeologManifest.flags[flag] || "";
}

// One rule per clause that step 07 writes (07_homeologs.py); a clause is what lies between "; " outside brackets.
const VIA_HOMEOLOG = "The check through the query's homeolog points to";
const REASON_RULES = [
  [/^second route points to (\S+)$/, `${VIA_HOMEOLOG} a different gene: $1.`],
  [/^second route points to (\S+), whose hit to the query was not stored \(a search reached its hit limit\)$/,
    `${VIA_HOMEOLOG} $1, but no match to the query is stored. The search list was full, so the match may not have been reported.`],
  [/^second route points to (\S+), which fails the homeolog thresholds here$/,
    `${VIA_HOMEOLOG} $1, but its protein match is below 80% identity or 50% coverage.`],
  [/^second route points to (\S+), which belongs to the other segment$/,
    `${VIA_HOMEOLOG} $1, but that gene is on the other part of a composite chromosome.`],
  [/^ortholog of the own-genome homeolog$/, "Found through the query's homeolog in the same annotation."],
  [/^direct hit below 80% identity or 50% coverage$/, "The direct protein match is below 80% identity or 50% coverage."],
  [/^no direct hit stored$/, "No direct protein match to the query is stored."],
  [/^passing hit (\S+) on (\S+) belongs to group (G\d+) \(the other segment of that chromosome\)$/,
    "$1 on $2 matches, but it lies on the other part of that composite chromosome (group $3)."],
  [/^hits on (\S+) below 80% identity or 50% coverage$/, "Matches on $1 are below 80% identity or 50% coverage."],
  [/^the only hits on (\S+) are genes in position conflict$/, "The only matches on $1 are genes whose position needs checking."],
  [/^no hit on (\S+)$/, "No stored protein match on $1."],
  [/^no hit in this genome$/, "No stored protein match in this annotation."],
  [/^a homeolog-grade copy sits on unplaced sequence (\S+): (\S+) \(([\d.]+)% identity, coverage (\d+)\/(\d+); subgenome unknown\)$/,
    "A good match is on an unplaced sequence: $2 on $1, $3% identity, coverage $4/$5. Its subgenome is unknown."],
  [/^no syntenic, OrthoFinder or close \(>= 97% identity\) copy on (\S+)$/,
    "No corresponding gene found on $1 under the current rules: no syntenic or OrthoFinder partner, and no stored copy at least 97% identical."],
  [/^close copies only on (\S+)$/, (all, list) => `Copies at least 97% identical are only on ${list.replace(/,/g, ", ")}.`],
  [/^partners only on (\S+)$/, (all, list) => `Syntenic or OrthoFinder partners are only on ${list.replace(/,/g, ", ")}.`],
  [/^best copy on unplaced sequence (\S+): (\S+) \(([\d.]+)% identity, coverage (\d+)\/(\d+)\), possibly not assembled into a chromosome$/,
    "The best copy is on an unplaced sequence: $2 on $1, $3% identity, coverage $4/$5. It may not have been assembled into a chromosome."],
  [/^(\S+) has more evidence \(synteny and OrthoFinder\)$/, "$1 has more evidence: both synteny and OrthoFinder."],
  [/^(\S+) is a complete near-identical copy \(([\d.]+)%\)$/, "$1 is a complete, near-identical copy ($2% identical)."],
  [/^(\S+) is the syntenic anchor at this position$/, "$1 is the syntenic anchor at this position."],
  [/^(\S+) is near-identical \(([\d.]+)%\) but the alignment covers only (\d+)% of the query: a fragment, or the query is a merged model$/,
    "$1 is near-identical ($2%) but covers only $3% of the query. It may be a fragment, or the query may be two genes merged into one model."],
  [/^(\S+) is near-identical \(([\d.]+)%\) but the alignment covers only (\d+)% of that gene: the query is a fragment, or that gene is a fused model$/,
    "$1 is near-identical ($2%) but only $3% of it aligns. The query may be a fragment, or that gene may be a fused gene model."],
  [/^(\S+) scores (\d+) bits against (\d+)$/, "$1 has a much higher score: $2 bits against $3."],
];

// A gene's position sentence from step 07. leftOut: the gene was set aside from this cell.
function plainPosition(text, leftOut) {
  const stretch = text.match(/^(\S+) sits on (\S+) in this assembly, inside a stretch \(([\d.]+)-([\d.]+) Mb\) where (\d+) of (\d+) genes are in position conflict by their own vote toward (\S+)$/);
  const vote = text.match(/^(\S+) sits on (\S+) in this assembly, but in (\d+) of (\d+) genomes( each)? its synteny points to (.+)$/);
  const found = stretch || vote;
  if (!found) return null;
  const opening = `${found[1]} ${leftOut ? "was left out: it is" : "is"} on ${found[2]} here`;
  if (stretch) return `${opening}, in a ${stretch[3]}–${stretch[4]} Mb region where ${stretch[5]} of ${stretch[6]} genes point to ${stretch[7]}.`;
  return vote[5] ? `${opening}, but its syntenic partners point to ${vote[6]}, ${vote[3]} of ${vote[4]} annotations each.`
    : `${opening}, but ${vote[3]} of ${vote[4]} annotations place its syntenic partner on ${vote[6]}.`;
}

function plainClause(clause, leftOut) {
  const toVerify = clause.endsWith(": position to verify");
  const position = plainPosition(clause.replace(/: position to verify$/, ""), leftOut);
  if (position) return toVerify ? `${position} Its position needs checking.` : position;
  for (const [rule, text] of REASON_RULES) if (rule.test(clause)) return clause.replace(rule, text);
  return clause;
}

// Splits at "; " outside brackets, so "(90% identity, coverage 80/80; subgenome unknown)" stays whole.
function reasonClauses(text) {
  const clauses = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (depth === 0 && text.startsWith("; ", i)) {
      clauses.push(text.slice(start, i));
      start = i + 2;
    }
  }
  clauses.push(text.slice(start));
  return clauses;
}

// A cell's reason in plain sentences; "" when it has none.
function plainReason(reason) {
  if (!reason) return "";
  const sentences = [];
  let leftOut = false;
  for (let clause of reasonClauses(reason)) {
    if (clause.startsWith("check: ")) {
      sentences.push("Another gene may be the better pick.");
      clause = clause.slice("check: ".length);
    } else if (clause.startsWith("left out: ")) {
      leftOut = true;
      clause = clause.slice("left out: ".length);
    }
    sentences.push(plainClause(clause, leftOut));
  }
  return sentences.join(" ");
}

const OWN_VOTE_RULES = [
  [/^its own vote was not taken \(cross-chromosome partners in fewer than (\d+) genomes\)$/,
    "It has cross-chromosome partners in fewer than $1 annotations, too few to judge on its own."],
  [/^its own synteny gives no vote$/, "Its own synteny gives no answer."],
  [/^its own vote: (.+) of (\d+) genomes$/, "On its own: $1 of $2 annotations."],
];

// A position-conflict note in plain sentences; other notes are short and stay as they are.
function plainNote(note) {
  if (!note) return "";
  const vote = note.match(/^position conflicts with synteny: on (\S+) here, but in (\d+) of (\d+) genomes( each)? the synteny points to (.+); subgenome to verify$/);
  if (vote) {
    return `This gene is on ${vote[1]} here, but ${vote[4]
      ? `its syntenic partners point to ${vote[5]}, ${vote[2]} of ${vote[3]} annotations each`
      : `${vote[2]} of ${vote[3]} annotations place its syntenic partner on ${vote[5]}`}. Its position and subgenome need checking.`;
  }
  const stretch = note.match(/^position conflicts with synteny: on (\S+) here, inside a conflict stretch \(([\d.]+)-([\d.]+) Mb\) where (\d+) of (\d+) genes are in position conflict by their own vote toward (\S+); (.+); subgenome to verify$/);
  if (stretch) {
    const rule = OWN_VOTE_RULES.find(([pattern]) => pattern.test(stretch[7]));
    const own = rule ? stretch[7].replace(...rule) : stretch[7];
    return `This gene is on ${stretch[1]} here, in a ${stretch[2]}–${stretch[3]} Mb region where ${stretch[4]} of ${stretch[5]} genes `
      + `point to ${stretch[6]}. ${own} Its position and subgenome need checking.`;
  }
  return note;
}

// ---- Homeologs ---------------------------------------------------------------------------------------

// What a homeolog-table cell says about its evidence, in words.
function cellEvidence(cell) {
  const c = col.cell, role = cell[c.role], stateName = cell[c.state], evidence = cell[c.evidence];
  if (stateName === "self") return "the query";
  if (isToVerify(cell)) return "to verify";
  if (role === "ortholog") {
    return { "synteny+orthofinder": "synteny + OrthoFinder", synteny: "synteny only", orthofinder: "OrthoFinder only",
             sequence: "sequence only (≥ 97% identity)" }[evidence] || evidence;
  }
  if (stateName === "confirmed" && cell[c.flags].includes("confirmed_by_partner")) return "partner supported";
  return { confirmed: "cross-checked", sequence_only: "sequence only", ambiguous: "sequence only, near-equal candidates",
           via_own_homeolog: "found via homeolog" }[stateName] || stateName;
}

function cellEvidenceDescription(cell, genome) {
  const c = col.cell, role = cell[c.role], stateName = cell[c.state], flags = cell[c.flags];
  if (stateName === "self") return "This is the query gene itself.";
  if (isToVerify(cell)) return "This is a candidate only: its position or subgenome needs checking, so it is not a confirmed corresponding gene or homeolog. " + (plainReason(cell[c.reason]) || "See its pairwise evidence and the position notice.");
  if (role === "ortholog") {
    return {
      "synteny+orthofinder": "These genes sit in conserved gene order, and OrthoFinder also links them. This is computational support, not experimental proof.",
      synteny: "These genes sit in conserved gene order. No OrthoFinder link was recorded.",
      orthofinder: "OrthoFinder links these genes, but this analysis found no direct conserved gene order between them.",
      sequence: "A close protein match, with no direct synteny or OrthoFinder link recorded.",
    }[cell[c.evidence]] || "Open the details to inspect the evidence for this candidate.";
  }
  if (stateName === "confirmed") {
    let explanation;
    if (flags.includes("confirmed_by_partner")) {
      explanation = "The usual check gene could not be used here, so this gene was checked through another syntenic or OrthoFinder partner of the query's homeolog.";
    } else if (genome === state.genome) {
      explanation = "This gene is the best match on the other subgenome, and its own best match back is the query gene.";
    } else {
      explanation = "The direct protein match and the check through the query's homeolog in the same annotation both point to this gene.";
    }
    if (flags.includes("own_homeolog_unconfirmed")) explanation += " The homeolog used for this check is itself unconfirmed.";
    return explanation + " The two checks share input data, so this is not independent or experimental proof.";
  }
  return {
    sequence_only: "This gene passes the protein identity and coverage limits on the expected chromosome, but no second check supports it.",
    ambiguous: "Several genes match almost equally well. This is one of them; compare the others before choosing.",
    via_own_homeolog: "The direct protein match is weak or missing, so this gene was found through the query's homeolog in the same annotation.",
  }[stateName] || "Open the details to inspect how this candidate was selected.";
}

function openCellDetails(genome, sg, cell) {
  const c = col.cell, hm = state.homeologManifest;
  const row = (label, value) => el("div", { class: "detail-row" }, el("dt", {}, label), el("dd", {}, value));
  const flags = cell[c.flags];
  const details = [];
  if (cell[c.gene_id] !== null) {
    details.push(
      row("Gene", el("span", {}, geneLink(cell[c.gene_id], genome), ` (${genomeLabel(genome)} ${sg}, ${fmt.loc(cell[c.chromosome], cell[c.start], cell[c.end])} bp)`)),
      row("Role", isToVerify(cell) ? "candidate — position / subgenome to verify" : cell[c.role] === "ortholog" ? "corresponding gene (same subgenome as the query)" : cell[c.role] === "self" ? "the query itself" : "predicted homeolog"),
      row("Evidence", isToVerify(cell) ? `to verify · ${evidenceText(cell[c.evidence])}` : cellEvidence(cell)),
      row("What this means", cellEvidenceDescription(cell, genome)),
      cell[c.identity_pct] === null ? row("Protein match", "no stored protein hit to the query")
        : row("Protein match", `${fmt.pct(cell[c.identity_pct])}% identity, coverage ${fmt.pct(cell[c.query_coverage_pct])}% of the query / `
          + `${fmt.pct(cell[c.target_coverage_pct])}% of this gene, ${fmt.bits(cell[c.bitscore])} bits, rank ${cell[c.hit_rank]} among all stored candidates in ${genomeLabel(genome)}`),
    );
  } else {
    details.push(row("Result", `not found under the current rules (${sg} copy in ${genomeLabel(genome)})`));
  }
  // For a candidate to verify, "What this means" already gives the reason.
  if (cell[c.reason] && !isToVerify(cell)) details.push(row("Why", plainReason(cell[c.reason])));
  if (cell[c.gene_id]) {
    const direct = pairDetails(genome, cell[c.gene_id]);
    if (direct.hit || direct.relation) details.push(row("Pairwise evidence",
      detailsButton("sequence, synteny blocks and source runs", () => openPairDetails(genome, cell[c.gene_id]))));
  }
  details.push(row("Prediction run", hm.run));
  if (cell[c.n_alternatives]) {
    const title = cell[c.gene_id] === null ? "Copy on an unplaced sequence" : cell[c.role] === "ortholog" ? "Other partners" : "Near-equal candidates";
    details.push(row(`${title} (${cell[c.n_alternatives]})`, el("ul", {}, cell[c.alternatives].map(([id, bits]) =>
      el("li", {}, geneLink(id, genome), bits === null ? " (no stored hit)" : ` (${fmt.bits(bits)} bits)`)),
      cell[c.n_alternatives] > cell[c.alternatives].length ? el("li", { class: "muted" }, `… and ${cell[c.n_alternatives] - cell[c.alternatives].length} more`) : null)));
  }
  // The flag's own name stays visible in small print: it is what downloaded tables show.
  if (flags.length) details.push(row("Flags", el("ul", {}, flags.map((f) => el("li", {}, flagText(f), " ", el("code", { class: "flag-key" }, f))))));
  details.push(row("See also", el("span", {},
    detailsButton(`all hits and related genes in ${genomeLabel(genome)}`, () => { $("#dialog").close(); showGenomeDetails(genome); }),
    " — including hits on other chromosomes and unplaced sequences.")));
  openDialog(el("h2", {}, `${state.record.id}: ${isToVerify(cell) ? "candidate" : `${sg} copy`} in ${genomeLabel(genome)}`), el("dl", { class: "details" }, details));
}

// 打开证据页并滚到这个注释（从同源格子看另一条染色体上的匹配就靠它）
// Open the Evidence view at one annotation (the way to see cross-chromosome hits from a Homeologs cell).
function showGenomeDetails(genome) {
  state.shown.add(genome);
  setView("hits");                     // 从"top hit"过来，先看排名匹配 / arriving from a top hit, show the ranked hits
  document.querySelector(`.target[data-genome="${CSS.escape(genome)}"]`)?.scrollIntoView({ block: "start" });
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
        flags.includes("hit_cap_reached") ? el("span", { class: "badge cap", title: "The search list was full" }, "search list full ") : null,
        detailsButton("why?", open)));
  }
  const check = flags.includes("candidates_conflict") || flags.includes("near_identical_unconfirmed") || flags.includes("second_route_disagrees") || flags.includes("position_conflict");
  return el("td", { class: `hcell ${cell[c.role]}` },
    el("div", {}, geneLink(cell[c.gene_id], genome),
      el("div", { class: "muted small" }, `${fmt.loc(cell[c.chromosome], cell[c.start], cell[c.end])} bp`)),
    el("div", { class: "hmeta" },
      cell[c.state] === "self" ? null
        : cell[c.identity_pct] === null ? el("span", { class: "muted" }, "no stored hit · ")
        : el("span", {}, `${fmt.pct(cell[c.identity_pct])}% · cov ${fmt.pct(cell[c.query_coverage_pct])}/${fmt.pct(cell[c.target_coverage_pct])} · `),
      el("button", {
        type: "button", class: `badge evidence-help state-${cell[c.state]}`,
        "aria-label": `${cellEvidence(cell)}. ${cellEvidenceDescription(cell, genome)}`,
        onmouseenter: (event) => showEvidenceTooltip(event.currentTarget, cellEvidenceDescription(cell, genome)),
        onmouseleave: hideEvidenceTooltip,
        onfocus: (event) => showEvidenceTooltip(event.currentTarget, cellEvidenceDescription(cell, genome)),
        onblur: hideEvidenceTooltip,
        onkeydown: (event) => { if (event.key === "Escape") hideEvidenceTooltip(); },
        onclick: open,
      }, cellEvidence(cell)),
      check ? el("span", { class: "badge partial", title: plainReason(cell[c.reason]) || "Check this pick" }, " check") : null,
      cell[c.n_alternatives] ? el("button", { type: "button", class: "link-button", onclick: open },
        `+${cell[c.n_alternatives]} candidate${cell[c.n_alternatives] > 1 ? "s" : ""}`) : null,
      detailsButton("details", open)));
}

function positionReviewNotice(homeologs) {
  const conflict = homeologs.position_conflict;
  if (!conflict) return null;
  const row = (label, value) => el('div', { class: 'detail-row' },
    el('dt', {}, label), el('dd', {}, value));
  const votes = conflict.votes === null
    ? 'Not counted: cross-chromosome partners in fewer than 3 annotations'
    : Object.entries(conflict.votes || {}).map(([chr, count]) => `${chr}: ${count}`).join('; ') || 'No result';
  const evidence = (conflict.tied || [conflict.evidence]).filter(Boolean).join(' / ');
  const stretch = conflict.stretch;
  // Review boundaries describe supporting context, not a corrected assembly.
  return el('article', { class: 'position-review target' },
    el('h3', {}, 'Position / subgenome to verify'),
    el('p', {}, 'This gene keeps its original position. The genes below are candidates only: they have no assigned '
      + 'subgenome and are not confirmed.'),
    el('dl', { class: 'details' },
      row('Original location', `${fmt.loc(state.record.chr, state.record.s, state.record.e)} bp`),
      // The page describes the two cases in words; the data's basis values stay vote / stretch
      row('Why it is flagged', conflict.basis === 'stretch'
        ? 'Nearby genes: many genes around it point to another chromosome, so it is flagged with them.'
        : 'This gene: among other annotations that have a syntenic partner for it, most place that partner on a different chromosome.'),
      row('Chromosome suggested by other annotations', evidence || 'Not settled'),
      row('Where other annotations place it', votes),
      stretch ? row('Flagged region', `${fmt.loc(state.record.chr, stretch.start, stretch.end)} bp. `
        + `Here ${fmt.int(stretch.conflict_genes)} of ${fmt.int(stretch.genes)} genes point to ${stretch.evidence}. `
        + 'These limits mark what to check; they are not proven rearrangement breakpoints.') : null),
    el('details', {}, el('summary', {}, 'How this gene was flagged'),
      el('p', { class: 'muted small' }, plainNote(homeologs.note) || 'Inspect the underlying pairwise evidence.')));
}

function positionCandidateTable(homeologs, genome) {
  const hm = state.homeologManifest, c = col.cell;
  const index = hm.target_genomes.indexOf(genome);
  const [cells, total] = homeologs.candidates?.[index] || [[], 0];
  const rows = cells.map((cell) => el('tr', {},
    el('td', {}, geneLink(cell[c.gene_id], genome)),
    el('td', { class: 'loc' }, `${fmt.loc(cell[c.chromosome], cell[c.start], cell[c.end])} bp`),
    el('td', {}, el('span', { class: 'badge state-to_verify' }, 'to verify'),
      el('div', { class: 'small muted' }, evidenceText(cell[c.evidence]) || 'No pairwise evidence recorded')),
    el('td', { class: 'num' }, fmt.pct(cell[c.identity_pct])),
    el('td', { class: 'num' }, `${fmt.pct(cell[c.query_coverage_pct])} / ${fmt.pct(cell[c.target_coverage_pct])}`),
    el('td', {}, detailsButton('details', () => openCellDetails(genome, 'unassigned', cell)))));
  return el('article', { class: 'target review-candidates' },
    el('header', { class: 'target-header' }, el('h3', {}, genomeLabel(genome)),
      el('span', { class: 'muted' }, `${total} candidate${total === 1 ? '' : 's'}`)),
    rows.length
      ? el('div', { class: 'table-wrap' }, el('table', {},
          el('thead', {}, el('tr', {},
            ['Candidate', 'Original location', 'Status / evidence', 'Identity %', 'Query / target cov %', '']
              .map((name) => el('th', {}, name)))),
          el('tbody', {}, rows)))
      : el('p', { class: 'muted' }, 'No syntenic or OrthoFinder candidate was recorded in this annotation.'),
    total > cells.length ? el('p', { class: 'muted small' },
      `${cells.length} of ${total} candidates shown here. Evidence → Related genes lists every stored pairwise relationship.`) : null,
    detailsButton('all hits and related genes', () => showGenomeDetails(genome)));
}

// 部分同源页：每套注释一行，每个亚基因组一栏；本亚基因组那一栏（对应的基因）高亮；没有亚基因组预测时退回最佳匹配表
// Homeologs: one row per annotation, one column per subgenome, with the query's own-subgenome column (the
// corresponding gene) highlighted. Without a subgenome prediction the view falls back to the best-hit summary.
async function renderHomeologs(container) {
  const record = state.record;
  if (!state.homeologManifest) {
    container.replaceChildren(el("p", { class: "message" }, "Subgenome predictions are unavailable, so the closest sequence match in each annotation is shown instead."),
      renderOverview());
    return;
  }
  container.replaceChildren(el("p", { class: "muted" }, "Loading the corresponding genes…"));
  let homeologs;
  try {
    homeologs = await homeologRecord(state.genome, record.k);
  } catch (error) {
    if (state.view !== "homeologs" || state.record !== record) return;
    container.replaceChildren(el("p", { class: "message error" }, notAvailable(error)), renderOverview());
    return;
  }
  if (state.view !== "homeologs" || state.record !== record) return;   // the user moved on meanwhile
  const hm = state.homeologManifest, c = col.cell, h = col.hit;
  state.homeologs = homeologs;
  if (!homeologs.t && homeologs.position_conflict) {
    container.replaceChildren(positionReviewNotice(homeologs), ...shownGenomes().filter(g => hm.target_genomes.includes(g)).map(g => positionCandidateTable(homeologs, g)));
    return;
  }
  if (!homeologs.t) {
    container.replaceChildren(
      el("p", { class: "message" }, `No subgenome prediction for ${homeologs.id}: ${homeologs.note}. The closest sequence match in each annotation is shown instead.`),
      renderOverview());
    return;
  }
  const slots = hm.homeolog_groups[homeologs.group];
  const genomes = hm.target_genomes;
  const callNote = { fixed: "", window: " (group set by its neighbourhood on this composite chromosome)",
                     boundary: " (its homeolog group on this composite chromosome is uncertain)" }[homeologs.group_call];
  container.replaceChildren(...[
    homeologs.genomes_with_ortholog === 0
      ? el("p", { class: "message" }, "No corresponding gene was identified in another annotation under the current rules, so most cells are expected to be empty.") : null,
    el("p", { class: "homeolog-lead" }, "The highlighted ", el("strong", {}, `${homeologs.sg} column`),
      " is the query's own subgenome: the gene that corresponds to the query in each annotation. "
      + "The other two columns are its homeologs on the other subgenomes."),
    el("p", { class: "homeolog-summary" },
      `${homeologs.id} is on ${homeologs.chr}, subgenome ${homeologs.sg}, homeolog group ${homeologs.group}: `,
      hm.subgenomes.map((sg) => `${sg} ${slots[sg].join("/")}`).join(" · "), callNote),
    el("article", { class: "target" }, el("div", { class: "table-wrap" }, el("table", { class: "homeolog-table" },
      el("thead", {}, el("tr", {}, el("th", {}, "Annotation"),
        hm.subgenomes.map((sg) => el("th", { class: sg === homeologs.sg ? "own-sg" : null },
          el("span", { class: `sg-dot sg-${sg.toLowerCase()}`, "aria-hidden": "true" }),
          `${sg} · ${slots[sg].join("/")}`, el("br"),
          el("small", {}, sg === homeologs.sg ? "corresponding gene" : "homeolog"),
          proteinAlignmentButton(homeologs, sg, slots[sg]))))),
      el("tbody", {}, shownGenomes().filter((g) => genomes.includes(g)).map((genome) => {
        const cells = homeologs.t[genomes.indexOf(genome)];
        // The ortholog cell (the query's own subgenome) names an unplaced copy first; the homeolog
        // cells of the row only say "same unplaced copy" for the same gene.
        const own = cells[hm.subgenomes.indexOf(homeologs.sg)];
        const ownUnplaced = own[c.gene_id] === null && own[c.flags].includes("best_hit_unplaced") ? own[c.alternatives][0][0] : null;
        // 序列最像的基因不在这三栏里时，在注释名下注明（多半在另一条染色体或未定位片段上）
        // When the strongest protein match is none of the three cells, name it under the annotation
        // (usually a copy on another chromosome or on an unplaced sequence).
        const best = targetOf(genome)[col.target.hits][0];
        const named = new Set([...cells.map((cell) => cell[c.gene_id]), ownUnplaced].filter(Boolean));
        const elsewhere = best && !named.has(best[h.target_id]) ? best : null;
        return el("tr", { class: genome === state.genome ? "self-row" : null },
          el("th", { scope: "row" }, genomeLabel(genome),
            elsewhere ? el("div", { class: "row-note" }, "top hit ", geneLink(elsewhere[h.target_id], genome),
              el("span", { class: "muted" }, ` · ${isChromosome(elsewhere[h.chromosome]) ? elsewhere[h.chromosome] : "unplaced"} `),
              detailsButton("evidence", () => showGenomeDetails(genome))) : null),
          cells.map((cell, i) => {
            const td = homeologCell(cell, genome, hm.subgenomes[i], hm.subgenomes[i] === homeologs.sg ? null : ownUnplaced);
            if (hm.subgenomes[i] === homeologs.sg) td.classList.add("own-col");
            return td;
          }));
      }))))),
    // 出处由网站自己写：已发布数据（manifest）里那句 Kagale 的旧说法，要等第 07 步重跑、重新发布才会更正
    // The site states the sources itself: the published manifest's old Kagale wording changes only when step 07 is
    // run again and published
    el("p", { class: "muted small" }, `Each cell: gene · identity · coverage of the query / of that gene · evidence · near-equal candidates. `
      + `Subgenome names: ${SUBGENOME_SOURCES}. ${HOMEOLOG_CAVEAT}`),
  ].filter(Boolean));
  state.homeologs = homeologs;
}

// Members come from the displayed Homeologs cells, not from a chromosome-wide search.
function proteinAlignmentButton(homeologs, sg, chromosomes) {
  if (CONFIG.sequenceBase) return el("div", { class: "protein-alignment-action" }, el("button", {
    type: "button", class: "secondary", title: `Choose genes and transcripts for ${sg}`,
    onclick: () => { state.alignmentSubgenome = sg; setView("alignment"); },
  }, "Choose sequences"));
  const example = (CONFIG.proteinAlignmentExamples || []).find((item) =>
    item.queryGenome === state.genome && item.queryId === state.record.id &&
    item.subgenome === sg && item.group === homeologs.group);
  if (!example || !CONFIG.downloadBase) return null;
  return el("div", { class: "protein-alignment-action" }, el("button", {
    type: "button", class: "secondary",
    title: "Choose the genes for this sample in the Alignment view before running the alignment",
    onclick: () => setView("alignment"),
  }, "Choose sequences"), el("span", { class: "muted small" }, " sample"));
}

async function renderAlignmentView(container) {
  if (CONFIG.sequenceBase) return renderTranscriptAlignment(container);
  const record = state.record;
  const example = (CONFIG.proteinAlignmentExamples || []).find((item) =>
    item.queryGenome === state.genome && item.queryId === record.id);
  if (!example || !CONFIG.downloadBase) {
    const sample = (CONFIG.proteinAlignmentExamples || [])[0];
    container.replaceChildren(el("article", { class: "alignment-empty target" },
      el("h3", {}, "Sequence alignment"),
      el("p", {}, "Sequence data are not yet available for this query."),
      sample ? el("p", {}, "Try the available sample: ", el("a", {
        href: `#q=${encodeURIComponent(sample.queryId)}&g=${encodeURIComponent(sample.queryGenome)}&view=alignment`,
      }, `${sample.queryGenome}: ${sample.queryId}`), ` · ${sample.subgenome}.`) : null));
    return;
  }
  container.replaceChildren(el("p", { class: "muted" }, "Loading the candidate gene list…"));
  try {
    const homeologs = await homeologRecord(state.genome, record.k);
    if (state.view !== "alignment" || state.record !== record) return;
    if (!homeologs.t || homeologs.group !== example.group) throw new Error("This query's subgenome group differs from the sequence sample.");
    state.homeologs = homeologs;
    const hm = state.homeologManifest, c = col.cell;
    const chromosomes = hm.homeolog_groups[homeologs.group][example.subgenome];
    const sgIndex = hm.subgenomes.indexOf(example.subgenome);
    const genomes = [state.genome, ...displayGenomes().filter((genome) => genome !== state.genome)];
    const members = genomes.map((genome) => {
      const cell = homeologs.t[hm.target_genomes.indexOf(genome)][sgIndex];
      const details = cell[c.gene_id] ? pairDetails(genome, cell[c.gene_id]) : {};
      return {
        genome, gene_id: cell[c.gene_id], chromosome: cell[c.chromosome], start: cell[c.start], end: cell[c.end],
        length: details.hit?.[col.hit.protein_length] ?? details.relation?.[col.relation.protein_length] ?? null,
        evidence: cellEvidence(cell), state: cell[c.state], flags: cell[c.flags], cell,
      };
    });
    const key = `${state.genome}:${record.k}:${example.path}`;
    if (state.alignment?.key !== key) {
      state.alignment = { key, selected: new Set(members.filter((m) => m.gene_id).map(window.AlignmentSelection.key)) };
    }
    let picker;
    picker = window.AlignmentSelection.render(container, {
      queryId: record.id, label: `${example.subgenome} · ${chromosomes.join(" / ")}`,
      members, selected: state.alignment.selected,
      onSelectionChange: () => {
        window.ProteinAlignmentView.close();
        picker?.output.replaceChildren(el("p", { class: "muted" }, "Selection changed. Run alignment to compare the selected genes."));
      },
      onRun: (selected) => window.ProteinAlignmentView.open({
        body: picker.output, dialog: null, example, members: selected, chromosomes,
        manifest: state.manifest, homeologs, queryGenome: state.genome, downloadBase: CONFIG.downloadBase,
      }),
      onDetails: (member) => openCellDetails(member.genome, example.subgenome, member.cell),
    });
  } catch (error) {
    if (state.view !== "alignment" || state.record !== record) return;
    container.replaceChildren(el("p", { class: "message error" }, notAvailable(error)));
  }
}

let transcriptSource;

async function renderTranscriptAlignment(container) {
  const record = state.record, genome = state.genome, request = state.alignmentRenderSeq;
  const current = () => state.view === "alignment" && state.record === record && state.alignmentRenderSeq === request;
  container.replaceChildren(el("p", { class: "muted" }, "Loading genes and transcript options…"));
  try {
    transcriptSource ||= window.TranscriptSequences.create(CONFIG.sequenceBase, state.manifest);
    const homeologs = await homeologRecord(genome, record.k);
    if (!current()) return;
    const queryMetadata = await transcriptSource.catalog({ genome, gene_id: record.id, gene_key: record.k,
      chromosome: record.chr, start: record.s, end: record.e });
    if (!current()) return;
    state.homeologs = homeologs;
    const hm = state.homeologManifest, c = col.cell;
    const hasGroup = Boolean(homeologs.t && hm.homeolog_groups[homeologs.group]);
    const sg = hasGroup ? state.alignmentSubgenome || homeologs.sg : null;
    const sgIndex = hasGroup ? hm.subgenomes.indexOf(sg) : -1;
    if (hasGroup && sgIndex < 0) throw new Error("Unknown subgenome selection.");
    const chromosomes = hasGroup ? hm.homeolog_groups[homeologs.group][sg] : [record.chr].filter(Boolean);
    const key = `${genome}:${record.k}:${sg || "query"}`;
    if (state.alignment?.key !== key) state.alignment = {
      key, selected: null, transcripts: new Map(), genes: new Map(), includeOnLoad: new Set(),
    };
    const selection = state.alignment;
    const policy = window.AlignmentCandidates;
    const ranking = { sort: "bitscore", coverageThreshold: 80 };
    const genomes = [genome, ...displayGenomes().filter((g) => g !== genome)];
    let members = await Promise.all(genomes.map(async (g) => {
      const cell = hasGroup ? homeologs.t[hm.target_genomes.indexOf(g)][sgIndex] : null;
      const homeologId = cell?.[c.gene_id] || null;
      const ownQuery = !hasGroup && g === genome;
      const originalId = homeologId || (ownQuery ? record.id : null);
      let pool = policy.collectCandidates({ target: record.t[state.manifest.target_genomes.indexOf(g)],
        targetColumns: col.target, hitColumns: col.hit, relationColumns: col.relation, homeologId,
        homeologCandidates: homeologs.candidates?.[hm.target_genomes.indexOf(g)]?.[0] || [], cellColumns: c });
      // Some inferred Homeologs have no direct hit to this query; keep their original slots.
      if (originalId && !pool.some((candidate) => candidate.gene_id === originalId)) {
        pool.push({ gene_id: originalId, chromosome: ownQuery ? record.chr : cell[c.chromosome],
          start: ownQuery ? record.s : cell[c.start], end: ownQuery ? record.e : cell[c.end],
          length: ownQuery ? record.len : null, identity: ownQuery && record.len ? 100 : cell?.[c.identity_pct] ?? null,
          query_coverage: ownQuery && record.len ? 100 : cell?.[c.query_coverage_pct] ?? null,
          target_coverage: ownQuery && record.len ? 100 : cell?.[c.target_coverage_pct] ?? null,
          bitscore: cell?.[c.bitscore] ?? null, evalue: null, synteny: false, orthofinder: false,
          homeolog_selected: Boolean(homeologId) });
      }
      pool = policy.sort(pool, ranking).map((candidate, index) => ({ ...candidate,
        recommended: index === 0, complete: policy.isComplete(candidate, ranking.coverageThreshold),
        location_status: !candidate.chromosome ? "unknown" : !isChromosome(candidate.chromosome) ? "unplaced"
          : chromosomes.includes(candidate.chromosome) ? "expected" : "cross_chromosome",
      }));
      if (!selection.genes.has(g)) selection.genes.set(g, originalId || pool[0]?.gene_id || "");
      const chosen = pool.find((candidate) => candidate.gene_id === selection.genes.get(g));
      const base = { genome: g, candidates: pool, cell, homeolog_id: homeologId,
        homeolog_reason: cell?.[c.reason], reason: cell?.[c.reason] || (!pool.length ? "No stored candidate is available." : "") };
      if (!chosen) return { ...base, gene_id: null, available: false, transcripts: [] };
      const isQuery = ownQuery && chosen.gene_id === record.id;
      const needsReview = Boolean(chosen.review_required || (chosen.homeolog_selected && isToVerify(cell)) || (isQuery && homeologs.position_conflict));
      const candidateSource = needsReview ? "position_review" : chosen.homeolog_selected ? "homeolog" : isQuery ? "query" : "sequence_alternative";
      const evidence = needsReview ? "to verify — " + (chosen.evidence || (isQuery ? "query gene" : "candidate"))
        : chosen.homeolog_selected ? cellEvidence(cell) : isQuery ? "Query gene"
        : [chosen.synteny ? "synteny" : "", chosen.cross_synteny ? "cross-chromosome synteny" : "", chosen.orthofinder ? "OrthoFinder" : ""].filter(Boolean).join(" + ") || "sequence match";
      const flags = chosen.homeolog_selected ? cell[c.flags] : [
        "alignment_alternative", chosen.location_status !== "expected" ? chosen.location_status : "",
        !chosen.complete ? "partial_match" : "",
      ].filter(Boolean);
      const member = { ...base, ...chosen, candidate_source: candidateSource, evidence, flags: [...new Set([...flags, ...(chosen.flags || [])])],
        state: needsReview ? "to_verify" : chosen.homeolog_selected ? cell[c.state] : isQuery ? "query" : chosen.state || "sequence_alternative",
        include_default: isQuery || (chosen.homeolog_selected && !needsReview) };
      const entries = await resolve(member.gene_id, member.genome);
      const keys = [...new Set(entries.filter((entry) => entry[1] === member.gene_id).map((entry) => entry[2]))];
      if (keys.length !== 1) throw new Error(`Could not identify a unique gene key for ${member.genome}/${member.gene_id}.`);
      member.gene_key = keys[0];
      const metadata = await transcriptSource.catalog(member);
      const chosenKey = selection.transcripts.get(window.AlignmentSelection.key(member)) ?? metadata.default_transcript_key;
      const t = metadata.transcripts.find((row) => row.transcript_key === chosenKey);
      return { ...member, chromosome: metadata.chromosome, start: metadata.start, end: metadata.end,
        metric_reference: "original_representative_proteins", metric_query_genome: genome,
        metric_query_gene_id: record.id, metric_query_protein_id: queryMetadata.representative_protein_id,
        metric_target_protein_id: metadata.representative_protein_id,
        transcripts: metadata.transcripts, transcript_key: t?.transcript_key,
        is_representative: t?.is_representative,
        transcript_id: t?.transcript_id, protein_id: t?.protein_id, protein_status: t?.protein_status,
        cds_status: t?.cds_status, length: t?.protein_length,
        available: t?.protein_alignment_status === "supported" };
    }));
    if (!current()) return;
    if (!selection.selected) selection.selected = new Set(members.filter((m) => m.available && m.include_default).map(window.AlignmentSelection.key));
    for (const member of members) if (selection.includeOnLoad.has(member.genome) && member.available) {
      selection.selected.add(window.AlignmentSelection.key(member));
    }
    selection.includeOnLoad.clear();
    const content = el("div");
    let slotControl;
    if (hasGroup) {
      const chooser = el("select", { id: "alignment-subgenome", "aria-label": "Alignment subgenome",
        onchange: (event) => { state.alignmentSubgenome = event.target.value; renderResults(); },
      }, hm.subgenomes.map((value) => el("option", { value, selected: value === sg },
        `${value} · ${hm.homeolog_groups[homeologs.group][value].join(" / ")}`)));
      slotControl = el("div", { class: "alignment-slot" }, el("label", { for: "alignment-subgenome" }, "Compare copies in"), chooser);
    }
    const noGroupNote = hasGroup ? null : el("p", { class: "muted small" },
      homeologs.position_conflict ? `No subgenome group was assigned. ${plainNote(homeologs.note)}`
        : `No subgenome group was assigned (${homeologs.note || "not assigned"}).`);
    container.replaceChildren(...[slotControl, noGroupNote, content].filter(Boolean));
    let picker;
    picker = window.AlignmentSelection.render(content, {
      queryId: record.id, label: sg ? `${sg} · ${chromosomes.join(" / ")}` : "Query transcripts",
      members, selected: selection.selected,
      onGeneChange: (member, geneId) => {
        window.ProteinAlignmentView.close();
        selection.selected.delete(window.AlignmentSelection.key(member));
        selection.genes.set(member.genome, geneId);
        selection.includeOnLoad.add(member.genome);
        renderResults();
      },
      onSelectionChange: () => {
        window.ProteinAlignmentView.close();
        picker.output.replaceChildren(el("p", { class: "muted" }, "Selection changed. Run alignment to compare the selected transcripts."));
      },
      onTranscriptChange: (member, transcriptKey) => {
        window.ProteinAlignmentView.close();
        selection.transcripts.set(window.AlignmentSelection.key(member), transcriptKey);
        const next = member.transcripts.find((t) => t.transcript_key === transcriptKey);
        if (next?.protein_alignment_status !== "supported") selection.selected.delete(window.AlignmentSelection.key(member));
        else if (!member.available) selection.selected.add(window.AlignmentSelection.key(member));
        renderResults();
      },
      onRun: (selected) => window.ProteinAlignmentView.open({
        body: picker.output, dialog: null, members: selected, chromosomes,
        manifest: state.manifest, homeologs, queryGenome: genome, sequenceSource: transcriptSource,
        example: { subgenome: sg || "query", path: `${genome}_${record.id}_${sg || "query"}.json`, cds: true },
      }),
      onDetails: (member) => {
        if (member.review_cell) {
          openCellDetails(member.genome, "unassigned", member.review_cell);
        } else if (member.cell && (member.homeolog_selected || !member.gene_id)) {
          openCellDetails(member.genome, sg, member.cell);
        } else {
          const details = member.gene_id ? pairDetails(member.genome, member.gene_id) : {};
          if (details.hit || details.relation) openPairDetails(member.genome, member.gene_id);
          else openDialog(el("h2", {}, member.gene_id || member.genome),
            el("p", {}, member.gene_id ? "The query gene's annotated transcripts." : plainReason(member.reason)));
          if (member.candidate_source === "sequence_alternative") $("#dialog-body").append(el("p", { class: "note" },
            "This candidate is selected for alignment only. ", member.homeolog_reason ? `In the Homeologs view: ${plainReason(member.homeolog_reason)}` : "No subgenome assignment was recorded."));
        }
      },
    });
  } catch (error) {
    if (current()) container.replaceChildren(el("p", { class: "message error" }, notAvailable(error)));
  }
}

// ---- Results, views -------------------------------------------------------------------------------

function renderResults() {
  state.alignmentRenderSeq++;
  window.ProteinAlignmentView?.close();
  hideEvidenceTooltip();
  const results = $("#results");
  if (!state.record) { results.hidden = true; $("#legend").hidden = true; return; }
  results.hidden = false;
  $("#legend").hidden = false;
  if (state.view === "evidence") {
    results.replaceChildren(...[renderPerGenome(state.evidence === "related" ? relatedTable : hitsTable)].flat());
  } else if (state.view === "alignment") renderAlignmentView(results);
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
      el("p", { class: "group-summary" }, `${members.length} members across ${annotations} annotation${annotations === 1 ? "" : "s"} · reference annotation ${frame}`),
      el("p", { class: "muted small" }, "Standard member is a GENESPACE membership category, not a confidence score. Added via orthology means linked to the group's representative by OrthoFinder; it does not imply a direct match to every member."),
      el("div", { class: "table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Annotation", "Gene", "Chromosome", "Membership"].map((t) => el("th", {}, t)))),
        el("tbody", {}, orderedMembers.map((row) => el("tr", { class: isQuery(row) ? "query-member" : null },
          el("td", {}, genomeLabel(row[m.genome])),
          el("td", {}, geneLink(row[m.gene_id], row[m.genome]), isQuery(row) ? el("span", { class: "pill query-label" }, "Your query") : null),
          el("td", {}, row[m.chromosome]),
          el("td", {}, panGeneMemberLabel(row[m.flag]))))))),
      el("details", { class: "group-technical" },
        el("summary", {}, "Technical details"),
        el("p", { class: "muted small" }, `Run ${state.manifest.run} · reference annotation ${frame} · pgID ${pg}. Cite this combination; group numbers differ between reference annotations. Interpolated positions use gene order, not base pairs.`),
        el("div", { class: "table-wrap" }, el("table", {},
          el("thead", {}, el("tr", {}, ["Annotation", "Gene", "Original flag", "Interpolated chromosome", "Gene-order position"].map((t) => el("th", {}, t)))),
          el("tbody", {}, orderedMembers.map((row) => el("tr", { class: isQuery(row) ? "query-member" : null },
            el("td", {}, genomeLabel(row[m.genome])), el("td", {}, row[m.gene_id]), el("td", {}, row[m.flag]),
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

function homeologTsvRow(genome, subgenome, cell, homeologs) {
  const c = col.cell, conflict = homeologs.position_conflict, stretch = conflict?.stretch;
  const get = (name) => cell ? cell[c[name]] : null;
  const alternatives = (get('alternatives') || [])
    .map(([id, bits]) => `${id}:${bits ?? ''}`).join(';');
  const ownVotes = conflict?.votes === null ? ''
    : Object.entries(conflict?.votes || {}).map(([chr, count]) => `${chr}:${count}`).join(';');
  return [
    state.genome, state.record.id, genome, subgenome,
    get('role') || (conflict ? 'candidate' : ''), get('gene_id'),
    get('chromosome'), get('start'), get('end'), get('evidence'),
    get('state') || (conflict ? 'to_verify' : ''), get('identity_pct'),
    get('query_coverage_pct'), get('target_coverage_pct'), get('bitscore'), get('hit_rank'),
    get('n_alternatives'), alternatives, (get('flags') || []).join(';'),
    get('reason') || (conflict ? homeologs.note : ''),
    conflict || isToVerify(cell) ? 'to_verify' : '', conflict?.basis, conflict?.label,
    (conflict?.tied || (conflict ? [conflict.evidence] : [])).join(';'), ownVotes, conflict?.voting,
    stretch?.start, stretch?.end, stretch?.genes, stretch?.conflict_genes, state.homeologManifest.run,
    state.record.chr, state.record.s, state.record.e,
  ];
}

function currentResultTsv() {
  const h = col.hit, r = col.relation, genomes = shownGenomes(), lines = [];
  // 部分同源页有亚基因组预测时导出那张表；否则导出它退回显示的最佳匹配（加上全部相关基因）
  // Homeologs exports its subgenome table when there is one; otherwise the best-hit fallback it shows (plus all relations).
  const homeologTable = state.view === 'homeologs' && (state.homeologs?.t || state.homeologs?.position_conflict);
  const list = state.view === 'evidence' ? state.evidence : 'summary';
  if (homeologTable) {
    const hm = state.homeologManifest, homeologs = state.homeologs;
    lines.push([
      'query_genome', 'query_id', 'target_genome', 'subgenome', 'role', 'gene_id',
      'chromosome', 'start', 'end', 'evidence', 'state', 'identity_pct',
      'query_coverage_pct', 'target_coverage_pct', 'bitscore', 'hit_rank',
      'n_alternatives', 'alternatives', 'flags', 'reason',
      'query_position_status', 'conflict_basis', 'label_chromosome', 'evidence_chromosomes',
      'own_votes', 'voting_genomes', 'stretch_start', 'stretch_end', 'stretch_genes',
      'stretch_conflict_genes', 'run', 'query_chromosome', 'query_start', 'query_end',
    ]);
    for (const genome of genomes.filter((g) => hm.target_genomes.includes(g))) {
      const index = hm.target_genomes.indexOf(genome);
      if (homeologs.t) {
        homeologs.t[index].forEach((cell, i) =>
          lines.push(homeologTsvRow(genome, hm.subgenomes[i], cell, homeologs)));
      } else if (homeologs.position_conflict) {
        // An unassigned SG stays blank. Keep a row even when no candidate was stored.
        const cells = homeologs.candidates?.[index]?.[0] || [];
        if (cells.length) {
          cells.forEach((cell) => lines.push(homeologTsvRow(genome, '', cell, homeologs)));
        } else {
          lines.push(homeologTsvRow(genome, '', null, homeologs));
        }
      }
    }
  } else {
    lines.push([
      'query_genome', 'query_id', 'target_genome', 'kind', 'rank', 'target_id',
      'chromosome', 'start', 'end', 'protein_length', 'bitscore', 'evalue', 'identity_pct',
      'alignment_length', 'query_coverage_pct', 'target_coverage_pct',
      'synteny', 'orthofinder', 'shared_pan_gene', 'synteny_blocks', 'orthogroups', 'shared_pgids',
      'synteny_run', 'cross_synteny', 'cross_synteny_run', 'cross_synteny_blocks',
    ]);
    for (const genome of genomes) {
      const target = targetOf(genome);
      const hitRow = (hit, rank) => {
        // Relations carry block evidence even when the hit display is limited to the top N.
        const relation = target[col.target.relations].find((row) => row[r.target_id] === hit[h.target_id]);
        const groups = relation ? [...new Set(relation[r.orthology].map(([, og]) => og))].join(';') : '';
        const cross = evidenceField(hit, h, 'cross_synteny');
        return [
          state.genome, state.record.id, genome, 'hit', rank, hit[h.target_id],
          hit[h.chromosome], hit[h.start], hit[h.end], hit[h.protein_length],
          hit[h.bitscore], hit[h.evalue], hit[h.identity_pct], hit[h.alignment_length],
          hit[h.query_coverage_pct], hit[h.target_coverage_pct],
          hit[h.synteny], hit[h.orthofinder], hit[h.shared_pan_gene],
          blocksText(relation?.[r.synteny_blocks]), groups, relation?.[r.shared_pgids]?.join(';') || '',
          hit[h.synteny] ? syntenyRun() : '', cross, cross ? syntenyRun('cross_synteny') : '',
          blocksText(evidenceField(relation, r, 'cross_synteny_blocks', []), 'cross_synteny'),
        ];
      };
      if (list !== 'related') {
        if (target[col.target.self_hit]) lines.push(hitRow(target[col.target.self_hit], 'self'));
        const count = list === 'summary' ? 1 : state.top;
        target[col.target.hits].slice(0, count).forEach((hit, i) => lines.push(hitRow(hit, i + 1)));
      }
      if (list !== 'hits') {
        for (const relation of target[col.target.relations]) {
          const cross = evidenceField(relation, r, 'cross_synteny');
          lines.push([
            state.genome, state.record.id, genome, 'relation', relation[r.hit_rank], relation[r.target_id],
            relation[r.chromosome], relation[r.start], relation[r.end], relation[r.protein_length],
            relation[r.bitscore], relation[r.evalue], relation[r.identity_pct], relation[r.alignment_length],
            relation[r.query_coverage_pct], relation[r.target_coverage_pct],
            relation[r.synteny], relation[r.orthofinder], relation[r.shared_pgids].length ? 1 : 0,
            blocksText(relation[r.synteny_blocks]),
            [...new Set(relation[r.orthology].map(([, og]) => og))].join(';'),
            relation[r.shared_pgids].join(';'), relation[r.synteny] ? syntenyRun() : '',
            cross, cross ? syntenyRun('cross_synteny') : '',
            blocksText(evidenceField(relation, r, 'cross_synteny_blocks', []), 'cross_synteny'),
          ]);
        }
      }
    }
  }
  return lines.map((row) => row.map(tsvEscape).join('\t')).join('\n') + '\n';
}

function downloadCurrent() {
  if (!state.record) return;
  const blob = new Blob([currentResultTsv()], { type: "text/tab-separated-values" });
  const viewName = state.view === "evidence" ? `evidence_${state.evidence}` : state.view;
  const link = el("a", { href: URL.createObjectURL(blob), download: `${state.record.id.replace(/[^\w.-]+/g, "_")}_${viewName}.tsv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// 每个下载项一张卡片：路径、说明、是文件还是文件夹；首页和"数据"弹窗共用
// One tile per download: path, label, file or folder; shared by the start page and the Data panel.
// A folder cannot be downloaded as one URL: link it to the Hub's file browser (browseBase) instead.
function downloadTiles() {
  const base = CONFIG.downloadBase;
  const tiles = (CONFIG.downloads || []).map((d) => {
    const href = base ? (d.folder && CONFIG.browseBase ? CONFIG.browseBase : base) + d.path : null;
    return el("li", { class: `download-tile${d.folder ? " is-folder" : ""}` },
      el("span", { class: "download-icon", "aria-hidden": "true" }),
      el("div", { class: "download-body" },
        href ? el("a", { href, class: "download-path" }, d.path) : el("code", { class: "download-path" }, d.path),
        el("p", { class: "download-label" }, d.label),
        el("span", { class: "download-kind" }, d.folder ? "Folder · opens the file list" : "File · direct download")));
  });
  if (!base) tiles.push(el("li", { class: "muted" }, "Links are enabled once the data set is published; until then these files are on the cluster under results/."));
  return tiles;
}

// 页面底部的一条：下载按钮打开"数据"弹窗（下载都在那里），句末填上版本名和提交号
// The strip at the bottom: the Downloads button opens the Data panel (where the downloads are); the sentence ends
// with the release name and commit.
function renderDownloads() {
  const release = CONFIG.release || {}, commit = dataCommit();
  // 标点随界面语言：中文用全角逗号和句号，冒号后不空格 / punctuation follows the interface language: full-width comma and
  // full stop in Chinese, and no space after the colon
  const zh = I18N.lang === "zh";
  $("#data-band-release").replaceChildren(...[
    zh ? null : " ",
    release.tag ? [el("span", {}, "release"), " ", el("code", {}, release.tag)] : null,
    release.tag && commit ? (zh ? "，" : ", ") : null,
    commit ? [el("span", {}, "commit"), " ", el("code", {}, commit.slice(0, 8))] : null,
    zh ? "。" : ".",
  ].flat().filter(Boolean));
  $("#downloads-open").addEventListener("click", openDataInfo);
  $("#downloads").hidden = false;
}

// 首页的数据概览：数字直接取自这一版 06 的 manifest / Start-page figures, read from this release's step-06 manifest.
// 品种数和不同蛋白序列数不在 manifest 里，来自 config.js 的 stats（Tempest 上 validation/protein_stats_20261103 算的）
// Accessions and distinct protein sequences are not in the manifest; they come from CONFIG.stats (computed on
// Tempest in validation/protein_stats_20261103). Without them the searchable-ID count fills the slot.
// 每套注释的基因数范围（取到万位），比所有注释的总和更不容易误读成物种的基因数
// Genes per annotation as a range, to the nearest 10 k: harder to misread as the species' gene count than the sum.
function genesPerAnnotation(m) {
  const sizes = Object.entries(m.gene_key_ranges || {})
    .map(([genome, [first, last]]) => [genome, last - first + 1]).sort((a, b) => a[1] - b[1]);
  if (!sizes.length) return null;
  const [[smallest, low], [largest, high]] = [sizes[0], sizes[sizes.length - 1]];
  const tens = (n) => Math.round(n / 1e4) * 10;
  const int = (n) => n.toLocaleString("en-US");
  return [`${tens(low)}–${tens(high)} k`, "genes per annotation",
    `From ${int(low)} (${genomeLabel(smallest)}) to ${int(high)} (${genomeLabel(largest)}); click for every annotation`, "genome-sizes"];
}

// 点开"每套注释的基因数"后的明细：每套注释一条横条，按显示顺序（同一品种的几套挨在一起）
// The breakdown behind "genes per annotation": one bar per annotation, in display order (annotations of one
// accession side by side).
function renderGenomeSizes() {
  const m = state.manifest;
  const counts = displayGenomes().map((g) => [g, m.gene_key_ranges[g][1] - m.gene_key_ranges[g][0] + 1]);
  const largest = Math.max(...counts.map(([, n]) => n));
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  $("#genome-sizes").replaceChildren(
    el("div", { class: "panel-head" },
      el("strong", {}, "Genes per annotation"),
      el("span", {}, `${total.toLocaleString("en-US")} in all ${counts.length} annotations`)),
    el("ol", { class: "genome-size-list" }, counts.map(([g, n]) => el("li", {},
      el("span", { class: "genome-size-name" }, genomeLabel(g)),
      el("span", { class: "genome-size-bar", "aria-hidden": "true" }, el("i", { style: `width:${(100 * n / largest).toFixed(1)}%` })),
      el("span", { class: "genome-size-value" }, n.toLocaleString("en-US"))))),
    el("p", { class: "panel-note" }, "Every gene model of each annotation, including genes without a usable protein. "
      + "The annotations of one accession (DH55, Suneson) differ because they were made differently, not because the plants differ."));
}

// 家族的定义，按 OrthoFinder 的说法（来自同一个祖先基因的一组基因），并用一套注释里每个家族的基因数说明它不是部分同源组
// The definition of a family in OrthoFinder's terms (genes descending from one ancestral gene), with the genes of one
// annotation per family to show that it is not a homeolog group.
function familyDefinition(f) {
  const int = (x) => x.toLocaleString("en-US");
  const per = f.genesPerFamily;
  const share = (k) => Math.round(100 * per.counts[k] / per.families);
  const name = genomeLabel(per.genome);
  return el("p", { class: "panel-note" }, `A family is an OrthoFinder orthogroup: genes that OrthoFinder groups as descending `
    + `from one ancestral gene, judged by protein similarity across the ${state.manifest.target_genomes.length} annotations. `
    + `It is not a homeolog group: in ${name}, ${share("1")}% of the families that contain a ${name} gene hold one such gene, `
    + `${share("2")}% two, ${share("3")}% three and ${share("4+")}% four or more, so the three subgenome copies of a locus `
    + `are often in different families; the groups G1–G7 above are a chromosome map, not a similarity cluster. `
    + `${int(f.unassignedGenes)} genes were not placed in any family.`);
}

// 点开"基因家族"后的分布：每个家族（OrthoFinder 同源组）出现在 14 个品种中的几个（同一品种的几套注释合并）
// The breakdown behind "gene families": in how many of the 14 accessions each family (OrthoFinder orthogroup)
// occurs, the annotations of one accession merged.
function renderFamilySharing() {
  const f = CONFIG.stats.geneFamilies, counts = f.byAccessions, n = counts.length;
  const int = (x) => x.toLocaleString("en-US");
  const share = (x) => `${(100 * x / f.families).toFixed(1)}%`;
  const axisMax = Math.ceil(Math.max(...counts) / 10000) * 10000;
  const ticks = [axisMax, axisMax / 2, 0];
  const labelled = new Set([1, 2, n]);          // the two variable columns and the core one carry their values
  const describe = (k, x) => `${k === 1 ? "In 1 accession only" : k === n ? `In all ${n} accessions (core)` : `In ${k} accessions`}: `
    + `${int(x)} families (${share(x)})`;
  const tip = el("div", { class: "sharing-tip", hidden: true });
  const columns = `grid-template-columns: repeat(${n}, minmax(0, 1fr))`;
  const plot = el("div", { class: "sharing-plot", style: columns, role: "group", "aria-label": "Gene families by the number of accessions that have them" });
  const show = (column, text) => {
    tip.textContent = text;
    tip.hidden = false;
    const half = tip.offsetWidth / 2, centre = column.offsetLeft + column.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(centre, half), plot.clientWidth - half)}px`;   // keep it inside the plot
  };
  const hide = () => { tip.hidden = true; };
  plot.append(el("div", { class: "sharing-grid", "aria-hidden": "true" }, ticks.map(() => el("i"))),
    ...counts.map((x, i) => {
      const k = i + 1, text = describe(k, x);
      return el("div", { class: "sharing-col", tabindex: "0", "aria-label": text,
          onmouseenter: (event) => show(event.currentTarget, text), onmouseleave: hide,
          onfocus: (event) => show(event.currentTarget, text), onblur: hide },
        el("span", { class: "sharing-bar", style: `height:${(100 * x / axisMax).toFixed(1)}%` },
          labelled.has(k) ? el("span", { class: `bar-label${k === n ? "" : " bar-label-minor"}`, "aria-hidden": "true" }, int(x)) : null));
    }), tip);
  $("#family-sharing").replaceChildren(
    el("div", { class: "panel-head" },
      el("strong", {}, "How many accessions share each gene family"),
      el("span", {}, `${int(f.families)} families from ${int(f.genes)} genes`)),
    el("div", { class: "sharing-chart" },
      el("div", { class: "sharing-axis", "aria-hidden": "true" }, ticks.map((t) => el("span", {}, t ? `${t / 1000}K` : "0"))),
      plot,
      el("div", { class: "sharing-xticks", style: columns, "aria-hidden": "true" }, counts.map((_, i) => el("span", {}, i + 1)))),
    el("p", { class: "sharing-xlabel" }, `Number of accessions with the family (of ${n})`),
    el("p", { class: "panel-note" }, `${int(counts[n - 1])} families (${int(f.coreGenes)} genes, `
      + `${Math.round(100 * f.coreGenes / f.genes)}% of the genes in families) occur in all ${n} accessions. `
      + `Most families seen in only one or two accessions involve only DH55 and Suneson, the two accessions with annotations `
      + `made outside the JGI pipeline: ${int(f.onlySuneson)} are only in Suneson, ${int(f.onlyDH55)} only in DH55 and `
      + `${int(f.onlyDH55AndSuneson)} only in DH55 and Suneson, and ${int(f.withoutJgiPipeline)} of them contain no gene from a `
      + `JGI-pipeline annotation. The ${f.jgiOnlyAccessions} accessions annotated only by the JGI pipeline have `
      + `0–${f.jgiOnlySpecificMax} accession-specific families each. These columns therefore mostly reflect how the annotations `
      + `were made.`),
    familyDefinition(f),
    el("details", { class: "sharing-table" }, el("summary", {}, "Show the numbers as a table"),
      el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "Accessions"), el("th", {}, "Gene families"), el("th", {}, "Share"))),
        el("tbody", {}, counts.map((x, i) => el("tr", {},
          el("td", {}, i + 1), el("td", { class: "num" }, int(x)), el("td", { class: "num" }, share(x))))))));
}

// 点开"18 annotations"或"14 accessions"后的表：每套注释一行，按品种分组。数字来自 Tempest 上算好并核对过的
// data/annotation_stats.json（validation/annotation_stats_20261103，16 项核对）；来源文字在 config.js 的
// annotationSources 里手工维护，null 表示还没补。
// The table behind "18 annotations" and "14 accessions": one row per annotation, grouped by accession. The numbers
// come from data/annotation_stats.json, computed and checked on Tempest (validation/annotation_stats_20261103,
// 16 checks); the source texts are kept by hand in CONFIG.annotationSources, null meaning not yet supplied.
let annotationStats = null;
let assemblyStats = null;

// 按注释 ID 和组装版本核对，再连接 N50；数组顺序不参与匹配。
// Match the annotation IDs and assembly versions before joining N50 values; array order is irrelevant.
async function loadAssemblyStats(annotations) {
  const response = await fetch(new URL(CONFIG.assemblyStats, document.baseURI), { cache: "no-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (data.gap_rule !== "a run of >= 10 N splits a scaffold") {
    throw new Error("the assembly gap rule differs from the displayed definition");
  }
  const expected = new Map(annotations.map((a) => [a.genome, a.assembly_version]));
  if (!Array.isArray(data.assemblies) || data.assemblies.length !== expected.size) {
    throw new Error("the assembly list differs from the annotations");
  }
  const seen = new Set();
  for (const row of data.assemblies) {
    if (seen.has(row.genome) || !expected.has(row.genome)
      || row.assembly_version !== expected.get(row.genome)) {
      throw new Error("the assembly IDs or versions differ from the annotations");
    }
    for (const key of ["contig_n50", "scaffold_n50", "contigs", "sequences", "total_bp"]) {
      if (!Number.isSafeInteger(row[key]) || row[key] <= 0) {
        throw new Error(`invalid ${key} for ${row.genome}`);
      }
    }
    // gap 和未挂载序列可以是 0，但不能为负或超过组装总长；拼接说明的三段文字都要有
    // Gaps and unplaced sequences may be 0, never negative or longer than the assembly; the build note needs all three texts
    for (const key of ["gaps", "gap_bp", "unplaced_sequences", "unplaced_bp"]) {
      if (!Number.isSafeInteger(row[key]) || row[key] < 0 || (key.endsWith("_bp") && row[key] > row.total_bp)) {
        throw new Error(`invalid ${key} for ${row.genome}`);
      }
    }
    if (!["basis", "method", "source"].every((key) => typeof row.scaffolding?.[key] === "string" && row.scaffolding[key])) {
      throw new Error(`missing chromosome-build note for ${row.genome}`);
    }
    seen.add(row.genome);
  }
  return data;
}

async function renderAnnotationSources() {
  const panel = $("#annotation-sources");
  if (!annotationStats) {
    panel.replaceChildren(el("p", { class: "panel-note" }, "Loading the annotation figures…"));
    try {
      const response = await fetch(new URL(CONFIG.annotationStats, document.baseURI), { cache: "no-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      annotationStats = await response.json();
    } catch (error) {
      panel.dataset.failed = "true";      // 再次打开时重试 / reopening the panel tries again
      panel.replaceChildren(el("p", { class: "panel-note" },
        `The annotation figures could not be loaded (${error.message}). Close and reopen this panel to try again.`));
      return;
    }
  }
  delete panel.dataset.failed;
  // N50 加载失败仍保留注释表；重新打开面板时重试。
  // Keep the annotation table available if N50 cannot load; reopening retries the assembly file.
  let assemblyError = null;
  if (CONFIG.assemblyStats && !assemblyStats) {
    try {
      assemblyStats = await loadAssemblyStats(annotationStats.annotations);
    } catch (error) {
      assemblyError = error.message;
      panel.dataset.failed = "true";
    }
  }
  const assemblies = new Map((assemblyStats?.assemblies || []).map((a) => [a.genome, a]));
  const data = annotationStats, sources = CONFIG.annotationSources || {};
  const int = (n) => n.toLocaleString("en-US");
  const mb = (bp) => (bp / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // 组装大小和 gap 总长用合适的单位，最多一位小数（500 kb 而不是 500.0 kb）
  // Assembly and gap lengths in a readable unit, at most one decimal (500 kb rather than 500.0 kb)
  const oneDecimal = (x) => x.toLocaleString("en-US", { maximumFractionDigits: 1 });
  const sizeText = (bp) => bp >= 1e6 ? `${oneDecimal(bp / 1e6)} Mb` : bp >= 1e3 ? `${oneDecimal(bp / 1e3)} kb` : `${int(bp)} bp`;
  // 没到 100% 的比例不四舍五入成 100%，很小的比例多留一位 / a share short of 100% never shows as 100%; small ones get two decimals
  const share = (part, whole) => {
    const p = 100 * part / whole;
    return `${p === 100 ? "100" : p >= 99.95 || p < 1 ? p.toFixed(2) : p.toFixed(1)}%`;
  };
  const pct = (x) => `${x.toFixed(1)}%`;

  // 按显示顺序分组：DH55 两套、Suneson 四套，其余每个品种一套 / grouped in display order: DH55 two, Suneson four, the rest one each
  const byGenome = new Map(data.annotations.map((a) => [a.genome, a]));
  const groups = [];
  for (const genome of displayGenomes().filter((g) => byGenome.has(g))) {
    const a = byGenome.get(genome);
    let group = groups.find((x) => x.accession === a.accession);
    if (!group) groups.push(group = { accession: a.accession, rows: [] });
    group.rows.push(a);
  }

  // 还没补的来源信息：缺来源的写在格子里，其余汇总成表下一行，补齐后自动消失
  // Source details not yet supplied: a missing source shows in its cell; the rest are listed once under the table
  // and the line disappears when they are filled in.
  const todo = { source: [], status: [] };
  const link = (label, href) => el("a", { href, target: "_blank", rel: "noopener" }, label);
  const sourceLine = (a) => {
    const s = sources[a.genome] || sources.jgiPangenome || {};
    if (!s.source) todo.source.push(genomeLabel(a.genome));
    if ("status" in s && !s.status) todo.status.push(genomeLabel(a.genome));
    const parts = [s.source ? el("span", {}, s.source) : el("span", { class: "ann-pending" }, "source to be added")];
    for (const [label, href] of s.links || []) parts.push(link(label, href));
    const page = sources.phytozome?.[a.genome];          // the annotation's own Phytozome page
    if (page) parts.push(link("Phytozome", `https://phytozome-next.jgi.doe.gov/info/${page}`));
    if (s.status) parts.push(el("span", {}, s.status));
    if (s.note) parts.push(el("span", {}, s.note));
    if (s.sameAssemblyAs) parts.push(el("span", {}, `same assembly as ${genomeLabel(s.sameAssemblyAs)}`));
    return el("div", { class: "ann-source" },
      parts.flatMap((part, i) => i ? [el("span", { class: "ann-sep", "aria-hidden": "true" }, "·"), part] : [part]));
  };

  const columnCount = 10;
  const head = el("thead", {},
    el("tr", {},
      el("th", { scope: "col", rowspan: 2 }, "Accession"),
      el("th", { scope: "col", rowspan: 2 }, "Annotation and source"),
      el("th", { scope: "col", rowspan: 2, class: "num" }, "Genes"),
      el("th", { scope: "col", rowspan: 2, class: "num",
        title: "Contig continuity after splitting at runs of at least 10 N; see the definition below" },
        "Contig ", el("span", { class: "nowrap" }, "N50 (Mb)")),
      el("th", { scope: "col", rowspan: 2, class: "num" }, "On ", el("span", { class: "nowrap" }, "Chr01–Chr20")),
      el("th", { scope: "col", rowspan: 2, class: "num" }, "Not in an ", el("span", { class: "nowrap" }, "orthogroup")),
      el("th", { scope: "col", rowspan: 2, class: "num" }, "Position to verify"),
      el("th", { scope: "colgroup", colspan: 2, class: "ann-busco-head" }, "BUSCO"),
      el("th", { scope: "col", rowspan: 2 }, el("span", { class: "visually-hidden" }, "Details"))),
    el("tr", {},
      el("th", { scope: "col", class: "num", title: "Complete" }, "C"),
      el("th", { scope: "col", class: "num", title: "Missing" }, "M")));
  const tbodies = groups.map((group) => {
    const size = group.rows.length;
    return el("tbody", { class: `ann-group${size > 1 ? " is-multi" : ""}` }, group.rows.flatMap((a, i) => {
      const b = a.busco, c = b.complete_copies, detailId = `ann-detail-${a.genome}`;
      const assembly = assemblies.get(a.genome);
      const row = el("tr", { class: "ann-row" },
        // 同组后面几行的品种名只给读屏软件 / later rows of a group carry the accession for screen readers only
        el("td", { class: `ann-accession${i ? " is-continued" : ""}${size === 1 ? " is-single" : ""}` },
          i ? el("span", { class: "visually-hidden" }, group.accession)
            : [el("span", {}, group.accession), size > 1 ? el("small", {}, `${size} annotations`) : null]),
        el("th", { scope: "row", class: "ann-cell" },
          el("div", { class: "ann-name" }, genomeLabel(a.genome)),
          sourceLine(a),
          // 版本号整段不断行（里面的连字符不是断点）/ each version stays on one line (its hyphens are no break points)
          el("div", { class: "ann-version" }, "Assembly ", el("span", { class: "nowrap" }, a.assembly_version),
            " · annotation ", el("span", { class: "nowrap" }, a.annotation_version)),
          // 染色体怎么拼的：自己的 Hi-C 或遗传图谱，或按另一个基因组的共线性排；悬停看完整方法
          // How the chromosomes were built: own Hi-C or genetic map, or ordered by synteny to another genome; hover for the method
          assembly ? el("div", { class: "ann-build", title: assembly.scaffolding.method },
            "Chromosomes: ", assembly.scaffolding.basis) : null),
        el("td", { class: "num", "data-label": "Genes" }, int(a.genes)),
        el("td", { class: "num ann-n50", "data-label": "Contig N50 (Mb)",
          title: assembly ? `${int(assembly.contig_n50)} bp; recomputed from the assembly FASTA` : "Assembly figures unavailable" },
          assembly ? mb(assembly.contig_n50) : "Unavailable"),
        // data-label 是手机卡片上的短标签（桌面用表头）/ data-label is the short label on phone cards (desktop uses the header)
        el("td", { class: "num", "data-label": "On Chr01–20", title: `${int(a.on_chr01_chr20)} of ${int(a.genes)} genes` },
          share(a.on_chr01_chr20, a.genes)),
        el("td", { class: "num", "data-label": "Not in orthogroup",
            title: `${int(a.unassigned)} of ${int(a.analysed)} analysed genes` },
          int(a.unassigned), el("small", {}, share(a.unassigned, a.analysed))),
        el("td", { class: "num", "data-label": "To verify" }, int(a.to_verify),
          // 网页统一叫 Gene vote / Region context（下载表格里 basis 仍是 vote / stretch）
          // The site says Gene vote / Region context (the downloaded tables keep basis vote / stretch)
          el("small", {}, `${int(a.to_verify_own_evidence)} by gene · ${int(a.to_verify_stretch_context)} by region`)),
        el("td", { class: "num ann-busco", "data-label": "BUSCO C" }, pct(b.C)),
        el("td", { class: "num ann-busco", "data-label": "BUSCO M" }, pct(b.M)),
        el("td", { class: "ann-toggle-cell" },
          el("button", { type: "button", class: "ann-toggle", "aria-expanded": "false", "aria-controls": detailId,
            "aria-label": `Details for ${genomeLabel(a.genome)}`,
            onclick: (event) => {
              const open = event.currentTarget.getAttribute("aria-expanded") !== "true";
              event.currentTarget.setAttribute("aria-expanded", String(open));
              document.getElementById(detailId).hidden = !open;
            } }, "Details")));
      const detail = el("tr", { class: "ann-detail", id: detailId, hidden: true },
        el("td", { class: "ann-accession is-continued" }),
        el("td", { colspan: columnCount - 1 },
          el("dl", { class: "ann-detail-list" },
            // 组装三项：大小和挂载、连续性、染色体怎么拼的 / Assembly: size and placement, continuity, chromosome build
            assembly ? [
              el("dt", {}, "Assembly"),
              el("dd", {}, `${sizeText(assembly.total_bp)} in ${int(assembly.sequences)} sequences (FASTA records); `
                + (assembly.unplaced_sequences
                  ? `${share(assembly.total_bp - assembly.unplaced_bp, assembly.total_bp)} on Chr01–Chr20, `
                    + `${sizeText(assembly.unplaced_bp)} on ${int(assembly.unplaced_sequences)} other `
                    + (assembly.unplaced_sequences === 1 ? "sequence" : "sequences")
                  : "all on Chr01–Chr20")),
              el("dt", {}, "Assembly continuity"),
              el("dd", {}, `Contig N50 ${int(assembly.contig_n50)} bp (${mb(assembly.contig_n50)} Mb); `
                + `scaffold N50 ${int(assembly.scaffold_n50)} bp (${mb(assembly.scaffold_n50)} Mb). `
                + `${int(assembly.gaps)} ${assembly.gaps === 1 ? "gap" : "gaps"} of 10 or more N (${sizeText(assembly.gap_bp)} in all); `
                + `${int(assembly.contigs)} contigs after splitting at them.`),
              el("dt", {}, "Chromosomes built"),
              el("dd", {}, `${assembly.scaffolding.method}. Source: ${assembly.scaffolding.source}.`),
            ] : [
              el("dt", {}, "Assembly"),
              el("dd", {}, "Assembly figures are currently unavailable."),
            ],
            el("dt", {}, `BUSCO (n = ${int(b.n)})`),
            el("dd", {}, `C ${pct(b.C)} (S ${pct(b.S)} + D ${pct(b.D)}) · F ${pct(b.F)} · M ${pct(b.M)}`),
            el("dt", {}, "Complete copies per complete BUSCO"),
            el("dd", {}, `1 copy ${int(c["1"])} · 2 copies ${int(c["2"])} · 3 copies ${int(c["3"])} · 4 or more ${int(c["4+"])}`),
            el("dt", {}, "Genes"),
            el("dd", {}, `${int(a.genes)} in all; ${int(a.analysed)} analysed (on Chr01–Chr20 with a usable protein); `
              + `not analysed: ${int(a.off_chr01_chr20)} with a protein off Chr01–Chr20, `
              + `${int(a.no_usable_protein)} without a usable protein`),
            el("dt", {}, "Not in an orthogroup"),
            el("dd", {}, `${int(a.unassigned)} of ${int(a.analysed)} analysed genes (${share(a.unassigned, a.analysed)})`),
            el("dt", {}, "Position to verify"),
            el("dd", {}, `${int(a.to_verify)}: ${int(a.to_verify_own_evidence)} by gene, `
              + `${int(a.to_verify_stretch_context)} by region`))));
      return [row, detail];
    }));
  });

  const definitions = [
    ["Contig N50", "At least half of the total contig length is in segments this long or longer. Values are recomputed "
      + "from the assembly FASTA by splitting at runs of at least 10 N; runs of 1–9 N remain inside segments. "
      + "Mb means 1,000,000 bp. This measures continuity, not base accuracy or whether joins are correct. "
      + "Scaffold N50 in Details uses whole FASTA records, including gaps."],
    ["Chromosomes", "How the contigs were joined into Chr01–Chr20: with the accession's own Hi-C contacts or a genetic "
      + "map, or by synteny to another genome (Prytzh or DH55). In an assembly ordered by synteny, the chromosome-scale "
      + "order is taken from that genome, so agreement with that genome is not independent evidence. Details give the "
      + "method, its source, the assembly size and how much of it lies outside Chr01–Chr20."],
    ["On Chr01–Chr20", "Genes placed on the 20 chromosomes. Placement is needed for a homeolog prediction but does not "
      + "guarantee one: a placed gene can lack a usable protein, fall below the evidence thresholds or have a position to verify."],
    ["Not in an orthogroup", "Analysed genes (on Chr01–Chr20 with a usable protein) that this OrthoFinder run placed in no "
      + "orthogroup, with their share of the analysed genes. This does not mean that other annotations lack similar "
      + "sequences, and it is not by itself evidence of a wrong gene model."],
    ["Position to verify", "Genes whose chromosome disagrees with the other annotations, either the gene itself or the "
      + "genes around it (rules in Data and methods). A flag asks for a check; it does not prove the position wrong. The "
      + "assembly may be misjoined, the accession may carry a real rearrangement, or the annotations that disagree may "
      + "share one layout (11 JGI assemblies were ordered on Prytzh)."],
    ["BUSCO", `BUSCO ${data.busco.version} in protein mode with ${data.busco.lineage} (${int(data.busco.markers)} conserved `
      + "genes), one representative protein per gene, the same for every annotation. C complete, M missing; Details add "
      + "S single-copy, D duplicated, F fragmented and the number of complete copies. In this hexaploid a high D is "
      + "expected; a high C does not show that all three subgenome copies are complete."],
  ];
  panel.replaceChildren(...[
    el("div", { class: "panel-head" },
      el("strong", {}, "Annotations and sources"),
      el("span", {}, `${data.annotations.length} annotations of ${groups.length} accessions · data release ${data.run}`)),
    assemblyError ? el("p", { class: "panel-note" },
      `Assembly figures could not be loaded (${assemblyError}). N50 is unavailable; close and reopen this panel to retry.`) : null,
    el("div", { class: "ann-table-wrap" }, el("table", { class: "ann-table" }, head, tbodies)),
    todoLine(todo),
    el("dl", { class: "ann-definitions" }, definitions.map(([term, text]) => el("div", {}, el("dt", {}, term), el("dd", {}, text)))),
    sources.credits ? el("p", { class: "panel-note" }, sources.credits) : null,
    el("p", { class: "panel-note" }, "When annotations disagree, these figures give background only; judge a specific gene "
      + "by its coverage, synteny and gene-model structure. The numbers: ",
      el("a", { href: CONFIG.annotationStats, download: "annotation_stats.json" }, "annotation_stats.json"),
      assemblyStats ? [" · ", el("a", { href: CONFIG.assemblyStats, download: "assembly_stats.json" }, "assembly_stats.json")] : null, "."),
  ].filter(Boolean));
}

// 表下一行：还没补的来源信息 / One line under the table: the source details still to be supplied
function todoLine(todo) {
  const items = [];
  if (todo.source.length) items.push(`the source of ${todo.source.join(", ")}`);
  if (todo.status.length) items.push(`the publication status of ${todo.status.join(", ")}`);
  if (!items.length) return null;
  const list = items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0];
  return el("p", { class: "ann-todo" }, `Still to be added: ${list}.`);
}

// 首页数字下面的明细面板，同一时间只开一个 / The breakdown panels under the start-page figures, one open at a time
const STAT_PANELS = {
  "annotation-sources": renderAnnotationSources,
  "genome-sizes": renderGenomeSizes,
  "family-sharing": renderFamilySharing,
};

// "18 annotations" 和 "14 accessions" 共用一个面板，两格一起显示展开状态
// "18 annotations" and "14 accessions" share one panel; both figures show its open state.
function toggleStatPanel(button) {
  const id = button.getAttribute("aria-controls");
  const panel = document.getElementById(id);
  const open = panel.hidden;
  for (const other of document.querySelectorAll(".stat-toggle")) {
    const otherId = other.getAttribute("aria-controls");
    if (otherId !== id) document.getElementById(otherId).hidden = true;
    other.setAttribute("aria-expanded", String(open && otherId === id));
  }
  if (open && (!panel.childElementCount || panel.dataset.failed)) STAT_PANELS[id]();
  panel.hidden = !open;
}

function renderStats() {
  const m = state.manifest, s = CONFIG.stats || {};
  const compact = (n) => n >= 1e7 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e6 ? `${(n / 1e6).toFixed(2)} M`
    : n >= 1e5 ? `${Math.round(n / 1e3)} k` : n.toLocaleString("en-US");
  const int = (n) => n.toLocaleString("en-US");
  const sourcesPanel = CONFIG.annotationStats ? "annotation-sources" : null;
  const stats = [
    [m.target_genomes.length, "annotations", s.accessions ? `${m.target_genomes.length} annotations of ${s.accessions} `
      + "accessions; click for their sources, BUSCO and placement" : null, sourcesPanel],
    s.accessions ? [s.accessions, "accessions", "DH55 has two annotations and Suneson four; every other accession has one. "
      + "Click for the table", sourcesPanel] : null,
    genesPerAnnotation(m),
    s.geneFamilies
      ? [`${(s.geneFamilies.families / 1000).toFixed(1)} k`, "gene families",
         `${int(s.geneFamilies.families)} OrthoFinder gene families; ${int(s.geneFamilies.byAccessions.at(-1))} occur in all `
         + `${s.geneFamilies.byAccessions.length} accessions. Click for the distribution`, "family-sharing"]
      : m.counts?.ids ? [compact(m.counts.ids), "searchable IDs", "gene, transcript and protein IDs"] : null,
  ].filter(Boolean);
  // 有明细的数字做成按钮，点开下面的面板 / Figures with a breakdown are buttons that open their panel below
  $("#hero-stats").replaceChildren(...stats.map(([value, label, note, panel]) => panel
    ? el("button", { type: "button", class: "stat stat-toggle", title: note || null, "aria-expanded": "false",
        "aria-controls": panel, onclick: (event) => toggleStatPanel(event.currentTarget) },
        el("span", { class: "stat-value" }, String(value)),
        el("span", { class: "stat-label" }, label, el("span", { class: "stat-chevron", "aria-hidden": "true" }, "▾")))
    : el("div", { class: "stat", title: note || null },
        el("span", { class: "stat-value" }, String(value)), el("span", { class: "stat-label" }, label))));
}

// 首页和结果页两种布局：有查询时大标题区收成一条搜索栏 / Two layouts: with a query, the hero shrinks to a search bar.
function setPageMode(query) {
  document.body.classList.toggle("is-query", query);
  document.body.classList.toggle("is-home", !query);
}

// 亮色/暗色切换，只记在本浏览器里 / Light or dark colours, remembered in this browser only.
function setupThemeToggle() {
  const current = () => document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  $("#theme-toggle").addEventListener("click", () => {
    const next = current() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("pangene-theme", next); } catch (error) { /* private mode: keep it for this page only */ }
  });
}

// 页内导航只滚动，不改地址栏，免得清掉当前的查询 / In-page links scroll without touching the hash, which holds the query.
function setupPageLinks() {
  for (const link of document.querySelectorAll(".skip-link")) {
    link.addEventListener("click", (event) => {
      const target = document.querySelector(link.getAttribute("href"));
      if (!target) return;
      event.preventDefault();
      if (target.hidden || !target.offsetParent) return;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      if (link.classList.contains("skip-link")) target.focus({ preventScroll: true });
    });
  }
  $("#home-link").addEventListener("click", (event) => {
    event.preventDefault();
    if (location.hash) location.hash = ""; else window.scrollTo({ top: 0, behavior: "smooth" });
  });
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
      "A transcript or protein ID finds its parent gene. Protein comparisons use one representative protein per gene.",
      `Protein hits are ranked by bit score. Each search reports up to ${m.search_max_hits} targets; supplementary searches may add further candidates.`,
      "Related genes includes all stored syntenic and OrthoFinder partners, including those outside the displayed top hits.",
      syntenyRun("cross_synteny") ? "Same-chromosome synteny and cross-chromosome synteny are reported separately with their source runs. Cross-chromosome relationships do not by themselves establish orthology or translocation. Shared pan-gene membership is not direct pairwise synteny." : "Direct synteny was evaluated between same-numbered chromosomes. Shared pan-gene membership does not imply direct synteny between every pair of members.",
      "Genes flagged to verify keep their original position. The flag asks for a check; it does not correct the assembly.",
      // Rules as in step 07 (CONFLICT_MIN_VOTES 3, identity 99, coverage 80, STRETCH_MAX_GAP 20, STRETCH_MIN_SHARE 0.5)
      "To verify, by gene: each other annotation votes for the chromosome of the gene's best syntenic partner there; a partner on another chromosome counts only at ≥99% identity and ≥80% coverage. The gene is flagged when more than half of the votes go to other chromosomes, at least 3 to the same one. To verify, by region: a gene inside a run of such genes (at least 3 toward the same chromosome, at most 20 genes apart, at least half of the genes in the run) is flagged with the run, whatever its own result. Downloaded tables write these two cases as vote and stretch.",
      "Consider sequence identity and coverage together. A short, high-identity match requires review of the gene models.",
      "Homeolog assignments are computational predictions. Cross-checked means the protein match agrees with a second check: a reverse match within the annotation, or a path through the query's homeolog in the same annotation. The two checks share input data, so this is not independent validation. A missing match does not prove that a gene is absent.",
    ].map((note) => el("li", {}, note))),
    el("details", { class: "group-technical data-provenance" },
      el("summary", {}, "Data version details"),
      el("dl", { class: "details" },
        row("Analysis ID", m.run),
        row("Protein-hit data exported", m.created_utc.slice(0, 10)),
        m.id_index_updated_utc ? row("ID index updated", m.id_index_updated_utc.slice(0, 10)) : null,
        row("Homeolog data exported", hm ? hm.created_utc.slice(0, 10) : homeologNote),
        row("Source database SHA-256", el("code", {}, m.source_database_sha256)),
        row("Evidence identifiers", "Orthogroups are identified by the analysis ID and group name. Pan-gene groups also require the reference annotation and group number."))),
  );
}

// ---- The seven homeolog groups / 七个部分同源组 ------------------------------------------------------

// 亚基因组命名和分组的出处（Chaudhary 2020 的命名；分组与 Martin 2022 表 4 的祖先区块表一致，2026-11-04 对过原文）
// Sources of the subgenome names and the groups (names of Chaudhary 2020; groups as in the ancestral-block table,
// Table 4, of Martin 2022; both checked against the papers on 2026-11-04)
const SUBGENOME_SOURCES = "Chaudhary et al. 2020 (G3 10:1297); homeolog groups as in Martin et al. 2022 (G3 12:jkac182, Table 4)";

// 首页染色体图下的对照表：每组在三个亚基因组上的染色体，直接取自部分同源数据（homeologs/manifest.json）；
// 出现在两个组里的是复合染色体，标 *；G2 一行对应图里的虚线弧
// The table under the start-page chromosome figure: each group's chromosomes on the three subgenomes, read from the
// homeolog data (homeologs/manifest.json). A chromosome in two groups is composite and gets a *; the G2 row is the
// group the figure's dotted arcs join.
function renderHomeologGroups() {
  const box = $("#karyo-groups"), hm = state.homeologManifest;
  if (!box || !hm?.homeolog_groups) return;
  const groups = Object.entries(hm.homeolog_groups);
  // 每条染色体属于哪些组；在两个组里的是复合染色体 / the group(s) of each chromosome; one in two groups is composite
  const groupsOf = new Map();
  for (const [name, slots] of groups) {
    for (const chromosomes of Object.values(slots)) {
      for (const c of chromosomes) groupsOf.set(c, [...(groupsOf.get(c) || []), name]);
    }
  }
  state.homeologGroupsOf = groupsOf;
  // el() 只展开一层数组，所以这里用 flatMap 摊平 / el() flattens one level only, hence flatMap
  const cell = (chromosomes) => [...chromosomes].sort().flatMap((c, i) =>
    [i ? ", " : "", c, groupsOf.get(c).length > 1 ? el("sup", {}, "*") : null]);
  const link = (label, doi) => el("a", { href: `https://doi.org/${doi}`, target: "_blank", rel: "noopener" }, label);
  // 整行可点；行首的按钮给键盘和读屏用 / the whole row is clickable; the button in its header serves keyboards and screen readers
  const rows = groups.map(([name, slots]) => el("tr", { "data-group": name, onclick: () => selectHomeologGroup(name) },
    el("th", { scope: "row" }, el("button", { type: "button", class: "group-pick", "aria-pressed": "false",
      "aria-label": `Show ${name} in the figure` }, name)),
    hm.subgenomes.map((sg) => el("td", {}, cell(slots[sg] || [])))));
  box.replaceChildren(el("details", { open: true },
    el("summary", {}, "The seven homeolog groups"),
    el("table", { class: "karyo-group-table" },
      el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Group"),
        hm.subgenomes.map((sg) => el("th", { scope: "col" },
          el("span", { class: `sg-dot sg-${sg.toLowerCase()}`, "aria-hidden": "true" }), sg)))),
      el("tbody", {}, rows)),
    el("p", {}, "* Composite chromosome: one segment in each of two groups."),
    el("p", {}, "Sources: ", link("Martin et al. 2022, Table 4 (groups)", "10.1093/g3journal/jkac182"), " · ",
      link("Chaudhary et al. 2020 (subgenome names)", "10.1534/g3.119.400957"))));
  box.hidden = false;
  // 点图里的染色体：选它所在的组；复合染色体再点一次换到它的另一个组
  // A chromosome in the figure selects its group; clicking a composite one again switches to its other group.
  for (const rect of document.querySelectorAll("#karyo-figure rect[data-chr]")) {
    rect.addEventListener("click", () => {
      const options = groupsOf.get(rect.dataset.chr) || [];
      if (options.length) selectHomeologGroup(options[(options.indexOf(state.homeologGroup) + 1) % options.length]);
    });
  }
  selectHomeologGroup("G2");
}

// 在图里标出一个部分同源组：亮起它的染色体（复合染色体加虚线框，因为只有一段属于这个组），其余变淡，再画出连接它们的弧线
// Show one homeolog group in the figure: its chromosomes light up (a composite one gets a dashed outline, since only
// one segment belongs to the group), the rest fade, and arcs join SG1 to SG2 and SG2 to SG3.
function selectHomeologGroup(name) {
  const slots = state.homeologManifest?.homeolog_groups?.[name], svg = $("#karyo-figure");
  if (!slots || !svg) return;
  state.homeologGroup = name;
  const groupsOf = state.homeologGroupsOf || new Map();
  for (const tr of document.querySelectorAll(".karyo-group-table tbody tr")) {
    const on = tr.dataset.group === name;
    tr.classList.toggle("is-linked", on);
    tr.querySelector(".group-pick")?.setAttribute("aria-pressed", String(on));
  }
  const members = new Set(Object.values(slots).flat());
  for (const node of svg.querySelectorAll("[data-chr]")) {
    const on = members.has(node.dataset.chr);
    node.classList.toggle("karyo-linked", on);
    node.classList.toggle("karyo-partial", on && (groupsOf.get(node.dataset.chr) || []).length > 1);
  }
  // 第一次（页面载入）弧线跟着条的动画慢慢出现；之后点选时立刻出现 / on page load the arcs follow the bars'
  // animation; after a click they appear at once
  const quick = svg.classList.contains("has-selection");
  svg.classList.add("has-selection");
  // 弧线从条的顶端出发，越过两条之间所有的条 / each arc starts at a bar top and passes over every bar in between
  const bars = [...svg.querySelectorAll("rect[data-chr]")].map((r) => ({ chr: r.dataset.chr,
    x: Number(r.getAttribute("x")) + Number(r.getAttribute("width")) / 2, y: Number(r.getAttribute("y")) }));
  const at = (chr) => bars.find((bar) => bar.chr === chr);
  const arc = (a, b) => {
    const [left, right] = a.x <= b.x ? [a, b] : [b, a];
    const dx = right.x - left.x;
    const lowestTop = Math.min(...bars.filter((bar) => bar.x >= left.x && bar.x <= right.x).map((bar) => bar.y));
    const control = lowestTop - 30 - dx * 0.1;
    return `M${left.x} ${left.y - 4} C${left.x + dx * 0.25} ${control}, ${right.x - dx * 0.25} ${control}, ${right.x} ${right.y - 4}`;
  };
  const pairs = [];
  for (const a of slots.SG1 || []) for (const b of slots.SG2 || []) pairs.push([at(a), at(b)]);
  for (const a of slots.SG2 || []) for (const b of slots.SG3 || []) pairs.push([at(a), at(b)]);
  $("#karyo-arcs").replaceChildren(...pairs.filter(([a, b]) => a && b).map(([a, b]) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", quick ? "karyo-link is-quick" : "karyo-link");
    path.setAttribute("d", arc(a, b));
    return path;
  }));
}

// ---- About and Data panels / "关于"和"数据"两个弹窗 ----------------------------------------------

const dataCommit = () => (CONFIG.dataBase.match(/\/resolve\/([0-9a-f]{7,40})\//) || [])[1] || null;
const datasetRoot = () => (CONFIG.browseBase || "").replace(/\/tree\/[^/]+\/$/, "") || null;

// 打开首页的"注释与来源"表；在结果页时先回首页（浏览器"后退"能回到原来的查询）
// Opens the start page's "Annotations and sources" table; from a result it goes to the start page first
// (the browser's Back button returns to the query).
function showAnnotationSources() {
  $("#dialog").close();
  const open = () => {
    const button = document.querySelector(".stat-toggle[aria-controls='annotation-sources']");
    if (!button) return;
    if ($("#annotation-sources").hidden) toggleStatPanel(button);
    $("#annotation-sources").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  if (document.body.classList.contains("is-query")) { location.hash = ""; setTimeout(open, 60); } else open();
}

// 关于本站：做什么、各页签看什么、怎么做出来的、要注意什么、怎么引用
// About: what the site does, what each view shows, how it was built, what to keep in mind, how to cite it.
function openAbout() {
  const view = (name, text) => el("div", { class: "detail-row" }, el("dt", {}, name), el("dd", {}, text));
  openDialog(
    el("h2", {}, "About this database"),
    el("p", { class: "dialog-lead" }, "Look up a gene, transcript or protein ID from any Camelina sativa annotation in this release. For every annotation the page shows the gene's likely corresponding genes, its predicted copies on the three subgenomes, and the evidence behind each one."),
    el("h3", {}, "What the page shows"),
    el("dl", { class: "details" },
      view("Homeologs", "The query's copies on SG1, SG2 and SG3 in every annotation. The highlighted column is the copy that corresponds to the query."),
      view("Evidence", "Ranked protein hits, and every syntenic or OrthoFinder partner, with identity, coverage and block details."),
      view("Alignment", "Protein and CDS alignment of the chosen copies, computed in your browser with Kalign."),
      view("Functional annotation", "Each transcript's results from six tools (TAIR10, Swiss-Prot and RefSeq hits, eggNOG-mapper, KofamScan, InterProScan), shown as the tools reported them."),
      view("Annotations and sources", "Where each annotation comes from, with gene counts, BUSCO completeness and assembly statistics.")),
    el("h3", {}, "How it was built"),
    el("p", {}, "The proteins of all annotations were compared with DIAMOND, and their genes with GENESPACE synteny and OrthoFinder orthology. Homeolog copies are then assigned by fixed rules. A gene whose chromosome position disagrees with this evidence is marked to verify rather than reassigned."),
    el("p", {}, detailsButton("Methods and data versions", () => openDataMethods(state.homeologNote))),
    el("h3", {}, "Please keep in mind"),
    el("ul", { class: "method-notes" },
      el("li", {}, "Everything here is a computational prediction from the annotations in this release, not experimental evidence."),
      el("li", {}, "A missing hit does not prove absence: the copy may be unplaced, unannotated or below the thresholds."),
      el("li", {}, "To verify flags a conflict between position and evidence for review; it does not correct an assembly.")),
    el("h3", {}, "Citing"),
    el("p", {}, "Please cite the data release by its name and commit, and the papers of the annotations you use."),
    el("p", { class: "dialog-actions" },
      detailsButton("Data release", openDataInfo),
      detailsButton("Annotations and sources", showAnnotationSources)),
    el("p", { class: "muted small" }, "The annotations and databases remain under their providers' terms. JGI data carry the acknowledgments given in the sources table. KEGG data are © Kanehisa Laboratories."),
  );
}

// 数据：本站读的是哪一版、里面有什么、下载、以前的版本
// Data: which release this page reads, what it holds, the downloads, and the earlier releases.
// 分析编号、注释和基因数、数据库校验值不在这里重复：首页数字和"方法"里的"数据版本信息"已经有了
// The analysis ID, annotation and gene counts and the database checksum are not repeated here: the start-page
// figures and "Data version details" under Methods already give them.
function openDataInfo() {
  const release = CONFIG.release || {};
  const commit = dataCommit();
  const root = datasetRoot();
  const row = (label, ...value) => el("div", { class: "detail-row" }, el("dt", {}, label), el("dd", {}, ...value));
  const folder = (path, text) => el("li", {}, el("code", {}, path), " ", el("span", {}, text));
  openDialog(
    el("h2", {}, "Data release"),
    el("p", { class: "dialog-lead" }, "Every view and download on this page reads one fixed release of the public Hugging Face dataset."),
    el("dl", { class: "details" },
      release.tag ? row("Release", el("code", {}, release.tag)) : null,
      commit ? row("Commit", el("code", {}, commit)) : null,
      root ? row("Dataset", el("a", { href: CONFIG.browseBase, target: "_blank", rel: "noopener" }, "Open this release on Hugging Face")) : null),
    el("h3", {}, "What the dataset holds"),
    el("ul", { class: "folder-list" },
      folder("web/", "Gene records, the ID index and every pairwise relation (hits, synteny, OrthoFinder)"),
      folder("homeologs/", "Subgenome copies, group calls and the genes to verify"),
      folder("sequences/", "Protein and CDS of every annotated transcript"),
      CONFIG.functionBase ? folder("function/", "Functional annotation: each transcript's tool results and per-annotation tables") : null,
      folder("tables/pangenes/", "GENESPACE pan-gene tables, one per reference annotation"),
      folder("query/", "The complete SQLite database, with R and Python examples")),
    el("h3", {}, "Downloads"),
    el("ul", { class: "download-grid dialog-downloads" }, ...downloadTiles()),
    (release.earlier || []).length ? el("h3", {}, "Earlier releases") : null,
    (release.earlier || []).length ? el("ul", { class: "folder-list" }, ...release.earlier.map((r) => el("li", {},
      root ? el("a", { href: `${root}/tree/${r.commit}/`, target: "_blank", rel: "noopener" }, el("code", {}, r.tag)) : el("code", {}, r.tag),
      " ", el("code", { class: "muted" }, r.commit.slice(0, 8)), " ", el("span", {}, r.note)))) : null,
    el("p", { class: "dialog-actions" }, detailsButton("Annotations and sources", showAnnotationSources)),
  );
}

// 手机上的菜单按钮：点开/收起顶栏链接；点链接、点外面或按 Esc 收起
// The phone menu button: opens and closes the top-bar links; a link, a click outside or Esc closes it.
function setupMenu() {
  const nav = $("#topnav"), button = $("#menu-toggle");
  const close = () => { nav.classList.remove("menu-open"); button.setAttribute("aria-expanded", "false"); };
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = nav.classList.toggle("menu-open");
    button.setAttribute("aria-expanded", String(open));
    if (open) {   // 语言下拉若开着就先收起 / fold the language list first if it is open
      const list = $("#lang-list");
      if (list) { list.hidden = true; $("#lang-toggle")?.setAttribute("aria-expanded", "false"); }
    }
  });
  $("#topnav-links").addEventListener("click", (event) => { if (event.target.closest(".nav-link")) close(); });
  document.addEventListener("click", (event) => { if (!nav.contains(event.target)) close(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
}

function renderFooter(homeologNote) {
  const datasetUrl = CONFIG.browseBase || CONFIG.downloadBase;
  const revision = (CONFIG.dataBase.match(/\/resolve\/([0-9a-f]{7,40})\//) || [])[1];
  // 页脚两行：站名；注释数、分析名和数据版本合成一行 / two footer lines: the site name; annotations, analysis and
  // data revision in one line
  $("#footer").replaceChildren(...[
    el("p", { class: "footer-title" }, "Camelina sativa Pan-Gene Database"),
    el("p", { class: "muted small" }, `Data from ${state.manifest.target_genomes.length} Camelina sativa annotations · `
      + `analysis ${state.manifest.run}${revision ? ` · data revision ${revision.slice(0, 8)}` : ""}`),
    CONFIG.localPreview ? el("p", { class: "message local-preview" }, CONFIG.localPreview.label || "Local preview · selected real queries from 18 annotations") : null,
    el("div", { class: "footer-links" },
      datasetUrl ? el("a", { href: datasetUrl }, "View dataset") : null,
      detailsButton("Data and methods", () => openDataMethods(homeologNote))),
    state.homeologManifest ? null
      : el("p", { class: "muted" }, "Homeolog predictions are currently unavailable."),
  ].filter(Boolean));
}

// ---- Lookup flow -----------------------------------------------------------------------------

// 切换语言会重新载入页面：切换前把注释范围、显示条数、展开的行和功能注释面板的转录本存进会话存储，载入后同一个
// 基因取回来（只用一次）。基因号和页签本来就在地址里。序列比对页里勾选的基因不在此列。
// A language switch reloads the page: before it, the annotation selection, hit count, expanded rows and the
// functional-annotation transcript go into session storage, and the same gene takes them back once after the reload.
// The gene and the view are in the address anyway. The genes ticked in the Alignment view are not kept.
const RESTORE_KEY = "pangene-restore";

function saveSelection() {
  if (!state.record) return;
  try {
    sessionStorage.setItem(RESTORE_KEY, JSON.stringify({ id: state.record.id, genome: state.genome, shown: [...state.shown],
      top: state.top, expanded: [...state.expanded], transcript: window.FunctionalAnnotation?.current?.() || null }));
  } catch (error) { /* private mode: the selection is lost, as before */ }
}

function takeSelection(id, genome) {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(RESTORE_KEY) || "null");
    sessionStorage.removeItem(RESTORE_KEY);
  } catch (error) { return null; }
  if (!saved || saved.id !== id || saved.genome !== genome) return null;
  const genomes = state.manifest.target_genomes;
  if (Array.isArray(saved.shown)) state.shown = new Set(saved.shown.filter((g) => genomes.includes(g)));
  if ([5, 10].includes(saved.top)) state.top = saved.top;
  if (Array.isArray(saved.expanded)) state.expanded = new Set(saved.expanded.filter((g) => genomes.includes(g)));
  return saved;
}

// Hide the previous gene, so a failed lookup is never read as showing the result of the new one.
function clearResult() {
  window.ProteinAlignmentView?.close();
  window.GeneDescription?.clear();
  window.FunctionalAnnotation?.clear();
  hideEvidenceTooltip();
  state.record = null;
  state.homeologs = null;
  state.alignment = null;
  state.alignmentSubgenome = null;
  state.expanded = new Set();
  for (const id of ["#gene", "#controls", "#results", "#legend"]) $(id).hidden = true;
  document.title = "Camelina sativa Pan-Gene Database";
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
      message(genome ? `ID “${id}” was not found in ${genomeLabel(genome)}. IDs are case-sensitive.` : `ID “${id}” was not found. IDs are case-sensitive.`, "error");
      return;
    }
    if (matches.length > 1) {
      message([`“${id}” matches multiple genes; choose one: `,
        ...matches.map(([g, geneId]) => el("a", { href: `#q=${encodeURIComponent(geneId)}&g=${encodeURIComponent(g)}`, class: "choice" }, `${geneId} (${genomeLabel(g)})`))]);
      return;
    }
    const [g, , key, match] = matches[0];
    const record = await geneRecord(g, key);
    if (seq !== state.lookupSeq) return;
    Object.assign(state, { record, genome: g, typed: id, match });
    const restored = takeSelection(record.id, g);     // 切换语言前记下的选择 / the selection saved before a language switch
    if (!state.shown) state.shown = new Set(state.manifest.target_genomes);
    message(null);
    renderGene();
    renderControls();
    renderResults();
    document.title = `${record.id} · Camelina sativa Pan-Gene Database`;
    window.GeneDescription?.load({ container: $("#gene-description"), genome: g,
      geneId: record.id, geneKey: record.k, apiBase: CONFIG.geneDescriptionApiBase });
    // 功能注释面板：各工具的原始结果，按转录本显示 / functional annotation: each tool's raw results, per transcript
    window.FunctionalAnnotation?.load({ container: $("#function-panel"), base: CONFIG.functionBase, genome: g,
      geneId: record.id, geneKey: record.k, pageManifest: state.manifest, transcript: restored?.transcript || null });
  } catch (error) {
    if (seq !== state.lookupSeq) return;
    message(notAvailable(error), "error");
  }
}

// The URL hash holds the lookup, so a result can be bookmarked or shared: #q=ID&g=GENOME
function fromHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const [view, list] = VIEW_NAMES[params.get("view")] || [];
  if (view && (view !== "alignment" || state.homeologManifest)) state.view = view;
  if (["hits", "related"].includes(params.get("list"))) state.evidence = params.get("list");
  else if (list) state.evidence = list;
  if (params.get("q")) {
    setPageMode(true);
    window.scrollTo({ top: 0 });       // 新查询从顶部的基因卡片开始看 / a new lookup starts at the gene card
    lookup(params.get("q"), params.get("g") || "");
  } else if (!location.hash) {
    // 地址里没有查询（点了左上角）：回到首页 / no query in the address (the brand was clicked): back to the start page
    state.lookupSeq++;
    clearResult();
    message(null);
    $("#gene-input").value = "";
    $("#genome-select").value = "";
    setPageMode(false);
    window.scrollTo({ top: 0 });
  }
}

function go(id, genome) {
  const hash = `#q=${encodeURIComponent(id)}${genome ? `&g=${encodeURIComponent(genome)}` : ""}`;
  if (location.hash === hash) lookup(id, genome); else location.hash = hash;
}

// 三个页签；旧链接里的五个页签名对应到它们 / Three views; the five older view names in shared links map onto them.
const VIEW_NAMES = {
  homeologs: ["homeologs"], evidence: ["evidence"], alignment: ["alignment"],
  overview: ["homeologs"], counterparts: ["homeologs"], hits: ["evidence", "hits"], related: ["evidence", "related"],
};

// 地址栏记下当前页签（证据页还记下列表），链接分享出去能打开同一页
// The address keeps the current view (and the Evidence list), so a shared link opens the same page.
function syncViewHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.get("q")) return;
  params.set("view", state.view);
  if (state.view === "evidence") params.set("list", state.evidence); else params.delete("list");
  history.replaceState(null, "", `#${params}`);
}

function setView(name) {
  const [view, list] = VIEW_NAMES[name] || [];
  if (!view || (view === "alignment" && !state.homeologManifest)) return;
  state.view = view;
  if (list) state.evidence = list;
  syncViewHash();
  if (state.record) { renderControls(); renderResults(); }
}

function setEvidenceList(list) {
  if (!["hits", "related"].includes(list)) return;
  state.evidence = list;
  syncViewHash();
  if (state.record) { renderControls(); renderResults(); }
}

// ---- Chinese texts / 中文对照表 ----------------------------------------------------------------------
// ZH_TEXT：整段英文（空白合并后）-> 中文；ZH_PATTERNS：带数字或名字的英文句式；ZH_HTML：index.html 里带 data-i18n 键的段落。
// ZH_TEXT: a whole English text (whitespace collapsed) -> Chinese; ZH_PATTERNS: English sentences with numbers or names
// in them; ZH_HTML: the index.html paragraphs that carry a data-i18n key.
// 嵌套部分先查表，没有就保留英文 / a nested part is looked up first, else its English stays
const zhPart = (text) => I18N.lookup(text) || text;
const zhSubject = (gene, verb) => `${gene === "This gene" ? "这个基因" : `${gene} `}${verb === "is" ? "" : "被排除了：它"}`;

const ZH_TEXT = {
  // 顶栏、首页 / top bar and start page
  "Skip to content": "跳到正文", "About": "关于", "Data": "数据", "Methods": "方法", "Dataset": "数据集", "Menu": "菜单",
  "Site": "网站导航", "Close": "关闭", "Switch between light and dark colours": "切换浅色 / 深色",
  "Camelina sativa Pan-Gene Database: start page": "亚麻荠泛基因数据库：首页",
  "Camelina sativa Pan-Gene Database": "亚麻荠泛基因数据库",
  "Camelina sativa · allohexaploid oilseed · 20 chromosomes · three subgenomes": "亚麻荠 Camelina sativa · 异源六倍体油料作物 · 20 条染色体 · 三个亚基因组",
  "Gene correspondence, homeologs and functional annotation across 18 annotations of 14 accessions.":
    "14 个品种 18 套注释中的基因对应关系、部分同源基因与功能注释。",
  "Gene, transcript or protein ID": "基因、转录本或蛋白 ID", "Genome": "基因组", "any annotation": "任意注释",
  "Look up": "查询", "Try": "试试", "One example per annotation": "每套注释一个例子",
  "Loading data description…": "正在载入数据说明…",
  "Gene, transcript or protein ID, e.g. CsPrytzh.01G000100": "基因、转录本或蛋白 ID，例如 CsPrytzh.01G000100",
  "Only needed when an ID exists in several annotations": "只有同一个 ID 出现在多套注释里时才需要选",
  "Looking up…": "正在查询…", "Loading…": "正在载入…",
  "annotations": "套注释", "accessions": "个品种", "genes per annotation": "每套注释的基因数", "gene families": "个基因家族",
  "searchable IDs": "可查询的 ID",
  "DH55 has two annotations and Suneson four; every other accession has one. Click for the table":
    "DH55 有两套注释，Suneson 有四套，其余品种各一套。点击查看表格",
  "What the database shows": "本数据库能看什么",
  "Evidence in every annotation": "每套注释里的证据",
  "Ranked protein hits, GENESPACE synteny and OrthoFinder orthology for each annotation, with the evidence and alignment metrics behind every pair.":
    "每套注释中的蛋白命中排名、GENESPACE 共线性和 OrthoFinder 直系同源，并给出每一对背后的证据和比对指标。",
  "Three subgenome copies": "三个亚基因组拷贝",
  "Predicted SG1, SG2 and SG3 copies in every annotation. Genes whose position conflicts with the evidence are flagged":
    "每套注释中预测的 SG1、SG2、SG3 拷贝。位置与证据冲突的基因会标为",
  ", never silently reassigned.": "，不会被悄悄改派。",
  "Sequences and alignment": "序列与比对",
  "Protein and CDS of every annotated transcript, aligned in your browser with Kalign, with FASTA and table downloads.":
    "每个注释转录本的蛋白和 CDS，可在浏览器中用 Kalign 比对，并下载 FASTA 和表格。",
  "Data and downloads": "数据与下载", "Data release and downloads": "数据版本与下载", "Example: FAD2 →": "示例：FAD2 →",
  "Every view and download on this page reads one fixed release of the public Hugging Face dataset:":
    "本页所有视图和下载都读取公开 Hugging Face 数据集中固定的同一版：", "release": "版本", "commit": "提交号",
  "Each transcript's results from six tools (TAIR10, Swiss-Prot and RefSeq hits, eggNOG-mapper, KofamScan, InterProScan), plus GO and KEGG tables for enrichment.":
    "每个转录本在六个工具中的结果（TAIR10、Swiss-Prot 和 RefSeq 命中，eggNOG-mapper，KofamScan，InterProScan），另有用于富集分析的 GO 和 KEGG 表格。",
  "Every file comes from the release this page reads; the panel lists each folder and download.":
    "所有文件都来自本页读取的这一版；点开后列出每个文件夹和下载入口。",
  "Every file comes from one pinned release of the public dataset, the same version this page reads.":
    "每个文件都来自公开数据集中固定的同一版，与本页读取的版本一致。",
  "File · direct download": "文件 · 直接下载", "Folder · opens the file list": "文件夹 · 打开文件列表",
  "Links are enabled once the data set is published; until then these files are on the cluster under results/.":
    "数据集发布后链接才可用；在此之前这些文件在集群的 results/ 下。",
  // 下载项说明（config.js）/ download labels (config.js)
  "All genes with their IDs, positions and status": "全部基因及其 ID、位置和状态",
  "Related genes per query annotation: pairwise evidence and alignment metrics": "按查询注释分的相关基因：成对证据和比对指标",
  "Predicted SG1/SG2/SG3 copies, group assignments and genes to verify": "预测的 SG1/SG2/SG3 拷贝、组别指派和待核实的基因",
  "GENESPACE pan-gene tables, one per reference annotation": "GENESPACE 泛基因表，每个参考注释一张",
  "All-transcript catalog, protein/CDS shards and their sequence index": "全部转录本目录、蛋白 / CDS 分片及其序列索引",
  "Functional annotation per annotation: gene and transcript tables (best Arabidopsis, Swiss-Prot and RefSeq hits, eggNOG, KO, GO, InterPro, Pfam, PANTHER) and GO/KEGG enrichment files":
    "每套注释的功能注释：基因表和转录本表（拟南芥、Swiss-Prot、RefSeq 最佳命中，eggNOG、KO、GO、InterPro、Pfam、PANTHER）以及 GO / KEGG 富集文件",
  "How the functional annotation was made: tools and versions, merging rules, file formats and an R enrichment example":
    "功能注释是怎么做的：工具和版本、合并规则、文件格式和一个 R 富集分析示例",
  "The complete SQLite query database: stored candidate hits, relations and pan-gene tables for batch work in R or Python":
    "完整的 SQLite 查询数据库：已存的候选命中、关系和泛基因表，可在 R 或 Python 中批量使用",
  "How to use the database: tables, the compressed hit records, R and Python examples; query/05_query_data.py queries it from the command line":
    "数据库用法：各表、压缩的命中记录、R 和 Python 示例；query/05_query_data.py 可在命令行查询",
  // 页脚 / footer
  "View dataset": "查看数据集", "Data and methods": "数据与方法",
  "Homeolog predictions are currently unavailable.": "部分同源预测暂时不可用。",
  // "关于"和"数据"弹窗 / About and Data panels
  "About this database": "关于本数据库",
  "Look up a gene, transcript or protein ID from any Camelina sativa annotation in this release. For every annotation the page shows the gene's likely corresponding genes, its predicted copies on the three subgenomes, and the evidence behind each one.":
    "输入这一版中任一套亚麻荠注释里的基因、转录本或蛋白 ID。页面会在每套注释中给出这个基因的候选对应基因、它在三个亚基因组上的预测拷贝，以及每一个背后的证据。",
  "What the page shows": "页面能看什么",
  "The query's copies on SG1, SG2 and SG3 in every annotation. The highlighted column is the copy that corresponds to the query.":
    "查询基因在每套注释中 SG1、SG2、SG3 上的拷贝。高亮的一列是与查询基因对应的拷贝。",
  "Ranked protein hits, and every syntenic or OrthoFinder partner, with identity, coverage and block details.":
    "蛋白命中排名，以及全部共线或 OrthoFinder 伙伴，附一致性、覆盖度和共线块信息。",
  "Protein and CDS alignment of the chosen copies, computed in your browser with Kalign.":
    "所选拷贝的蛋白和 CDS 比对，用 Kalign 在你的浏览器里计算。",
  "Functional annotation": "功能注释",
  "Each transcript's results from six tools (TAIR10, Swiss-Prot and RefSeq hits, eggNOG-mapper, KofamScan, InterProScan), shown as the tools reported them.":
    "每个转录本在六个工具中的结果（TAIR10、Swiss-Prot 和 RefSeq 命中，eggNOG-mapper，KofamScan，InterProScan），按工具原样显示。",
  "Annotations and sources": "注释与来源",
  "Where each annotation comes from, with gene counts, BUSCO completeness and assembly statistics.":
    "每套注释的来源，以及基因数、BUSCO 完整度和组装统计。",
  "How it was built": "怎么做的",
  "The proteins of all annotations were compared with DIAMOND, and their genes with GENESPACE synteny and OrthoFinder orthology. Homeolog copies are then assigned by fixed rules. A gene whose chromosome position disagrees with this evidence is marked to verify rather than reassigned.":
    "所有注释的蛋白用 DIAMOND 两两比对，基因用 GENESPACE 共线性和 OrthoFinder 直系同源关联起来，再按固定规则指派部分同源拷贝。染色体位置与这些证据不一致的基因会标为待核实，而不会被改派。",
  "Methods and data versions": "方法与数据版本",
  "Please keep in mind": "请注意",
  "Everything here is a computational prediction from the annotations in this release, not experimental evidence.":
    "这里的一切都是基于这一版中各套注释的计算预测，不是实验证据。",
  "A missing hit does not prove absence: the copy may be unplaced, unannotated or below the thresholds.":
    "没有命中不代表不存在：这个拷贝可能未定位、未被注释，或低于阈值。",
  "To verify flags a conflict between position and evidence for review; it does not correct an assembly.":
    "“待核实”提醒复查位置与证据之间的冲突，并不是对组装的修正。",
  "Citing": "引用",
  "Please cite the data release by its name and commit, and the papers of the annotations you use.":
    "请引用数据版本的名字和提交号，以及你用到的注释所对应的论文。",
  "Data release": "数据版本",
  "The annotations and databases remain under their providers' terms. JGI data carry the acknowledgments given in the sources table. KEGG data are © Kanehisa Laboratories.":
    "各注释和数据库仍按其提供方的条款使用。JGI 数据需附上来源表中给出的致谢。KEGG 数据版权属于 Kanehisa Laboratories。",
  "Every view and download on this page reads one fixed release of the public Hugging Face dataset.":
    "本页所有视图和下载都读取公开 Hugging Face 数据集中固定的同一版。",
  "Release": "版本", "Commit": "提交号", "Analysis": "分析", "Annotations": "注释", "Genes": "基因数",
  "Source database SHA-256": "源数据库 SHA-256", "Open this release on Hugging Face": "在 Hugging Face 上打开这一版",
  "What the dataset holds": "数据集里有什么",
  "Gene records, the ID index and every pairwise relation (hits, synteny, OrthoFinder)": "基因记录、ID 索引和全部成对关系（命中、共线性、OrthoFinder）",
  "Subgenome copies, group calls and the genes to verify": "亚基因组拷贝、组别判定和待核实的基因",
  "Protein and CDS of every annotated transcript": "每个注释转录本的蛋白和 CDS",
  "Functional annotation: each transcript's tool results and per-annotation tables": "功能注释：每个转录本的工具结果和每套注释的表格",
  "The complete SQLite database, with R and Python examples": "完整的 SQLite 数据库，附 R 和 Python 示例",
  "Downloads": "下载", "Earlier releases": "更早的版本",
  "The same 18 annotations, without the functional annotation": "同样的 18 套注释，没有功能注释",
  "The first release, 15 annotations": "第一版，15 套注释",
  // 方法弹窗 / Methods dialog
  "A transcript or protein ID finds its parent gene. Protein comparisons use one representative protein per gene.":
    "输入转录本或蛋白 ID 会找到它所属的基因。蛋白比较时每个基因用一条代表蛋白。",
  "Related genes includes all stored syntenic and OrthoFinder partners, including those outside the displayed top hits.":
    "“相关基因”包括所有已存的共线和 OrthoFinder 伙伴，也包括不在显示的前几名命中里的。",
  "Same-chromosome synteny and cross-chromosome synteny are reported separately with their source runs. Cross-chromosome relationships do not by themselves establish orthology or translocation. Shared pan-gene membership is not direct pairwise synteny.":
    "同号染色体共线性和跨染色体共线性分开报告，并注明来源运行。跨染色体关系本身不能确定直系同源或易位。同属一个泛基因条目也不等于两两直接共线。",
  "Direct synteny was evaluated between same-numbered chromosomes. Shared pan-gene membership does not imply direct synteny between every pair of members.":
    "直接共线性只在同号染色体之间评估。同属一个泛基因条目，不代表每两个成员之间都直接共线。",
  "Genes flagged to verify keep their original position. The flag asks for a check; it does not correct the assembly.":
    "标为待核实的基因保留原来的位置。这个标记只是提醒核查，并不修正组装。",
  "To verify, by gene: each other annotation votes for the chromosome of the gene's best syntenic partner there; a partner on another chromosome counts only at ≥99% identity and ≥80% coverage. The gene is flagged when more than half of the votes go to other chromosomes, at least 3 to the same one. To verify, by region: a gene inside a run of such genes (at least 3 toward the same chromosome, at most 20 genes apart, at least half of the genes in the run) is flagged with the run, whatever its own result. Downloaded tables write these two cases as vote and stretch.":
    "待核实（按基因）：其他每套注释按这个基因在那里的最佳共线伙伴所在的染色体投票；伙伴在另一条染色体上时，只有一致性 ≥99% 且覆盖度 ≥80% 才计票。超过一半的票投给其他染色体、且至少 3 票投给同一条时，这个基因被标记。待核实（按区段）：位于一串这类基因之中的基因（至少 3 个指向同一条染色体，彼此相隔不超过 20 个基因，且至少占这一串基因的一半），不管自己的结果如何，都随这一串一起标记。下载的表格里，这两种情况分别写作 vote 和 stretch。",
  "Consider sequence identity and coverage together. A short, high-identity match requires review of the gene models.":
    "序列一致性和覆盖度要一起看。很短但一致性很高的匹配，需要检查基因模型。",
  "Homeolog assignments are computational predictions. Cross-checked means the protein match agrees with a second check: a reverse match within the annotation, or a path through the query's homeolog in the same annotation. The two checks share input data, so this is not independent validation. A missing match does not prove that a gene is absent.":
    "部分同源基因的指派是计算预测。“交叉核对一致”表示蛋白匹配与第二项核对结果相同：要么是同一套注释内的反向匹配，要么是经查询基因在同一套注释中的部分同源基因的核对。两项核对用到部分相同的输入数据，所以这不是独立验证。没有匹配不代表基因不存在。",
  "Data version details": "数据版本信息", "Analysis ID": "分析编号", "Protein-hit data exported": "蛋白命中数据导出日期",
  "ID index updated": "ID 索引更新日期", "Homeolog data exported": "部分同源数据导出日期", "Evidence identifiers": "证据编号",
  "Orthogroups are identified by the analysis ID and group name. Pan-gene groups also require the reference annotation and group number.":
    "直系同源组由分析编号和组名确定；泛基因条目还需要参考注释和条目编号。",
  // 首页数字下的面板 / panels under the start-page figures
  "Loading the annotation figures…": "正在载入注释统计…",
  "Accession": "品种", "Annotation and source": "注释与来源", "Contig": "Contig", "On": "位于", "Not in an": "未进入",
  "orthogroup": "直系同源组", "Position to verify": "待核实位置", "Details": "详情", "Complete": "完整", "Missing": "缺失",
  "Contig continuity after splitting at runs of at least 10 N; see the definition below": "在不少于 10 个 N 处切开后的 contig 连续性；定义见下方",
  "On Chr01–20": "位于 Chr01–20", "Not in orthogroup": "未进入直系同源组", "To verify": "待核实",
  "Assembly": "组装", "· annotation": "· 注释", "Chromosomes:": "染色体：", "genetic map": "遗传图谱",
  "synteny to DH55 v2": "按 DH55 v2 共线性", "synteny to DH55, Hi-C checked": "按 DH55 共线性，经 Hi-C 核对",
  "synteny to Prytzh": "按 Prytzh 共线性", "Unavailable": "不可用", "Assembly figures unavailable": "组装统计不可用",
  "source to be added": "来源待补",
  "Improved DH55 assembly (CsaDH55) with Helixer gene models, Parkin lab, AAFC Saskatoon":
    "改进的 DH55 组装（CsaDH55）与 Helixer 基因模型，Parkin 实验室，AAFC Saskatoon",
  "Assembly of Kagale et al. 2014 (AAFC Saskatoon), corrected": "Kagale et al. 2014 的组装（AAFC Saskatoon），经过校正",
  "used as the reference in that paper; the annotation files are not deposited there": "该论文以它为参考；注释文件没有随论文公开",
  "JGI annotation v1.1 of the Suneson assembly; JGI proposal 507613, PI C. Lu (Montana State University)":
    "Suneson 组装的 JGI 注释 v1.1；JGI 项目 507613，负责人 C. Lu（Montana State University）",
  "unpublished (JGI analysis completed 2025-10-03)": "未发表（JGI 分析完成于 2025-10-03）",
  "JGI CSP 505836 (BAP), PI D. Kliebenstein": "JGI CSP 505836（BAP），负责人 D. Kliebenstein",
  "Sequenced under JGI proposal 507613, PI C. Lu (Montana State University)": "在 JGI 项目 507613 下测序，负责人 C. Lu（Montana State University）",
  "named CN113691 in Bird et al. 2024 and on the JGI genome portal": "在 Bird et al. 2024 和 JGI 基因组门户中写作 CN113691",
  "Assembly continuity": "组装连续性", "Chromosomes built": "染色体构建",
  "Assembly figures are currently unavailable.": "组装统计暂时不可用。",
  "Complete copies per complete BUSCO": "每个完整 BUSCO 的完整拷贝数", "Not in an orthogroup": "未进入直系同源组",
  "Contig N50": "Contig N50", "Chromosomes": "染色体", "On Chr01–Chr20": "位于 Chr01–Chr20",
  "At least half of the total contig length is in segments this long or longer. Values are recomputed from the assembly FASTA by splitting at runs of at least 10 N; runs of 1–9 N remain inside segments. Mb means 1,000,000 bp. This measures continuity, not base accuracy or whether joins are correct. Scaffold N50 in Details uses whole FASTA records, including gaps.":
    "总 contig 长度中至少一半落在不短于这个长度的片段里。数值由组装 FASTA 重新计算：在不少于 10 个 N 的地方切开，1–9 个 N 仍算在片段内。Mb 表示 1,000,000 bp。它衡量的是连续性，不是碱基准确度，也不是拼接是否正确。详情里的 scaffold N50 按整条 FASTA 记录计算（含缺口）。",
  "How the contigs were joined into Chr01–Chr20: with the accession's own Hi-C contacts or a genetic map, or by synteny to another genome (Prytzh or DH55). In an assembly ordered by synteny, the chromosome-scale order is taken from that genome, so agreement with that genome is not independent evidence. Details give the method, its source, the assembly size and how much of it lies outside Chr01–Chr20.":
    "contig 是怎样连成 Chr01–Chr20 的：用该品种自己的 Hi-C 接触或遗传图谱，或者按另一个基因组（Prytzh 或 DH55）的共线性排列。按共线性排列的组装，染色体尺度的顺序取自那个基因组，所以与那个基因组一致并不是独立证据。详情给出方法、来源、组装大小，以及有多少不在 Chr01–Chr20 上。",
  "Genes placed on the 20 chromosomes. Placement is needed for a homeolog prediction but does not guarantee one: a placed gene can lack a usable protein, fall below the evidence thresholds or have a position to verify.":
    "定位在 20 条染色体上的基因。定位是做部分同源预测的前提，但不保证一定有预测：已定位的基因也可能没有可用的蛋白、低于证据阈值，或位置待核实。",
  "Analysed genes (on Chr01–Chr20 with a usable protein) that this OrthoFinder run placed in no orthogroup, with their share of the analysed genes. This does not mean that other annotations lack similar sequences, and it is not by itself evidence of a wrong gene model.":
    "已分析的基因（在 Chr01–Chr20 上且有可用蛋白）中，这次 OrthoFinder 运行没有归入任何直系同源组的基因，以及它们占已分析基因的比例。这不代表其他注释里没有相似序列，本身也不能证明基因模型有错。",
  "Genes whose chromosome disagrees with the other annotations, either the gene itself or the genes around it (rules in Data and methods). A flag asks for a check; it does not prove the position wrong. The assembly may be misjoined, the accession may carry a real rearrangement, or the annotations that disagree may share one layout (11 JGI assemblies were ordered on Prytzh).":
    "染色体与其他注释不一致的基因，可能是这个基因本身，也可能是它周围的基因（规则见“数据与方法”）。标记只是提醒核查，并不证明位置错了：可能是组装拼错了，可能这个品种真的有重排，也可能持不同意见的注释共用同一种排布（11 个 JGI 组装是按 Prytzh 排序的）。",
  "When annotations disagree, these figures give background only; judge a specific gene by its coverage, synteny and gene-model structure. The numbers:":
    "各注释结果不一致时，这些数字只作背景参考；判断某个具体基因，请看它的覆盖度、共线性和基因模型结构。数据文件：",
  "JGI data use: the ten CSP 505836 annotations carry the notice “These sequence data were produced under JGI CSP 505836, Pangenomic comparison of structural variation driving recurrent network evolution in Brassicaceae metabolism (BAP), and made available by the Department of Energy’s Joint Genome Institute”; CAM70, CAM116 and SunesonJGI (proposal 507613) carry “These sequence data were made available by the Department of Energy’s Joint Genome Institute”.":
    "JGI 数据使用说明：十套 CSP 505836 注释要求注明“These sequence data were produced under JGI CSP 505836, Pangenomic comparison of structural variation driving recurrent network evolution in Brassicaceae metabolism (BAP), and made available by the Department of Energy’s Joint Genome Institute”；CAM70、CAM116 和 SunesonJGI（项目 507613）要求注明“These sequence data were made available by the Department of Energy’s Joint Genome Institute”。",
  "Genes per annotation": "每套注释的基因数",
  "Every gene model of each annotation, including genes without a usable protein. The annotations of one accession (DH55, Suneson) differ because they were made differently, not because the plants differ.":
    "每套注释的全部基因模型，包括没有可用蛋白的基因。同一个品种的几套注释（DH55、Suneson）数量不同，是因为注释方法不同，不是植物本身不同。",
  "How many accessions share each gene family": "每个基因家族在多少个品种中出现",
  "Show the numbers as a table": "以表格显示数字", "Accessions": "品种数", "Gene families": "基因家族数", "Share": "比例",
  "Gene families by the number of accessions that have them": "按拥有品种数统计的基因家族",
  // 查询控件 / lookup controls
  "View": "视图", "List": "列表", "Show": "显示", "Homeologs": "部分同源基因", "Evidence": "证据", "Alignment": "序列比对",
  "Ranked hits": "命中排名", "Related genes": "相关基因", "Top 5": "前 5", "Top 10": "前 10",
  "Download this result (TSV)": "下载当前结果（TSV）", "Change": "更改", "Done": "完成", "Select all": "全选",
  "Clear selection": "清空选择", "Evidence list": "证据列表", "Number of hits": "命中数", "Annotation selection": "注释选择",
  "The query's copies on SG1, SG2 and SG3 in every annotation; the highlighted column is the copy that corresponds to the query":
    "查询基因在每套注释中 SG1、SG2、SG3 上的拷贝；高亮的一列是与查询基因对应的拷贝",
  "Ranked protein hits and every syntenic or OrthoFinder partner in each annotation": "每套注释中的蛋白命中排名，以及全部共线或 OrthoFinder 伙伴",
  "Choose available genes and transcripts before aligning their sequences": "先选择可用的基因和转录本，再比对它们的序列",
  "The best protein hits in each annotation, ranked by bit score": "每套注释中按比特得分排序的最佳蛋白命中",
  "Every syntenic or OrthoFinder partner, whatever its hit rank": "全部共线或 OrthoFinder 伙伴，不论命中排名",
  "Save what this view shows, for all selected annotations, as a tab-separated file": "把当前视图显示的内容（所有选中的注释）保存为制表符分隔文件",
  // 基因卡片 / gene card
  "Genomic location": "基因组位置", "Representative protein": "代表蛋白", "Pan-gene groups": "泛基因条目", "Not available": "无",
  "Standard member": "标准成员", "Added via orthology": "经直系同源加入", "Additional array member": "串联重复额外成员",
  "Other membership": "其他成员类型", "View members →": "查看成员 →", "No pan-gene group recorded": "没有记录泛基因条目",
  "Not on a reference chromosome": "不在参考染色体上", "No protein available for comparison": "没有可比较的蛋白",
  "Results use this gene's representative protein.": "结果使用这个基因的代表蛋白。",
  "This gene has no usable representative protein for comparison.": "这个基因没有可用于比较的代表蛋白。",
  // 部分同源页 / Homeologs view
  "The highlighted": "高亮的",
  "is the query's own subgenome: the gene that corresponds to the query in each annotation. The other two columns are its homeologs on the other subgenomes.":
    "是查询基因自身所在的亚基因组：每套注释中与查询基因对应的基因。另外两列是它在另外两个亚基因组上的部分同源基因。",
  "(group set by its neighbourhood on this composite chromosome)": "（组别由它在这条复合染色体上的邻近基因决定）",
  "(its homeolog group on this composite chromosome is uncertain)": "（它在这条复合染色体上的部分同源组不确定）",
  "Annotation names": "注释名称", "Subgenome copies": "亚基因组拷贝", "Evidence labels": "证据标记",
  "The seven homeolog groups": "七个部分同源组", "Group": "组",
  "* Composite chromosome: one segment in each of two groups.": "* 复合染色体：两段分属两个组。",
  "Sources:": "来源：", "Martin et al. 2022, Table 4 (groups)": "Martin et al. 2022，表 4（分组）",
  "Chaudhary et al. 2020 (subgenome names)": "Chaudhary et al. 2020（亚基因组命名）",
  "Annotation": "注释", "homeolog": "部分同源基因", "corresponding gene": "对应基因", "Choose sequences": "选择序列",
  "top hit": "最佳命中", "· unplaced": "· 未定位", "evidence": "证据", "details": "详情", "why?": "原因？",
  "not found under current rules": "按当前规则未找到", "copy on unplaced sequence:": "未定位序列上的拷贝：",
  "same unplaced copy": "同一个未定位拷贝", "search list full": "搜索名单已满", "no stored hit ·": "没有已存命中 ·", "check": "需核查",
  "Check this pick": "请核查这个选择", "The search list was full": "搜索名单已满",
  "the query": "查询基因", "to verify": "待核实", "synteny + OrthoFinder": "共线性 + OrthoFinder", "synteny only": "仅共线性",
  "OrthoFinder only": "仅 OrthoFinder", "sequence only (≥ 97% identity)": "仅序列（一致性 ≥ 97%）", "partner supported": "伙伴基因支持",
  "cross-checked": "交叉核对一致", "sequence only": "仅序列", "sequence only, near-equal candidates": "仅序列，有相近候选",
  "found via homeolog": "经部分同源基因找到", "synteny": "共线性", "cross-chromosome synteny": "跨染色体共线性",
  "protein sequence": "蛋白序列",
  "This is the query gene itself.": "这就是查询基因本身。",
  "These genes sit in conserved gene order, and OrthoFinder also links them. This is computational support, not experimental proof.":
    "这两个基因的基因顺序保守（共线），OrthoFinder 也把它们联系在一起。这是计算上的支持，不是实验证明。",
  "These genes sit in conserved gene order. No OrthoFinder link was recorded.":
    "这两个基因的基因顺序保守（共线），但没有记录到 OrthoFinder 联系。",
  "OrthoFinder links these genes, but this analysis found no direct conserved gene order between them.":
    "OrthoFinder 把这两个基因联系在一起，但本次分析未检测到它们之间有直接的共线关系。",
  "A close protein match, with no direct synteny or OrthoFinder link recorded.":
    "这是一个相近的蛋白匹配，没有记录到直接的共线或 OrthoFinder 联系。",
  "Open the details to inspect the evidence for this candidate.": "打开详情查看这个候选的证据。",
  "The usual check gene could not be used here, so this gene was checked through another syntenic or OrthoFinder partner of the query's homeolog.":
    "通常用于核对的基因在这里用不上，所以改用查询基因的部分同源基因的另一个共线或 OrthoFinder 伙伴来核对。",
  "This gene is the best match on the other subgenome, and its own best match back is the query gene.":
    "这个基因是另一个亚基因组上的最佳匹配，反过来它的最佳匹配也正是查询基因。",
  "The direct protein match and the check through the query's homeolog in the same annotation both point to this gene.":
    "直接的蛋白匹配，和经查询基因在同一套注释中的部分同源基因所做的核对，都指向这个基因。",
  "The homeolog used for this check is itself unconfirmed.": "用于这次核对的部分同源基因本身也未确认。",
  "The two checks share input data, so this is not independent or experimental proof.":
    "两项核对用到部分相同的输入数据，所以这不是独立的或实验上的证明。",
  "This gene passes the protein identity and coverage limits on the expected chromosome, but no second check supports it.":
    "这个基因在预期的染色体上达到了蛋白一致性和覆盖度的要求，但没有第二项核对支持它。",
  "Several genes match almost equally well. This is one of them; compare the others before choosing.":
    "有几个基因匹配得几乎一样好，这里显示的是其中之一；选择前请比较其他候选。",
  "The direct protein match is weak or missing, so this gene was found through the query's homeolog in the same annotation.":
    "直接的蛋白匹配很弱或没有，所以这个基因是通过查询基因在同一套注释中的部分同源基因找到的。",
  "Open the details to inspect how this candidate was selected.": "打开详情查看这个候选是怎么选出来的。",
  "This is a candidate only: its position or subgenome needs checking, so it is not a confirmed corresponding gene or homeolog.":
    "这只是一个候选：它的位置或亚基因组需要核查，不是已确认的对应基因或部分同源基因。",
  "See its pairwise evidence and the position notice.": "请查看它的成对证据和位置说明。",
  "Corresponding genes across annotations are selected using protein matches, OrthoFinder and synteny between chromosomes with the same number. Homeologs are predicted from protein similarity and chromosome groups. Cross-checked means that the query’s homeolog in its own annotation maps to the same candidate in another annotation, or, within the query annotation, the candidate’s best qualifying reverse match is the query. Cross-chromosome synteny is shown in Evidence and helps flag positions to verify. Homeolog predictions do not require direct synteny.":
    "各注释之间的对应基因，根据蛋白匹配、OrthoFinder 和同号染色体之间的共线性选出。部分同源基因根据蛋白相似性和染色体组别预测。“交叉核对一致”表示：查询基因在本注释中的部分同源基因，在另一套注释里对应到同一个候选；或者在查询基因所在的注释内，候选基因合格的最佳反向匹配正是查询基因。跨染色体共线性列在“证据”页里，也帮助标记待核实的位置。部分同源预测不要求直接共线。",
  // 标记的白话说明（FLAG_TEXT）/ plain flag text (FLAG_TEXT)
  "Chosen by synteny or OrthoFinder. No protein match to the query is stored.":
    "由共线性或 OrthoFinder 选出，没有存下与查询基因的蛋白匹配。",
  "Another gene looks better on some measure. It is named under Why. Check before relying on this pick.":
    "另一个基因在某些方面看起来更好，名字写在“原因”里。依赖这个选择之前请先核查。",
  "No copy meeting the current rules was found on the expected chromosome, but a good match is on an unplaced sequence. It may be the missing copy, not yet assembled into a chromosome.":
    "预期的染色体上未找到符合当前标准的拷贝，但未定位序列上有一个较好的匹配。它可能就是缺失的那个拷贝，只是还没有组装进染色体。",
  "At least 99% identical to the query, with no second check in support. It may be a misplaced copy or the result of gene conversion.":
    "与查询基因至少 99% 相同，但没有第二项核对支持。它可能是放错位置的拷贝，也可能来自基因转换。",
  "Another gene scored slightly higher, but this one is within 5% and the check through the homeolog points to it.":
    "另一个基因得分略高，但这个基因与它相差不到 5%，而且经部分同源基因的核对指向它。",
  "The check through the query's homeolog points to a different gene, named under Why.":
    "经查询基因的部分同源基因核对，指向另一个基因，名字写在“原因”里。",
  "The usual check gene could not be used here, often because of a fused or split gene model, so another partner of the homeolog was used.":
    "通常用于核对的基因在这里用不上（常见原因是基因模型被融合或拆开），所以改用了部分同源基因的另一个伙伴。",
  "The homeolog used for this check has no second check of its own.": "用于这次核对的部分同源基因自己没有第二项核对。",
  "The homeolog group for this gene is uncertain.": "这个基因的部分同源组尚不确定。",
  "None fell on this chromosome, so a copy here may have been cut off.": "其中没有落在这条染色体上的，所以这里的拷贝可能被截掉了。",
  "This gene, or a candidate left out of this cell, is on a chromosome that disagrees with other annotations. Its position needs checking.":
    "这个基因，或被排除在这个格子之外的某个候选，所在的染色体与其他注释不一致。它的位置需要核查。",
  // 原因句里的固定句子（REASON_RULES）/ fixed sentences of the reasons (REASON_RULES)
  "Found through the query's homeolog in the same annotation.": "通过查询基因在同一套注释中的部分同源基因找到。",
  "The direct protein match is below 80% identity or 50% coverage.": "直接的蛋白匹配低于 80% 一致性或 50% 覆盖度。",
  "No direct protein match to the query is stored.": "没有存下与查询基因的直接蛋白匹配。",
  "No stored protein match in this annotation.": "这套注释中没有已存的蛋白匹配。",
  "The search list was full, so the match may not have been reported.": "搜索名单已满，这个匹配可能没有进入报告结果。",
  "Its subgenome is unknown.": "它的亚基因组未知。",
  "It may not have been assembled into a chromosome.": "它可能还没有被组装进染色体。",
  "Another gene may be the better pick.": "另一个基因可能是更好的选择。",
  "It may be a fragment, or the query may be two genes merged into one model.": "它可能是一个片段，也可能查询基因是两个基因被合并成的模型。",
  "The query may be a fragment, or that gene may be a fused gene model.": "可能查询基因是一个片段，也可能那个基因是融合的基因模型。",
  "Its position needs checking.": "它的位置需要核查。",
  "Its position and subgenome need checking.": "它的位置和亚基因组需要核查。",
  "Its own synteny gives no answer.": "它自己的共线性给不出结果。",
  "No subgenome group was assigned.": "没有指派亚基因组组别。",
  "no usable protein": "没有可用的蛋白", "not assigned": "未指派",
  "This candidate is selected for alignment only.": "这个候选只用于比对。",
  "No subgenome assignment was recorded.": "没有记录亚基因组指派。",
  "The query gene's annotated transcripts.": "查询基因的注释转录本。", "Why?": "原因？",
  "Subgenome predictions are unavailable, so the closest sequence match in each annotation is shown instead.":
    "亚基因组预测不可用，所以改为显示每套注释中序列最接近的匹配。",
  "Loading the corresponding genes…": "正在载入对应基因…",
  "No corresponding gene was identified in another annotation under the current rules, so most cells are expected to be empty.":
    "按当前规则，在其他注释中没有找到对应基因，所以大多数格子会是空的。",
  // 格子详情弹窗 / cell details dialog
  "Gene": "基因", "Role": "角色", "What this means": "含义", "Protein match": "蛋白匹配", "Result": "结果", "Why": "原因",
  "Pairwise evidence": "成对证据", "Prediction run": "预测运行", "Flags": "标记", "See also": "另见",
  "candidate — position / subgenome to verify": "候选——位置 / 亚基因组待核实",
  "corresponding gene (same subgenome as the query)": "对应基因（与查询基因同一亚基因组）",
  "the query itself": "查询基因本身", "predicted homeolog": "预测的部分同源基因",
  "no stored protein hit to the query": "没有与查询基因的已存蛋白命中",
  "sequence, synteny blocks and source runs": "序列、共线块和来源运行",
  "(no stored hit)": "（没有已存命中）",
  "— including hits on other chromosomes and unplaced sequences.": "——包括其他染色体和未定位序列上的命中。",
  // 成对详情弹窗 / pair details dialog
  "Query": "查询基因", "Target": "目标基因", "Protein alignment": "蛋白比对", "Aligned region": "比对区域", "Search": "搜索",
  "Same-chromosome synteny": "同号染色体共线性", "Cross-chromosome synteny": "跨染色体共线性",
  "Cross-chromosome interpretation": "跨染色体关系的解读", "Shared pan-gene entries": "共享的泛基因条目",
  "Direct relations": "直接关系", "Provenance": "数据来源", "none recorded": "没有记录", "unknown search": "未知搜索",
  "No hit stored for this pair. Absence from reported hits does not establish biological absence.":
    "这对基因没有已存的命中。报告的命中里没有，不代表生物学上不存在。",
  "Conserved gene order from the all-chromosome run. It can reflect homeology or structural differences; it does not confirm an ortholog or a translocation.":
    "来自全染色体运行的保守基因顺序。它可能反映部分同源关系或结构差异，但不能确认直系同源或易位。",
  "OrthoFinder does not list them as orthologs": "OrthoFinder 没有把它们列为直系同源",
  "none with the query annotation as reference": "以查询注释为参考时没有",
  "none: not a recorded syntenic or OrthoFinder partner": "没有：不是已记录的共线或 OrthoFinder 伙伴",
  // 证据页 / Evidence view
  "Location": "位置", "Bits": "比特得分", "E-value": "E 值", "Identity %": "一致性 %", "Aln len": "比对长度",
  "Query cov %": "查询覆盖度 %", "Target cov %": "目标覆盖度 %", "self": "自身", "No hits to show.": "没有可显示的命中。",
  "query annotation": "本注释",
  "The search list was full, so more similar genes may exist": "搜索名单已满，可能还有更多相似基因",
  "anchor": "锚点", "cross-chr anchor": "跨染色体锚点", "cross-chr synteny": "跨染色体共线", "same entry": "同一条目",
  "partial": "部分匹配", "Direct syntenic anchor pair": "直接共线锚点对", "Direct syntenic pair": "直接共线对",
  "Listed as orthologs by OrthoFinder": "OrthoFinder 列为直系同源", "Same pan-gene entry (query annotation as reference)": "同一泛基因条目（以查询注释为参考）",
  "Local match: one coverage below 50%. Check the annotation structure.": "局部匹配：有一个覆盖度低于 50%。请检查注释结构。",
  "Rank": "排名", "Synteny runs / blocks": "共线性运行 / 共线块", "Orthogroups": "直系同源组", "Shared pgIDs": "共享 pgID",
  "no hit": "无命中", "No syntenic or OrthoFinder partner in this annotation.": "这套注释中没有共线或 OrthoFinder 伙伴。",
  "No annotation selected.": "没有选中注释。",
  "searched, hits reported": "已搜索，有命中", "searched, nothing reported (not proof of absence)": "已搜索，没有报告命中（不代表不存在）",
  "the query gene has no representative protein": "查询基因没有代表蛋白", "no search covered this query and target": "没有搜索覆盖这一对查询和目标",
  // 最佳匹配总表（没有亚基因组预测时）/ best-hit summary (without a subgenome prediction)
  "Best sequence hit": "最佳序列命中", "Query / target cov %": "查询 / 目标覆盖度 %", "Notes": "备注", "unplaced": "未定位",
  "other chromosome": "其他染色体", "best hit not related": "最佳命中无关联",
  "Best hit covers less than half of one protein": "最佳命中覆盖不到其中一个蛋白的一半",
  "Best hit is on a sequence not assembled into a chromosome": "最佳命中在未组装进染色体的序列上",
  "The best hit has no synteny or OrthoFinder link; a related gene ranks lower": "最佳命中没有共线或 OrthoFinder 联系；有关联的基因排名更靠后",
  "The search list was full (25 matches)": "搜索名单已满（25 个匹配）",
  "Click a row to show every hit and every related gene in that annotation. “Direct relations” counts syntenic and OrthoFinder partners, whatever their hit rank.":
    "点击一行，显示这套注释中的全部命中和全部相关基因。“直接关系”统计共线和 OrthoFinder 伙伴，不论命中排名。",
  // 待核实 / position to verify
  "Position / subgenome to verify": "位置 / 亚基因组待核实",
  "This gene keeps its original position. The genes below are candidates only: they have no assigned subgenome and are not confirmed.":
    "这个基因保留原来的位置。下面的基因都只是候选：它们没有指派亚基因组，也没有得到确认。",
  "Original location": "原始位置", "Why it is flagged": "标记原因",
  "Nearby genes: many genes around it point to another chromosome, so it is flagged with them.": "周围的基因：它周围有很多基因指向另一条染色体，所以跟着一起被标记。",
  "This gene: among other annotations that have a syntenic partner for it, most place that partner on a different chromosome.": "这个基因：在有它的共线伙伴的其他注释中，多数把伙伴放在另一条染色体上。",
  "Chromosome suggested by other annotations": "其他注释指向的染色体", "Not settled": "未确定", "Where other annotations place it": "其他注释把它放在哪里",
  "Not counted: cross-chromosome partners in fewer than 3 annotations": "未统计：有跨染色体伙伴的注释不到 3 套", "No result": "没有结果", "Flagged region": "标记区段",
  "How this gene was flagged": "这个标记是怎么来的", "Inspect the underlying pairwise evidence.": "请查看底层的成对证据。",
  "Candidate": "候选基因", "Status / evidence": "状态 / 证据", "No pairwise evidence recorded": "没有记录成对证据",
  "No syntenic or OrthoFinder candidate was recorded in this annotation.": "这套注释中没有记录到共线或 OrthoFinder 候选。",
  "all hits and related genes": "全部命中和相关基因",
  // 泛基因条目弹窗 / pan-gene entry dialog
  "Standard member is a GENESPACE membership category, not a confidence score. Added via orthology means linked to the group's representative by OrthoFinder; it does not imply a direct match to every member.":
    "“标准成员”是 GENESPACE 的成员类别，不是置信度。“经直系同源加入”指通过 OrthoFinder 与条目的代表基因相连，不代表与每个成员都直接匹配。",
  "Chromosome": "染色体", "Membership": "成员类型", "Your query": "你的查询", "Technical details": "技术细节",
  "Original flag": "原始标记", "Interpolated chromosome": "插值染色体", "Gene-order position": "基因顺序位置", "Not assigned": "未分配",
  // 功能注释面板 / functional annotation panel
  "Computational predictions from six tools, shown as each tool reported them.": "六个工具的计算预测，按各工具的原始结果显示。",
  "Transcript": "转录本", "(representative)": "（代表）", "Annotation tool": "注释工具",
  "Arabidopsis gene": "拟南芥基因", "Symbol": "符号", "Description": "描述", "Identity (%)": "一致性（%）",
  "Aligned (aa)": "比对长度（aa）", "Query cov. (%)": "查询覆盖度（%）", "Subject cov. (%)": "目标覆盖度（%）",
  "Bit score": "比特得分", "Swiss-Prot entry": "Swiss-Prot 条目", "Protein": "蛋白", "Organism": "物种",
  "RefSeq protein": "RefSeq 蛋白",
  "DIAMOND blastp (sensitive mode): E-value ≤ 1e-5, identity ≥ 30%, and at least 50% of both proteins aligned. Top 5 Arabidopsis genes, best isoform of each (TAIR10 proteins from Ensembl Plants).":
    "DIAMOND blastp（sensitive 模式）：E 值 ≤ 1e-5，一致性 ≥ 30%，且两个蛋白都至少有 50% 参与比对。列出前 5 个拟南芥基因，每个基因取最佳的异构体（TAIR10 蛋白来自 Ensembl Plants）。",
  "DIAMOND blastp (sensitive mode): E-value ≤ 1e-5, identity ≥ 30%, and at least 50% of both proteins aligned. Top 5 hits.":
    "DIAMOND blastp（sensitive 模式）：E 值 ≤ 1e-5，一致性 ≥ 30%，且两个蛋白都至少有 50% 参与比对。列出前 5 个命中。",
  "Preferred name": "首选名称", "COG category": "COG 类别", "Seed ortholog": "起始直系同源基因（seed ortholog）", "Orthologous groups": "直系同源组",
  "Annotation level": "注释层级", "KEGG pathway": "KEGG 通路", "KEGG module": "KEGG 模块", "KEGG reaction": "KEGG 反应",
  "KEGG reaction class": "KEGG 反应类别", "BiGG reaction": "BiGG 反应", "Show GO terms": "显示 GO 术语", "obsolete": "已废弃",
  "unknown category": "未知类别",
  "eggNOG-mapper transfers annotation from orthologs found in eggNOG (Viridiplantae). GO terms are inferred from those orthologs, not from experiments on this gene.":
    "eggNOG-mapper 从 eggNOG（绿色植物）中找到的直系同源基因转移注释。GO 术语来自这些直系同源基因，不是对这个基因做的实验。",
  "eggNOG-mapper reported no annotation for this protein.": "eggNOG-mapper 没有为这个蛋白报告注释。",
  "KofamScan reported no row for this protein.": "KofamScan 没有为这个蛋白报告任何行。",
  "InterProScan found no match in any of its member databases.": "InterProScan 在所有成员数据库中都没有找到匹配。",
  "Above threshold": "超过阈值", "Definition": "定义", "Threshold": "阈值", "Score": "得分", "Yes": "是", "No": "否",
  "Database": "数据库", "Signature": "特征码", "Start": "起点", "End": "终点", "Score or E-value": "得分或 E 值",
  "InterPro entry": "InterPro 条目", "from InterPro": "来自 InterPro", "from PANTHER": "来自 PANTHER",
  "Every InterProScan match, sorted by position. GO terms come from the InterPro entry (InterPro2GO) or the PANTHER family. MobiDBLite marks disordered regions and Coils coiled coils.":
    "全部 InterProScan 匹配，按位置排序。GO 术语来自 InterPro 条目（InterPro2GO）或 PANTHER 家族。MobiDBLite 标出无序区，Coils 标出卷曲螺旋。",
  "Download this table (TSV)": "下载此表（TSV）", "Download all for this gene (JSON)": "下载这个基因的全部结果（JSON）",
  "This tool's rows for the selected transcript, as a tab-separated file": "所选转录本在这个工具中的各行，制表符分隔文件",
  "Every transcript and tool for this gene, with the column names": "这个基因所有转录本和工具的结果，附列名",
  "About these results": "关于这些结果", "an internal stop codon": "含内部终止密码子",
  "the functional annotation was built from a different data release": "功能注释来自另一个数据版本",
  // 序列比对 / alignment
  "Loading genes and transcript options…": "正在载入基因和转录本选项…", "Loading the candidate gene list…": "正在载入候选基因列表…",
  "Compare copies in": "比较拷贝：", "Alignment subgenome": "比对的亚基因组", "Alignment selection": "比对选择",
  "Candidate genes and transcripts": "候选基因和转录本", "Include": "纳入", "Protein (aa)": "蛋白（aa）",
  "Predicted pick": "预测选择", "predicted pick": "预测选择", "CDS: translation verified": "CDS：翻译已核对",
  "Run alignment": "开始比对", "Select all genes": "全选基因", "Clear genes": "清空基因", "Download selection (TSV)": "下载所选（TSV）",
  "Stored comparison of the original query and target representative proteins. Selecting another transcript does not recalculate these values.":
    "原始查询基因与目标基因代表蛋白之间的已存比较。改选其他转录本不会重新计算这些数值。",
  "Identity in the original representative-protein alignment": "原始代表蛋白比对中的一致性",
  "Fraction of each protein covered by the original alignment": "原始比对覆盖每个蛋白的比例",
  "Alignment result": "比对结果", "location unavailable": "位置不可用", "lower coverage": "覆盖度较低", "Lower coverage": "覆盖度较低",
  "coverage unavailable": "覆盖度不可用", "Choose at least two genes to run an alignment.": "至少选两个基因才能比对。",
  "Why no candidate?": "为什么没有候选？", "Query gene": "查询基因", "query gene": "查询基因", "Sequence alternative": "备选序列",
  "sequence match": "序列匹配", "Match scores still use the default transcript.": "匹配得分仍按默认转录本计算。",
  "Candidate genes": "候选基因", "Genes without an available sequence cannot be selected.": "没有可用序列的基因不能选。",
  "Selection changed. Run alignment to compare the selected genes.": "选择已改变。点“开始比对”比较所选基因。",
  "Selection changed. Run alignment to compare the selected transcripts.": "选择已改变。点“开始比对”比较所选转录本。",
  "No stored candidate is available.": "没有可用的已存候选。", "Query transcripts": "查询转录本",
  "Run again": "重新比对", "Download alignment (FASTA)": "下载比对（FASTA）", "Download proteins (FASTA)": "下载蛋白（FASTA）",
  "Download members (TSV)": "下载成员（TSV）", "Annotation / gene": "注释 / 基因", "Conservation": "保守度",
  "Scroll horizontally for the full alignment. Numbers refer to alignment columns; “-” is a gap and X is an unknown residue. Conservation is the most frequent known residue divided by all displayed proteins, including rows with gaps.":
    "横向滚动查看完整比对。数字是比对列号；“-”是空位，X 是未知残基。保守度 = 出现最多的已知残基数 ÷ 显示的蛋白总数（有空位的行也算在内）。",
  "Hydrophobic": "疏水", "Basic": "碱性", "Acidic": "酸性", "Polar": "极性",
  "Alignment method and sequence source": "比对方法与序列来源",
  "Kalign 3.3.1: --format fasta; default protein scoring and gap penalties. The recorded protein normalization is retained; source sequences and normalization records remain in the data shards.":
    "Kalign 3.3.1：--format fasta；使用默认的蛋白打分和空位罚分。保留已记录的蛋白规范化；原始序列和规范化记录都在数据分片里。",
  "Sequences load on demand. Choosing transcripts changes this alignment only; gene-level evidence is unchanged.":
    "序列按需载入。改选转录本只影响这个比对，基因层面的证据不变。",
  "Sequence data index": "序列数据索引", "Kalign source and license": "Kalign 源代码与许可", "Sequence type": "序列类型",
  "Aligned amino acids": "比对后的氨基酸", "Aligned coding bases": "比对后的编码碱基", "Residue colour key": "残基颜色说明",
  "CDS (bases)": "CDS（碱基）", "Sequence alignment · selected genes": "序列比对 · 所选基因",
  "Sequence alignment · selected transcripts": "序列比对 · 所选转录本", "CDS sequences": "CDS 序列",
  "Representative proteins": "代表蛋白", "Alignment cancelled.": "比对已取消。",
  "Download CDS alignment (FASTA)": "下载 CDS 比对（FASTA）", "Download CDS (FASTA)": "下载 CDS（FASTA）", "Ambiguous": "不确定",
  "CDS codons follow the protein alignment: each protein gap becomes three base gaps. Numbers are CDS alignment columns, not genomic coordinates. Terminal stop codons are retained in the original CDS download and excluded from this view. Ambiguous bases do not contribute to conservation. Bases are displayed in uppercase; downloads retain source case.":
    "CDS 密码子跟随蛋白比对：蛋白的每个空位变成三个碱基空位。数字是 CDS 比对列号，不是基因组坐标。末端终止密码子保留在原始 CDS 下载文件里，但不在这个视图中显示。不确定的碱基不计入保守度。碱基一律以大写显示；下载文件保留原始大小写。",
  "Each verified CDS codon follows the selected transcript's protein alignment. CDS translation, identifiers and checksums must match that exact protein.":
    "每个经核对的 CDS 密码子都跟随所选转录本的蛋白比对。CDS 的翻译、ID 和校验值必须与那条蛋白完全一致。",
  "Alignment exceeded its time limit. Try fewer or shorter proteins.": "比对超时。请减少蛋白数量或换短一些的蛋白。",
  "The browser alignment engine could not run. Please reload and try again.": "浏览器比对引擎无法运行。请刷新页面后再试。",
  "This browser does not support the WebAssembly worker required for alignment.": "这个浏览器不支持比对所需的 WebAssembly worker。",
  "Protein alignment failed.": "蛋白比对失败。",
  // 消息 / messages
  "A file needed for this query is missing from the published dataset. Please try again later.": "已发布的数据集中缺少这次查询需要的文件，请稍后再试。",
};

// 带数字、名字的句式；替换可以是字符串（$1…）或函数（返回 null 表示不翻）
// Sentences with numbers or names; a replacement is a string ($1…) or a function (null means: leave it in English)
const ZH_PATTERNS = [
  [/^(.+) · Camelina sativa Pan-Gene Database$/, "$1 · 亚麻荠泛基因数据库"],
  [/^(\d+) annotations$/, "$1 套注释"],
  [/^(\d+) accessions$/, "$1 个品种"],
  [/^(\d+) annotations of (\d+) accessions; click for their sources, BUSCO and placement$/, "$2 个品种的 $1 套注释；点击查看来源、BUSCO 和定位比例"],
  [/^From ([\d,]+) \((.+)\) to ([\d,]+) \((.+)\); click for every annotation$/, "从 $1（$2）到 $3（$4）；点击查看每套注释"],
  [/^([\d,]+) OrthoFinder gene families; ([\d,]+) occur in all (\d+) accessions\. Click for the distribution$/,
    "$1 个 OrthoFinder 基因家族，其中 $2 个在全部 $3 个品种中都有。点击查看分布"],
  [/^Data from (\d+) Camelina sativa annotations\.$/, "数据来自 $1 套亚麻荠注释。"],
  [/^Data from (\d+) Camelina sativa annotations · analysis (\S+) · data revision (\w+)$/, "数据来自 $1 套亚麻荠注释 · 分析 $2 · 数据版本 $3"],
  [/^Analysis (\S+) · data revision (\w+)$/, "分析 $1 · 数据版本 $2"],
  [/^Protein hits are ranked by bit score\. Each search reports up to (\d+) targets; supplementary searches may add further candidates\.$/,
    "蛋白命中按比特得分排序。每次搜索最多报告 $1 个目标；补充搜索可能加入更多候选。"],
  // 注释与来源表 / Annotations and sources
  [/^(\d+) annotations of (\d+) accessions · data release (\S+)$/, "$2 个品种的 $1 套注释 · 数据版本 $3"],
  [/^([\d,]+) by gene · ([\d,]+) by region$/, "按基因 $1 · 按区段 $2"],
  [/^([\d,]+) bp; recomputed from the assembly FASTA$/, "$1 bp；由组装 FASTA 重新计算"],
  [/^([\d,]+) of ([\d,]+) genes$/, "$2 个基因中的 $1 个"],
  [/^([\d,]+) of ([\d,]+) analysed genes$/, "$2 个已分析基因中的 $1 个"],
  [/^([\d,]+) of ([\d,]+) analysed genes \((.+)\)$/, "$2 个已分析基因中的 $1 个（$3）"],
  [/^Details for (.+)$/, "$1 的详情"],
  [/^same assembly as (.+)$/, "与 $1 为同一组装"],
  [/^(.+) in ([\d,]+) sequences \(FASTA records\); (.+) on Chr01–Chr20, (.+) on ([\d,]+) other sequences?$/,
    "$1，共 $2 条序列（FASTA 记录）；$3 在 Chr01–Chr20 上，$4 在其余 $5 条序列上"],
  [/^(.+) in ([\d,]+) sequences \(FASTA records\); all on Chr01–Chr20$/, "$1，共 $2 条序列（FASTA 记录）；全部在 Chr01–Chr20 上"],
  [/^Contig N50 ([\d,]+) bp \(([\d.,]+) Mb\); scaffold N50 ([\d,]+) bp \(([\d.,]+) Mb\)\. ([\d,]+) gaps? of 10 or more N \((.+) in all\); ([\d,]+) contigs after splitting at them\.$/,
    "Contig N50 $1 bp（$2 Mb）；scaffold N50 $3 bp（$4 Mb）。$5 个不少于 10 个 N 的缺口（共 $6）；按缺口切开后有 $7 个 contig。"],
  [/^(.+)\. Source: (.+)\.$/, "$1。来源：$2。"],
  [/^BUSCO \(n = ([\d,]+)\)$/, "BUSCO（n = $1）"],
  [/^1 copy ([\d,]+) · 2 copies ([\d,]+) · 3 copies ([\d,]+) · 4 or more ([\d,]+)$/, "1 个拷贝 $1 · 2 个拷贝 $2 · 3 个拷贝 $3 · 4 个及以上 $4"],
  [/^([\d,]+) in all; ([\d,]+) analysed \(on Chr01–Chr20 with a usable protein\); not analysed: ([\d,]+) with a protein off Chr01–Chr20, ([\d,]+) without a usable protein$/,
    "共 $1；已分析 $2 个（在 Chr01–Chr20 上且有可用蛋白）；未分析：$3 个有蛋白但不在 Chr01–Chr20 上，$4 个没有可用蛋白"],
  [/^([\d,]+): ([\d,]+) by gene, ([\d,]+) by region$/, "$1：按基因 $2，按区段 $3"],
  [/^BUSCO (\S+) in protein mode with (\S+) \(([\d,]+) conserved genes\), one representative protein per gene, the same for every annotation\. C complete, M missing; Details add S single-copy, D duplicated, F fragmented and the number of complete copies\. In this hexaploid a high D is expected; a high C does not show that all three subgenome copies are complete\.$/,
    "BUSCO $1 蛋白模式，谱系 $2（$3 个保守基因），每个基因一条代表蛋白，所有注释都一样。C 为完整，M 为缺失；详情里另有 S 单拷贝、D 重复、F 片段化，以及完整拷贝数。在这个六倍体中 D 高是预期的；C 高并不说明三个亚基因组拷贝都完整。"],
  [/^The annotation figures could not be loaded \((.+)\)\. Close and reopen this panel to try again\.$/, "注释统计载入失败（$1）。关掉这个面板再打开即可重试。"],
  [/^Assembly figures could not be loaded \((.+)\)\. N50 is unavailable; close and reopen this panel to retry\.$/, "组装统计载入失败（$1）。N50 暂不可用；关掉面板再打开即可重试。"],
  // 基因数和家族面板 / gene-count and family panels
  [/^([\d,]+) in all (\d+) annotations$/, "全部 $2 套注释共 $1 个"],
  [/^([\d,]+) families from ([\d,]+) genes$/, "$1 个家族，来自 $2 个基因"],
  [/^Number of accessions with the family \(of (\d+)\)$/, "含有该家族的品种数（共 $1 个）"],
  [/^In 1 accession only: ([\d,]+) families \(([\d.]+%)\)$/, "只在 1 个品种中：$1 个家族（$2）"],
  [/^In all (\d+) accessions \(core\): ([\d,]+) families \(([\d.]+%)\)$/, "在全部 $1 个品种中（核心）：$2 个家族（$3）"],
  [/^In (\d+) accessions: ([\d,]+) families \(([\d.]+%)\)$/, "在 $1 个品种中：$2 个家族（$3）"],
  [/^([\d,]+) families \(([\d,]+) genes, (\d+)% of the genes in families\) occur in all (\d+) accessions\. Most families seen in only one or two accessions involve only DH55 and Suneson, the two accessions with annotations made outside the JGI pipeline: ([\d,]+) are only in Suneson, ([\d,]+) only in DH55 and ([\d,]+) only in DH55 and Suneson, and ([\d,]+) of them contain no gene from a JGI-pipeline annotation\. The (\d+) accessions annotated only by the JGI pipeline have 0–(\d+) accession-specific families each\. These columns therefore mostly reflect how the annotations were made\.$/,
    "$1 个家族（$2 个基因，占家族内基因的 $3%）在全部 $4 个品种中都有。只在一两个品种中出现的家族，大多只涉及 DH55 和 Suneson——这两个品种的注释是在 JGI 流程之外做的：$5 个只在 Suneson 中，$6 个只在 DH55 中，$7 个只在 DH55 和 Suneson 中，其中 $8 个不含任何 JGI 流程注释的基因。只用 JGI 流程注释的 $9 个品种，每个只有 0–$10 个品种特有家族。所以这几列主要反映注释是怎么做的。"],
  [/^A family is an OrthoFinder orthogroup: genes that OrthoFinder groups as descending from one ancestral gene, judged by protein similarity across the (\d+) annotations\. It is not a homeolog group: in (\S+), (\d+)% of the families that contain a \2 gene hold one such gene, (\d+)% two, (\d+)% three and (\d+)% four or more, so the three subgenome copies of a locus are often in different families; the groups G1–G7 above are a chromosome map, not a similarity cluster\. ([\d,]+) genes were not placed in any family\.$/,
    "一个家族是一个 OrthoFinder 直系同源组：OrthoFinder 按 $1 套注释之间的蛋白相似性，判定为来自同一个祖先基因的一组基因。它不是部分同源组：以 $2 为例，在含 $2 基因的家族中，$3% 只含 1 个 $2 基因，$4% 含 2 个，$5% 含 3 个，$6% 含 4 个以上，所以一个位点的三个亚基因组拷贝常常分在不同的家族里；上面的 G1–G7 是按染色体划分的组，不是相似性聚类。$7 个基因没有归入任何家族。"],
  // 查询和基因卡片 / lookup and gene card
  [/^ID “(.+)” was not found in (.+)\. IDs are case-sensitive\.$/, "在 $2 中找不到 ID “$1”。ID 区分大小写。"],
  [/^ID “(.+)” was not found\. IDs are case-sensitive\.$/, "找不到 ID “$1”。ID 区分大小写。"],
  [/^“(.+)” matches multiple genes; choose one:$/, "“$1” 对应多个基因，请选择一个："],
  [/^“(.+)” is part of the merged gene ID (.+)\. (.+)$/, (all, typed, id, note) => `“${typed}” 是合并基因 ID ${id} 的一部分。${zhPart(note)}`],
  [/^“(.+)” maps to gene (.+)\. (.+)$/, (all, typed, id, note) => `“${typed}” 对应基因 ${id}。${zhPart(note)}`],
  [/^Could not load the data description \(manifest\.json\): (.+)$/, "无法载入数据说明（manifest.json）：$1"],
  [/^Could not load the data: (.+)$/, "无法载入数据：$1"],
  [/^(.+) bp · ([+-]) strand$/, "$1 bp · $2 链"],
  [/^View (\d+) groups?$/, "查看 $1 个条目"],
  [/^Reference annotation: (.+)\. A group can contain several copies; being in a group is not a direct pairwise match\.$/,
    "参考注释：$1。一个条目可以包含多个拷贝；同属一个条目不等于两两直接匹配。"],
  [/^Group (\d+)$/, "条目 $1"],
  [/^(\d+) of (\d+) selected$/, "已选 $1/$2"],
  // 部分同源页 / Homeologs view
  [/^(SG\d) column$/, "$1 列"],
  [/^Show (G\d+) in the figure$/, "在图中显示 $1"],
  [/^(\S+) is on (\S+), subgenome (SG\d), homeolog group (G\d+):$/, "$1 位于 $2，亚基因组 $3，部分同源组 $4："],
  [/^([\d.]+)% · cov ([\d.]+)\/([\d.]+) ·$/, "$1% · 覆盖 $2/$3 ·"],
  [/^\+(\d+) candidates?$/, "+$1 个候选"],
  [/^Choose genes and transcripts for (SG\d)$/, "选择 $1 的基因和转录本"],
  [/^No subgenome prediction for (\S+): (.+)\. The closest sequence match in each annotation is shown instead\.$/,
    (all, id, note) => `${id} 没有亚基因组预测：${zhPart(note)}。改为显示每套注释中序列最接近的匹配。`],
  [/^(\S+) is not one of Chr01-Chr20$/, "$1 不在 Chr01–Chr20 之中"],
  [/^Each cell: gene · identity · coverage of the query \/ of that gene · evidence · near-equal candidates\. Subgenome names: (.+?)\. (Corresponding genes across .+)$/,
    (all, naming, caveat) => "每个格子：基因 · 一致性 · 覆盖度（查询基因 / 该基因）· 证据 · 相近候选。亚基因组命名依 "
      + naming.replace("; homeolog groups as in ", "；部分同源组依 ") + "。" + zhPart(caveat)],
  // 证据标签的读屏文字："标签. 说明" / screen-reader text of an evidence badge: "label. explanation"
  [/^(the query|to verify|synteny \+ OrthoFinder|synteny only|OrthoFinder only|sequence only \(≥ 97% identity\)|partner supported|cross-checked|sequence only|sequence only, near-equal candidates|found via homeolog)\. (.+)$/,
    (all, label, text) => `${zhPart(label)}。${zhPart(text)}`],
  // 证据种类连在一起（"A + B"）/ evidence kinds joined ("A + B")
  [/^(?:synteny|cross-chromosome synteny|OrthoFinder|protein sequence|found via homeolog|the query)(?: \+ (?:synteny|cross-chromosome synteny|OrthoFinder|protein sequence|found via homeolog|the query))+$/,
    (all) => all.split(" + ").map(zhPart).join(" + ")],
  [/^to verify · (.+)$/, (all, kinds) => `待核实 · ${zhPart(kinds)}`],
  // Sentences of flags and reasons with gene names or numbers; a text of several sentences is split in lookup()
  [/^The search keeps at most (\d+) matches per protein, and the list was full\.$/, "每个蛋白的搜索最多保留 $1 个匹配，这次名单已满。"],
  [/^The check through the query's homeolog points to a different gene: (\S+)\.$/, "经查询基因的部分同源基因核对，指向另一个基因：$1。"],
  [/^The check through the query's homeolog points to (\S+), but no match to the query is stored\.$/,
    "经查询基因的部分同源基因核对，指向 $1，但没有存下它与查询基因的匹配。"],
  [/^The check through the query's homeolog points to (\S+), but its protein match is below 80% identity or 50% coverage\.$/,
    "经查询基因的部分同源基因核对，指向 $1，但它的蛋白匹配低于 80% 一致性或 50% 覆盖度。"],
  [/^The check through the query's homeolog points to (\S+), but that gene is on the other part of a composite chromosome\.$/,
    "经查询基因的部分同源基因核对，指向 $1，但这个基因在复合染色体的另一段上。"],
  [/^(\S+) on (\S+) matches, but it lies on the other part of that composite chromosome \(group (G\d+)\)\.$/,
    "$2 上的 $1 能匹配上，但它在这条复合染色体的另一段上（$3 组）。"],
  [/^Matches on (\S+) are below 80% identity or 50% coverage\.$/, "$1 上的匹配低于 80% 一致性或 50% 覆盖度。"],
  [/^The only matches on (\S+) are genes whose position needs checking\.$/, "$1 上的匹配全都是位置待核实的基因。"],
  [/^No stored protein match on (\S+)\.$/, "$1 上没有已存的蛋白匹配。"],
  [/^A good match is on an unplaced sequence: (\S+) on (\S+), ([\d.]+)% identity, coverage (\d+)\/(\d+)\.$/,
    "未定位序列上有一个较好的匹配：$2 上的 $1，一致性 $3%，覆盖度 $4/$5。"],
  [/^The best copy is on an unplaced sequence: (\S+) on (\S+), ([\d.]+)% identity, coverage (\d+)\/(\d+)\.$/,
    "最好的拷贝在未定位序列上：$2 上的 $1，一致性 $3%，覆盖度 $4/$5。"],
  [/^No corresponding gene found on (\S+) under the current rules: no syntenic or OrthoFinder partner, and no stored copy at least 97% identical\.$/,
    "按当前规则，$1 上未找到对应基因：既没有共线或 OrthoFinder 伙伴，也没有已存的一致性达到 97% 的拷贝。"],
  [/^It has cross-chromosome partners in fewer than (\d+) annotations, too few to judge on its own\.$/,
    "它只在不到 $1 套注释中有跨染色体伙伴，太少，无法单独判断。"],
  [/^Copies at least 97% identical are only on (\S+(?:, \S+)*)\.$/, "一致性达到 97% 的拷贝只在 $1 上。"],
  [/^Syntenic or OrthoFinder partners are only on (\S+(?:, \S+)*)\.$/, "共线或 OrthoFinder 伙伴只在 $1 上。"],
  [/^(\S+) has more evidence: both synteny and OrthoFinder\.$/, "$1 的证据更多：共线性和 OrthoFinder 都有。"],
  [/^(\S+) is a complete, near-identical copy \(([\d.]+)% identical\)\.$/, "$1 是一个完整且几乎相同的拷贝（一致性 $2%）。"],
  [/^(\S+) is the syntenic anchor at this position\.$/, "$1 是这个位置的共线锚点。"],
  [/^(\S+) is near-identical \(([\d.]+)%\) but covers only (\d+)% of the query\.$/, "$1 几乎相同（$2%），但只覆盖查询基因的 $3%。"],
  [/^(\S+) is near-identical \(([\d.]+)%\) but only (\d+)% of it aligns\.$/, "$1 几乎相同（$2%），但它只有 $3% 比对上。"],
  [/^(\S+) has a much higher score: (\d+) bits against (\d+)\.$/, "$1 的得分高得多：$2 比特对 $3 比特。"],
  [/^(This gene|\S+) (is|was left out: it is) on (\S+) here, but (\d+) of (\d+) annotations place its syntenic partner on (\S+(?: or \S+)*)\.$/,
    (all, gene, verb, on, n, total, where) => `${zhSubject(gene, verb)}在这里位于 ${on}，`
      + `但 ${total} 套注释中有 ${n} 套把它的共线伙伴放在 ${where.replace(/ or /g, " 或 ")} 上。`],
  [/^(This gene|\S+) (is|was left out: it is) on (\S+) here, but its syntenic partners point to (\S+(?: or \S+)*), (\d+) of (\d+) annotations each\.$/,
    (all, gene, verb, on, where, n, total) => `${zhSubject(gene, verb)}在这里位于 ${on}，`
      + `但它的共线伙伴指向 ${where.replace(/ or /g, " 或 ")}，${total} 套注释中各有 ${n} 套。`],
  [/^(This gene|\S+) (is|was left out: it is) on (\S+) here, in a ([\d.]+)–([\d.]+) Mb region where (\d+) of (\d+) genes point to (\S+)\.$/,
    (all, gene, verb, on, from, to, n, total, target) => `${zhSubject(gene, verb)}在这里位于 ${on} 的 ${from}–${to} Mb 区段，`
      + `这个区段 ${total} 个基因中有 ${n} 个指向 ${target}。`],
  [/^On its own: (.+) of (\d+) annotations\.$/, "单看它自己：$2 套注释中 $1。"],
  [/^In the Homeologs view: (.+)$/, (all, text) => `在部分同源视图中：${zhPart(text)}`],
  // 详情弹窗 / details dialogs
  [/^(\S+): (SG\d) copy in (.+)$/, "$1：$3 中的 $2 拷贝"],
  [/^(\S+): candidate in (.+)$/, "$1：$2 中的候选基因"],
  [/^\((\S+) unassigned, (.+)\)$/, "（$1 未分配，$2）"],
  [/^([\d.]+)% identity, coverage ([\d.]+)% of the query \/ ([\d.]+)% of this gene, (\d+) bits, rank (\d+) among all stored candidates in (.+)$/,
    "一致性 $1%，覆盖查询基因 $2% / 该基因 $3%，$4 比特，在 $6 的全部已存候选中排第 $5"],
  [/^not found under the current rules \((\S+) copy in (.+)\)$/, "按当前规则未找到（$2 中的 $1 拷贝）"],
  [/^(Copy on an unplaced sequence|Other partners|Near-equal candidates) \((\d+)\)$/,
    (all, title, n) => `${{ "Copy on an unplaced sequence": "未定位序列上的拷贝", "Other partners": "其他伙伴基因",
      "Near-equal candidates": "相近候选" }[title]}（${n}）`],
  [/^\(([\d,]+) bits\)$/, "（$1 比特）"],
  [/^… and (\d+) more$/, "……还有 $1 个"],
  [/^all hits and related genes in (.+)$/, "$1 中的全部命中和相关基因"],
  [/^(\d+) bits, E-value (\S+), identity ([\d.]+)%, alignment length ([\d,]+) aa$/, "$1 比特，E 值 $2，一致性 $3%，比对长度 $4 aa"],
  [/^query ([\d,]+)–([\d,]+) \(([\d.]+)% of the query protein\); target ([\d,]+)–([\d,]+) \(([\d.]+)% of the target protein\)$/,
    "查询 $1–$2（查询蛋白的 $3%）；目标 $4–$5（目标蛋白的 $6%）"],
  [/^(\S+) \((\S+) proteins\) against (\S+) \((\S+)\), at most (\d+) targets reported, target database ([\d,]+) residues$/,
    (all, query, qScope, target, tScope, max, letters) => {
      const scope = (s) => ({ placed: "已定位", unplaced: "未定位", all: "全部" }[s] || s);
      return `${query}（${scope(qScope)}蛋白）对 ${target}（${scope(tScope)}）搜索，最多报告 ${max} 个目标，目标库 ${letters} 个残基`;
    }],
  [/^orthogroup (\S+) \(pairwise row (\S+) of run (\S+)\)$/, "直系同源组 $1（运行 $3 的成对记录 $2）"],
  [/^(entry \S+(?:, entry \S+)*) with (.+) as reference annotation, run (\S+)$/,
    (all, entries, frame, run) => `${entries.replace(/entry /g, "条目 ").replace(/, /g, "、")}（运行 ${run}，参考注释 ${frame}）`],
  [/^run (\S+); source database SHA-256 (\S+); evidence identifiers require their source run\.$/,
    "运行 $1；源数据库 SHA-256 $2；证据编号要和来源运行一起看。"],
  // 共线块名称（可能几个连在一起）：只换 "(anchor)" 和"未归入共线块"两处 / synteny block names (possibly several joined):
  // only "(anchor)" and the no-block text change; the last argument is the whole text
  [/\(anchor\)|syntenic region \(no block assigned\)/,
    (...args) => args.at(-1).replace(/ \(anchor\)/g, "（锚点）").replace(/syntenic region \(no block assigned\)/g, "共线区域（未归入共线块）")],
  [/^Ranked after the top (\d+)$/, "排在前 $1 名之后"],
  [/^Cross-chromosome (anchor pair|syntenic pair) from (.+)\. This does not by itself establish orthology or a translocation\.$/,
    (all, kind, run) => `来自 ${run} 的跨染色体${kind === "anchor pair" ? "锚点对" : "共线对"}。仅凭这一点不能确定直系同源或易位。`],
  [/^Pan-gene group (\d+)$/, "泛基因条目 $1"],
  [/^(\d+) members across (\d+) annotations · reference annotation (.+)$/, "$1 个成员，分布在 $2 套注释中 · 参考注释 $3"],
  [/^Run (\S+) · reference annotation (\S+) · pgID (\S+)\. Cite this combination; group numbers differ between reference annotations\. Interpolated positions use gene order, not base pairs\.$/,
    "运行 $1 · 参考注释 $2 · pgID $3。引用时请写全这一组合：不同参考注释的条目编号不同。插值位置按基因顺序，不是碱基位置。"],
  // 证据页 / Evidence view
  [/^(\d+) candidates?$/, "$1 个候选"],
  [/^Hits in (.+)$/, "$1 中的命中"],
  [/^Related genes in (.+)$/, "$1 中的相关基因"],
  [/^(\d+) near-equal$/, "$1 个相近"],
  [/^Best hit is on (\S+), not (\S+)$/, "最佳命中在 $1 上，不在 $2 上"],
  [/^(\d+) other hits? within 95% of the best bit score$/, "另有 $1 个命中的比特得分在最佳值的 95% 以内"],
  [/^(.+) bp · ([\d.]+)% identity · (\d+) bits$/, "$1 bp · 一致性 $2% · $3 比特"],
  // 待核实 / position to verify
  [/^(.+) bp\. Here ([\d,]+) of ([\d,]+) genes point to (\S+)\. These limits mark what to check; they are not proven rearrangement breakpoints\.$/,
    "$1 bp。这里 $3 个基因中有 $2 个指向 $4。这个范围只是提示要核查的位置，不是已证实的重排断点。"],
  [/^(\d+) of (\d+) candidates shown here\. Evidence → Related genes lists every stored pairwise relationship\.$/,
    "这里显示 $2 个候选中的 $1 个。证据 → 相关基因 列出全部已存的成对关系。"],
  // 功能注释面板 / functional annotation panel
  [/^Transcript \((\d+)\)$/, "转录本（$1）"],
  [/^(.+) · representative · ([\d,]+) aa$/, "$1 · 代表 · $2 aa"],
  [/^(.+) · representative$/, "$1 · 代表"],
  [/^(.+) · no protein sequence$/, "$1 · 没有蛋白序列"],
  [/^(.+) · excluded by QC$/, "$1 · 已被质控排除"],
  [/^· protein ([\d,]+) aa$/, "· 蛋白 $1 aa"],
  [/^GO terms \((\d+)\)$/, "GO 术语（$1）"],
  [/^No (TAIR10|Swiss-Prot|RefSeq) hit\. DIAMOND blastp \(sensitive mode\): E-value ≤ 1e-5, identity ≥ 30%, and at least 50% of both proteins aligned\.$/,
    "没有 $1 命中。DIAMOND blastp（sensitive 模式）：E 值 ≤ 1e-5，一致性 ≥ 30%，且两个蛋白都至少有 50% 参与比对。"],
  [/^(\d+) rows? above the KO's own score threshold \(the KO assignments\)\. Showing (\d+) of the (\d+) rows? KofamScan reported for this protein: every row above its threshold, then the next rows in KofamScan's order\.$/,
    "$1 行超过该 KO 自己的得分阈值（即 KO 指派）。显示 KofamScan 对这个蛋白报告的 $3 行中的 $2 行：先是所有超过阈值的行，再按 KofamScan 的顺序补上后面的行。"],
  [/^Positions of (\d+) InterProScan match(?:es)? along the ([\d,]+)-aa protein; the table below lists them$/, "$1 个 InterProScan 匹配在 $2 aa 蛋白上的位置；下表逐条列出"],
  [/^This transcript is a (\S+), a non-coding RNA, so there is no protein to annotate\.$/, "这个转录本是 $1，属于非编码 RNA，没有可注释的蛋白。"],
  [/^No protein sequence is available for this (\S+): the annotation gives it no usable coding sequence, so the tools were not run on it\.$/,
    "这个 $1 没有可用的蛋白序列：注释没有给它可用的编码序列，所以没有对它运行这些工具。"],
  [/^This transcript's protein was excluded by quality control \((.+)\), so no tool was run on it\.$/,
    (all, reason) => `这个转录本的蛋白在质控中被排除（${zhPart(reason)}），所以没有运行任何工具。`],
  [/^This transcript's protein is not available \((.+)\), so no tool was run on it\.$/, "这个转录本的蛋白不可用（$1），所以没有运行任何工具。"],
  [/^Not available for this gene: (.+)\.$/, (all, reason) => `这个基因没有功能注释：${zhPart(reason)}。`],
  [/^TAIR10, Swiss-Prot and RefSeq: (.+)\. Database files built (\S+) \(TAIR10\), (\S+) \(Swiss-Prot\) and (\S+) \(RefSeq plant proteins\)\.$/,
    "TAIR10、Swiss-Prot 和 RefSeq：$1。数据库文件构建于 $2（TAIR10）、$3（Swiss-Prot）和 $4（RefSeq 植物蛋白）。"],
  [/^eggNOG: (.+), eggNOG database (\S+), taxonomic scope (.+)\.$/, "eggNOG：$1，eggNOG 数据库 $2，分类范围 $3。"],
  [/^KofamScan (\S+), KO list of (\S+)\.$/, "KofamScan $1，KO 列表日期 $2。"],
  [/^InterProScan (\S+); GO names from (\S+)\.$/, "InterProScan $1；GO 名称来自 $2。"],
  [/^Built (\S+)\. These are computational predictions, not experimentally verified functions\.$/, "构建于 $1。这些都是计算预测，不是实验验证的功能。"],
  // 序列比对 / alignment
  [/^Protein identity: (.+)$/, "蛋白一致性：$1"],
  [/^Query coverage: (.+)$/, "查询覆盖度：$1"],
  [/^Target coverage: (.+)$/, "目标覆盖度：$1"],
  [/^(\d+) bits · E-value (\S+)$/, "$1 比特 · E 值 $2"],
  [/^(\d+) stored candidates?$/, "$1 个已存候选"],
  [/^(\d+) of (\d+) genes selected$/, "已选 $1/$2 个基因"],
  [/^Include (\S+) from (.+)$/, "纳入 $2 的 $1"],
  [/^Gene for (.+)$/, "$1 的基因"],
  [/^Transcript for (.+)$/, "$1 的转录本"],
  [/^No subgenome group was assigned \((.+)\)\.$/, (all, note) => `没有指派亚基因组组别（${zhPart(note)}）。`],
  [/^(\d+) proteins aligned in your browser with Kalign (\S+)\.$/, "$1 条蛋白已在浏览器中用 Kalign $2 比对。"],
  [/^Highlight differences from (.+)$/, "突出显示与 $1 的差异"],
  [/^(\d+) proteins · (\d+) alignment columns$/, "$1 条蛋白 · $2 个比对列"],
  [/^First (.+) residue$/, "$1 的第一个残基"],
  [/^First (.+) base$/, "$1 的第一个碱基"],
  [/^(\d+) CDS sequences shown in the protein alignment, with codons kept together\.$/, "$1 条 CDS 按蛋白比对排列，密码子保持完整。"],
  [/^(\d+) CDS sequences · ([\d,]+) alignment columns$/, "$1 条 CDS · $2 个比对列"],
  [/^(CDS|Protein) multiple sequence alignment; scroll horizontally to see all columns$/,
    (all, kind) => `${kind === "CDS" ? "CDS" : "蛋白"}多序列比对；横向滚动查看所有列`],
  [/^(\S+): one selected transcript per included gene\. Starting Homeologs column: (SG\d) \((.+)\)\. Sequence alternatives may be on other chromosomes or unplaced sequences\.$/,
    "$1：每个纳入的基因选一个转录本。起始的部分同源列：$2（$3）。备选序列可能在其他染色体或未定位序列上。"],
  [/^Select between 2 and (\d+) proteins for alignment\.$/, "请选择 2 到 $1 条蛋白进行比对。"],
];

// index.html 里带 data-i18n 键的段落（段落里有 <em>、<code> 等）/ the index.html paragraphs with a data-i18n key
const ZH_HTML = {
  "brand.name": "亚麻荠<strong>泛基因</strong>数据库",
  "hero.title": "亚麻荠<span class=\"keep-together\">泛基因数据库</span>",
  "legend.summary": "<h2>怎么读结果</h2><span class=\"summary-hint\">每一列、每个标签和每种状态的含义</span>",
  "legend.names": "DH55V2 和 DH55V3 是 DH55 的两套注释。SunesonDecker2025（Montana State University，MSU_CS-sun）、SunesonJGI、SunesonFang2023 和 SunesonBrock2024 是 Suneson 的四套注释。下载的表格和数据集文件里，SunesonDecker2025 的数据 ID 是 <code>Suneson</code>。",
  "legend.homeologs": "每套注释一行，每个亚基因组一列。高亮的一列是查询基因自身所在的亚基因组：这套注释里与查询基因对应的基因（染色体编号相同），附带证据。另外两列是它在另外两个亚基因组上的部分同源基因。注释名下面的<em>最佳命中</em>表示最强的蛋白匹配不是这三个基因之一，例如另一条染色体上的拷贝或未定位序列。",
  "legend.evidence": "<em>命中排名</em>列出每套注释中按比特得分排序的最佳蛋白命中；<em>相关基因</em>列出全部共线或 OrthoFinder 伙伴，不论排名。序列最相似的不一定就是对应基因：在六倍体中，另一个亚基因组上的拷贝或一个局部匹配的得分可能比共线的拷贝更高。",
  "legend.synteny": "同号染色体上基因顺序保守的两个基因，来自 GENESPACE。<em>锚点</em>：用来构建共线块的基因对。打开详情可以看来源运行和共线块。",
  "legend.cross": "不同编号染色体上基因顺序保守的两个基因，来自全染色体运行。它们可能是亚基因组拷贝，也可能是移动过的区段；仅凭这一点无法区分。",
  "legend.orthofinder": "OrthoFinder 把这两个基因列为直系同源。",
  "legend.entry": "以查询注释为参考时，两个基因属于同一个泛基因条目。这不代表它们直接共线。",
  "legend.partial": "两个覆盖度中有一个低于 50%：局部匹配。一致性高时需要检查注释结构；它本身不能证明基因被拆分了。",
  "legend.rank": "在这套注释的全部已存候选中按比特得分排序（自身命中单独列出）。每次搜索最多报告 25 个目标，所以没有命中不代表不存在。",
  "legend.subgenomes": "<ul class=\"legend-points\"><li>亚麻荠是异源六倍体：多数基因有三个拷贝，每个亚基因组一个（SG1、SG2、SG3；命名依 Chaudhary et al. 2020，分组依 Martin et al. 2022）。</li><li>高亮的一列显示每套注释中的对应基因（染色体编号相同）。</li><li>另外两列显示预测的部分同源基因：在这个拷贝预期所在的染色体上，最佳的蛋白匹配。</li><li>每个格子注明证据以及有几个相近候选。每个标记的含义见“证据标记”。</li><li><span class=\"badge partial\">需核查</span> 表示这个选择值得再看一眼，例如另一个基因可能更好，或者一个几乎相同的部分同源基因没有第二项核对。打开详情可以看原因。</li><li><em>按当前规则未找到</em> 可能表示这个拷贝在未定位序列上、没有蛋白模型、低于阈值，或者确实不存在。格子的详情会说明是哪一种。</li><li><span class=\"badge cap\">搜索名单已满</span> 出现在空格子里，表示每个蛋白的搜索最多保留 25 个匹配，这次名单已满，所以这里的拷贝可能被截掉了。</li></ul>",
  "legend.labels": "<p class=\"legend-group\">高亮列：对应基因，在同号染色体上。标记说明这两个基因之间有哪些证据。</p><ul class=\"legend-points\"><li><span class=\"badge state-confirmed\">共线性 + OrthoFinder</span> 基因顺序保守，OrthoFinder 也把这两个基因联系在一起。</li><li><span class=\"badge state-single_evidence\">仅共线性</span> 基因顺序保守，没有记录到 OrthoFinder 联系。</li><li><span class=\"badge state-single_evidence\">仅 OrthoFinder</span> OrthoFinder 把这两个基因联系在一起，本次分析未检测到它们之间有直接的共线关系。</li><li><span class=\"badge state-sequence_only\">仅序列（一致性 ≥ 97%）</span> 没有记录到共线或 OrthoFinder 伙伴，按相近的蛋白匹配选出。</li><li><span class=\"badge state-to_verify\">待核实</span> 只是候选，位置需要核查。</li><li><span class=\"badge state-self\">查询基因</span> 就是你查询的基因。</li></ul><p class=\"legend-group\">另外两列：预测的部分同源基因，在不同的染色体上。预测不要求直接共线，所以标记说明每个基因是怎样核对的。</p><ul class=\"legend-points\"><li><span class=\"badge state-confirmed\">交叉核对一致</span> 查询基因在本注释中的部分同源基因，在另一套注释里对应到同一个候选；或者在查询基因所在的注释内，候选基因合格的最佳反向匹配正是查询基因。</li><li><span class=\"badge state-confirmed\">伙伴基因支持</span> 通常用于核对的基因用不上，所以改用了部分同源基因的另一个共线或 OrthoFinder 伙伴。</li><li><span class=\"badge state-via_own_homeolog\">经部分同源基因找到</span> 直接的蛋白匹配很弱或没有，所以这个基因是通过查询基因在本注释中的部分同源基因找到的。</li><li><span class=\"badge state-sequence_only\">仅序列</span> 达到了蛋白一致性和覆盖度的要求，但没有第二项核对支持它。</li><li><span class=\"badge state-ambiguous\">仅序列，有相近候选</span> 有几个基因匹配得几乎一样好，也没有第二项核对支持这一个。</li></ul>",
  "legend.verify": "其他注释显示这个基因应该在另一条染色体上，或者它位于因此被标记的区段内。它保留原来的位置。它的候选基因没有确认的亚基因组，不能当作已确立的对应基因或部分同源基因。",
  "legend.review": "<ul class=\"legend-points\"><li><em>这个基因</em>：在有它的共线伙伴的其他注释中，多数把伙伴放在另一条染色体上。</li><li><em>周围的基因</em>：它周围有很多基因指向另一条染色体，所以跟着一起被标记。</li><li>两种标记都只是提醒核查，不证明基因真的移动了，也不证明组装有错。</li></ul>",
};

// ---- Interface languages / 界面语言 ----------------------------------------------------------------
// 英文是网页的原文；选中文时，按下面的对照表在显示时替换：文字节点、title / aria-label / placeholder 属性，
// 以及带 data-i18n 键的静态段落。数据本身（基因号、各工具给出的描述、染色体位置）不翻译；对照表里没有的
// 文字保持英文。新显示出来的内容由 MutationObserver 当场替换，所以各页签的代码不用改。
// English is the page's own text. In Chinese, the tables below replace it at display time: text nodes, the
// title / aria-label / placeholder attributes, and the static paragraphs that carry a data-i18n key. Data values
// (gene IDs, the tools' own descriptions, positions) are never translated, and a text missing from the tables
// stays in English. A MutationObserver translates whatever is rendered later, so the views need no changes.
const I18N = (() => {
  const LANGS = ["en", "zh"];
  const fromAddress = new URLSearchParams(location.search).get("lang");
  // 普通链接始终默认英文；中文由地址明确指定，避免旧的浏览器偏好覆盖首页。
  // Ordinary links always default to English; Chinese is explicit in the URL, so old browser preferences cannot override the homepage.
  const lang = LANGS.includes(fromAddress) ? fromAddress : "en";
  // 这些元素里的内容是数据或代码，不翻译（.msa-aa 是比对里的单个残基，数量多，跳过也省时间）
  // Content inside these is data or code and is left alone (.msa-aa are the alignment's single residues: many, and
  // skipping them also saves time)
  const SKIP = "code, pre, kbd, samp, script, style, textarea, .no-i18n, [translate='no'], .msa-aa";
  // data-label 是手机上表格卡片的列名 / data-label holds the column names of the phone table cards
  const ATTRIBUTES = ["title", "aria-label", "placeholder", "data-label"];
  const ATTRIBUTE_SELECTOR = ATTRIBUTES.map((name) => `[${name}]`).join(", ");
  const text = new Map(Object.entries(ZH_TEXT));

  const normalise = (value) => value.replace(/\s+/g, " ").trim();
  const skipped = (element) => Boolean(element?.closest?.(SKIP));

  // 一段英文 -> 中文；没有对照就返回 null。句式的替换函数和 String.replace 一样收到（整段匹配, 各组…, 位置, 全文），
  // 返回 null 表示这一条不适用、接着试下一条。
  // One English text -> Chinese, or null when there is no entry. A pattern's function receives what String.replace
  // passes (match, groups…, offset, whole text) and returns null when it does not apply, so the next pattern is tried.
  function lookup(value) {
    const key = normalise(value);
    if (key.length < 2 || !/[A-Za-z]/.test(key)) return null;
    if (text.has(key)) return text.get(key);
    for (const [pattern, replacement] of ZH_PATTERNS) {
      const match = key.match(pattern);
      if (!match) continue;
      const translated = typeof replacement === "function"
        ? replacement(...match, match.index, key) : key.replace(pattern, replacement);
      if (translated !== null && translated !== undefined) return translated;
    }
    // A text of several sentences is translated one sentence at a time, and only when every sentence is known.
    const sentences = key.replace(/\.\s+(?=[A-Z])/g, ".\n").split("\n");
    if (sentences.length > 1) {
      const parts = sentences.map(lookup);
      if (parts.every((part) => part !== null)) return parts.join("");
    }
    return null;
  }

  function translateTextNode(node) {
    const original = node.nodeValue;
    const translated = lookup(original);
    if (translated === null || translated === normalise(original)) return;
    // 保留原文前后的空格，免得和相邻元素粘在一起 / keep the surrounding spaces so neighbours do not run together
    node.nodeValue = original.match(/^\s*/)[0] + translated + original.match(/\s*$/)[0];
  }

  function translateAttributes(element) {
    for (const name of ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (!value) continue;
      const translated = lookup(value);
      if (translated !== null && translated !== value) element.setAttribute(name, translated);
    }
  }

  function translateTree(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      if (!skipped(root.parentElement)) translateTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE || skipped(root)) return;
    // 有 data-i18n 键的静态段落整段换成中文（段落里有 <em>、<code> 等） / keyed static paragraphs are replaced whole
    for (const element of [root, ...root.querySelectorAll("[data-i18n]")]) {
      const html = element.dataset?.i18n ? ZH_HTML[element.dataset.i18n] : undefined;
      if (html !== undefined && element.dataset.i18nDone !== "zh") {
        element.innerHTML = html;
        element.dataset.i18nDone = "zh";
      }
    }
    translateAttributes(root);
    for (const element of root.querySelectorAll(ATTRIBUTE_SELECTOR)) {
      if (!skipped(element)) translateAttributes(element);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT,
      { acceptNode: (node) => (skipped(node.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) translateTextNode(node);
  }

  // 语言菜单：地球图标按钮点开一个小下拉，列出 English / 中文，当前的打勾。选另一种语言时把选择写进地址（?lang=），
  // 再重新载入当前页面（查询保留在 # 后面）；点外面、按 Esc 或再点按钮就收起。
  // The language menu: the globe button opens a small list of English / 中文 with the current one ticked. Picking the
  // other language writes the choice into the address (?lang=), then reloads the page (the query
  // stays in the # part of the address); a click outside, Esc or the button again closes the list.
  function setupLanguageMenu() {
    const menu = document.getElementById("lang-menu"), button = document.getElementById("lang-toggle");
    const list = document.getElementById("lang-list");
    if (!menu || !button || !list) return;
    const options = [...list.querySelectorAll("[data-lang]")];
    options.forEach((option) => option.setAttribute("aria-checked", String(option.dataset.lang === lang)));
    button.title = lang === "zh" ? "语言 · Language" : "Language · 语言";
    button.setAttribute("aria-label", button.title);
    const close = () => { list.hidden = true; button.setAttribute("aria-expanded", "false"); };
    const open = () => {
      // 手机菜单若开着就先收起 / fold the phone menu first if it is open
      document.getElementById("topnav")?.classList.remove("menu-open");
      document.getElementById("menu-toggle")?.setAttribute("aria-expanded", "false");
      list.hidden = false; button.setAttribute("aria-expanded", "true");
      (options.find((option) => option.dataset.lang === lang) || options[0])?.focus();
    };
    button.addEventListener("click", () => { if (list.hidden) open(); else close(); });
    list.addEventListener("click", (event) => {
      const option = event.target.closest("[data-lang]");
      if (!option) return;
      close();
      if (option.dataset.lang !== lang) switchTo(option.dataset.lang);
    });
    // 上下键在两项之间移动 / the arrow keys move between the entries
    list.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const at = options.indexOf(document.activeElement);
      options[(at + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length].focus();
    });
    document.addEventListener("click", (event) => { if (!menu.contains(event.target)) close(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !list.hidden) { close(); button.focus(); } });
  }

  function switchTo(other) {
    saveSelection();     // 重新载入后同一个基因取回注释范围和转录本 / the same gene takes its selection back after the reload
    const address = new URL(location.href);
    address.searchParams.set("lang", other);
    location.assign(address.href);
  }

  function init() {
    setupLanguageMenu();
    if (lang === "zh") {
      document.documentElement.lang = "zh-CN";
      translateTree(document.head.querySelector("title"));
      translateTree(document.body);
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "childList") record.addedNodes.forEach(translateTree);
          else if (record.type === "characterData") { if (!skipped(record.target.parentElement)) translateTextNode(record.target); }
          else if (!skipped(record.target)) translateAttributes(record.target);
        }
      }).observe(document.documentElement,
        { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
    }
    document.documentElement.classList.remove("i18n-pending");
  }

  return { lang, init, lookup };
})();

async function start() {
  // 先定布局，避免带查询的链接打开时先闪一下首页 / Pick the layout first, so a shared result link does not flash the start page.
  setPageMode(new URLSearchParams(location.hash.slice(1)).has("q"));
  setupThemeToggle();
  setupPageLinks();
  setupMenu();
  try {
    state.manifest = await load("manifest.json");
  } catch (error) {
    message(`Could not load the data description (manifest.json): ${error.message}`, "error");
    return;
  }
  const m = state.manifest;
  if (CONFIG.localPreview) {
    $(".subtitle").after(el("p", { class: "message local-preview" },
      CONFIG.localPreview.label || "Local preview · selected real queries from 18 annotations"));
  }
  col.hit = Object.fromEntries(m.hit_columns.map((name, i) => [name, i]));
  col.relation = Object.fromEntries(m.relation_columns.map((name, i) => [name, i]));
  col.target = Object.fromEntries(m.target_columns.map((name, i) => [name, i]));
  // The homeolog files are optional: without them Homeologs shows the best-hit summary and Alignment is disabled.
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
    // 对应基因页退回最佳匹配表；比对要用同源格子，只好关掉
    // Homeologs falls back to the best-hit summary; Alignment needs the subgenome cells, so it is disabled.
    state.homeologManifest = null;
    $("[data-view=alignment]").disabled = true;
    homeologNote = `Subgenome predictions disabled: ${error.message}`;
  }

  $("#genome-select").append(...displayGenomes().map((g) => el("option", { value: g }, genomeLabel(g))));
  // 首页只露出三种来源的例子，每套注释一个的完整列表收在下面
  // Three examples of different sources stay visible; one per annotation sits behind a disclosure.
  const exampleLink = ([id, g]) => el("a", { href: `#q=${encodeURIComponent(id)}&g=${encodeURIComponent(g)}`, class: "example" },
    el("span", { class: "example-genome" }, genomeLabel(g)), el("code", {}, id));
  // 首页露出的三个例子及其顺序（用户定的）：Prytzh、DH55V2、Suneson 的 JGI 注释
  // The three examples shown on the start page, in the user's order: Prytzh, DH55V2, Suneson's JGI annotation
  const preferred = ["Prytzh", "DH55V2", "SunesonJGI"]
    .map((g) => CONFIG.examples.find(([, genome]) => genome === g)).filter(Boolean);
  const featured = preferred.length === 3 ? preferred : CONFIG.examples.slice(0, 3);
  const order = displayGenomes();
  const byDisplayOrder = [...CONFIG.examples].sort(([, a], [, b]) => order.indexOf(a) - order.indexOf(b));
  $("#examples").replaceChildren(...featured.map(exampleLink));
  $("#examples-all").replaceChildren(...byDisplayOrder.map(exampleLink));
  $(".more-examples").hidden = CONFIG.examples.length <= featured.length;
  renderStats();
  renderFooter(homeologNote);
  renderDownloads();
  if (state.homeologManifest) renderHomeologGroups();
  state.homeologNote = homeologNote;
  $("#methods-link").addEventListener("click", () => openDataMethods(homeologNote));
  $("#about-link").addEventListener("click", openAbout);
  $("#data-link").addEventListener("click", openDataInfo);
  const datasetUrl = CONFIG.browseBase || CONFIG.downloadBase;
  if (datasetUrl) Object.assign($("#dataset-link"), { href: datasetUrl, hidden: false });

  $("#search").addEventListener("submit", (event) => {
    event.preventDefault();
    go($("#gene-input").value, $("#genome-select").value);
  });
  document.querySelectorAll("[data-top]").forEach((b) => b.addEventListener("click", () => {
    state.top = Number(b.dataset.top);
    if (state.record) { renderControls(); renderResults(); }
  }));
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  document.querySelectorAll("[data-evidence]").forEach((b) => b.addEventListener("click", () => setEvidenceList(b.dataset.evidence)));
  // 手机上注释选择默认收起，免得 18 个按钮把结果挤到下面 / On phones the annotation chips start folded, so they do not push the result down
  $("#genome-toggle").addEventListener("click", (event) => {
    const open = $("#genome-controls").classList.toggle("chips-open");
    event.currentTarget.setAttribute("aria-expanded", String(open));
    event.currentTarget.textContent = open ? "Done" : "Change";
  });
  document.querySelectorAll("[data-genomes]").forEach((b) => b.addEventListener("click", () => {
    if (!state.record) return;
    state.shown = new Set(b.dataset.genomes === "all" ? m.target_genomes : []);
    renderControls(); renderResults();
  }));
  $("#download").addEventListener("click", downloadCurrent);
  $("#dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
  window.addEventListener("hashchange", fromHash);
  window.addEventListener("scroll", hideEvidenceTooltip, true);
  window.addEventListener("resize", hideEvidenceTooltip);

  for (const field of document.querySelectorAll("#search input, #search select, #search button")) field.disabled = false;
  $("#gene-input").placeholder = "Gene, transcript or protein ID, e.g. CsPrytzh.01G000100";
  fromHash();
}

I18N.init();
start();
