// 功能注释面板：按转录本原样显示六个工具的结果，不做取舍（网站功能注释第 3 步）。
// Functional-annotation panel: the six tools' results per transcript, shown as each tool reported them, with no
// selection or summary (step 3 of the functional layer).
//
// 数据 / Data: CONFIG.functionBase →
//   manifest.json          列名、规则、工具版本、每套跑了哪些工具 / columns, rules, tool versions, tools run per set
//   go_terms.json.gz              GO 名称词典，打开 eggNOG 或 InterProScan 时才下载 / GO names, fetched only when needed
//   genes/<genome>/NNNN.json.gz   和网站目录分片同样的 500 个基因 / the same 500 genes as the catalog shards
"use strict";

window.FunctionalAnnotation = (() => {
  // 页签：数据里的名字、按钮上的字 / tabs: the name in the data and the button text
  const TOOLS = [["TAIR10", "TAIR10"], ["SwissProt", "Swiss-Prot"], ["RefSeqPlant", "RefSeq"],
    ["eggNOG", "eggNOG"], ["KofamScan", "KofamScan"], ["InterProScan", "InterProScan"]];
  // COG 功能类别 / COG functional categories
  const COG = {
    A: "RNA processing and modification", B: "Chromatin structure and dynamics", C: "Energy production and conversion",
    D: "Cell cycle control, cell division, chromosome partitioning", E: "Amino acid transport and metabolism",
    F: "Nucleotide transport and metabolism", G: "Carbohydrate transport and metabolism",
    H: "Coenzyme transport and metabolism", I: "Lipid transport and metabolism",
    J: "Translation, ribosomal structure and biogenesis", K: "Transcription", L: "Replication, recombination and repair",
    M: "Cell wall/membrane/envelope biogenesis", N: "Cell motility",
    O: "Post-translational modification, protein turnover, chaperones", P: "Inorganic ion transport and metabolism",
    Q: "Secondary metabolites biosynthesis, transport and catabolism", R: "General function prediction only",
    S: "Function unknown", T: "Signal transduction mechanisms",
    U: "Intracellular trafficking, secretion, and vesicular transport", V: "Defense mechanisms",
    W: "Extracellular structures", Y: "Nuclear structure", Z: "Cytoskeleton",
  };
  // InterProScan 各成员库的条目页 / entry pages of the InterProScan member databases
  const MEMBER_PAGE = {
    Pfam: "pfam", PANTHER: "panther", SMART: "smart", CDD: "cdd", Gene3D: "cathgene3d", SUPERFAMILY: "ssf",
    ProSiteProfiles: "profile", ProSitePatterns: "prosite", PRINTS: "prints", NCBIfam: "ncbifam", PIRSF: "pirsf",
    Hamap: "hamap", SFLD: "sfld",
  };
  // 结构域图里各库的先后 / track order in the domain map
  const TRACK_ORDER = ["Pfam", "SMART", "CDD", "PANTHER", "NCBIfam", "PIRSF", "Hamap", "SFLD", "Gene3D", "FunFam",
    "SUPERFAMILY", "ProSiteProfiles", "ProSitePatterns", "PRINTS", "MobiDBLite", "Coils", "AntiFam"];
  const NEUTRAL_TRACKS = new Set(["MobiDBLite", "Coils"]);

  const files = new Map();                // 已下载的文件 / downloaded files
  let tool = "TAIR10";                    // 选中的页签；每个新基因先显示 TAIR10 / the chosen tab; each new gene opens on TAIR10
  let active = null;                      // 当前基因 / the current gene

  // ---- 小工具 / small helpers -------------------------------------------------------------------------------------

  function el(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value === null || value === undefined || value === false) continue;
      if (name === "class") node.className = value;
      else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
      else node.setAttribute(name, value === true ? "" : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child !== null && child !== undefined && child !== false) {
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
      }
    }
    return node;
  }

  const pad4 = (n) => String(n).padStart(4, "0");
  const plural = (n, word) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
  const num = (value, digits = 1) => value === null || value === undefined || value === ""
    ? "–" : typeof value === "number" ? value.toLocaleString("en-US", { maximumFractionDigits: digits }) : String(value);
  const evalue = (value) => value === null || value === undefined || value === "" ? "–"
    : typeof value === "number" ? (value === 0 ? "0" : value < 0.001 ? value.toExponential(1) : String(value)) : String(value);

  function link(url, label) {
    return el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, label);
  }

  // gz 压缩的 JSON；服务器已经解压时直接读 / gzipped JSON; read as is when the server already decoded it
  function fetchJson(url) {
    if (!files.has(url)) {
      files.set(url, (async () => {
        const response = await fetch(url);
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const text = bytes[0] === 0x1f && bytes[1] === 0x8b
          ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
          : new TextDecoder().decode(bytes);
        return JSON.parse(text);
      })());
      files.get(url).catch(() => files.delete(url));
    }
    return files.get(url);
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- 读数据 / loading -------------------------------------------------------------------------------------------

  // 清单必须和页面的数据来自同一个数据库、同样的基因编号 / the manifest must match the page's database and gene keys
  async function manifestFor(base, pageManifest, genome) {
    const manifest = await fetchJson(`${base}manifest.json`);
    const same = manifest.run === pageManifest.run
      && manifest.source_database_sha256 === pageManifest.source_database_sha256
      && JSON.stringify(manifest.gene_key_ranges?.[genome]) === JSON.stringify(pageManifest.gene_key_ranges?.[genome]);
    if (!same) throw new Error("the functional annotation was built from a different data release");
    return manifest;
  }

  async function geneEntry(base, manifest, genome, key, geneId) {
    const [low] = manifest.gene_key_ranges[genome];
    const shard = await fetchJson(`${base}genes/${genome}/${pad4(Math.floor((key - low) / manifest.genes_per_file))}.json.gz`);
    const gene = shard.genes[key - shard.first_key];
    if (!gene || gene.id !== geneId) throw new Error(`gene ${geneId} is not where the shard layout says`);
    return gene;
  }

  function goTerms() {
    return fetchJson(`${active.base}go_terms.json.gz`).then((d) => d.terms);
  }

  // ---- 对外的两个函数 / the two public functions ---------------------------------------------------------------------

  function clear() {
    if (!active) return;
    active.container.replaceChildren();
    active.container.hidden = true;
    active = null;
  }

  // transcript：切换语言后要恢复的转录本 ID（可选）/ transcript: the transcript ID to restore after a language switch (optional)
  async function load({ container, base, genome, geneId, geneKey, pageManifest, transcript }) {
    clear();
    if (!base || !container) return;
    tool = "TAIR10";
    const session = { container, base, genome, geneId, gene: null, manifest: null, transcript: null, go: null };
    active = session;
    container.hidden = false;
    container.replaceChildren(el("div", { class: "function-panel-inner" },
      el("h3", { class: "function-title" }, "Functional annotation"), el("p", { class: "muted small" }, "Loading…")));
    try {
      session.manifest = await manifestFor(base, pageManifest, genome);
      session.gene = await geneEntry(base, session.manifest, genome, geneKey, geneId);
    } catch (error) {
      if (active !== session) return;
      container.replaceChildren(el("div", { class: "function-panel-inner" },
        el("h3", { class: "function-title" }, "Functional annotation"),
        el("p", { class: "muted small" }, `Not available for this gene: ${error.message}.`)));
      return;
    }
    if (active !== session) return;
    const transcripts = session.gene.tx;
    session.transcript = transcripts.find((t) => t.rep && t.status === "available")
      || transcripts.find((t) => t.status === "available") || transcripts[0];
    if (transcript) session.transcript = transcripts.find((t) => t.id === transcript) || session.transcript;
    render();
  }

  // 当前选中的转录本 ID；没有面板时为 null / the ID of the selected transcript, or null without a panel
  const current = () => active?.transcript?.id || null;

  // ---- 画面板 / drawing the panel -----------------------------------------------------------------------------------

  function render() {
    const s = active;
    const tx = s.transcript;
    const ran = new Set(s.manifest.genomes[s.genome]?.tools_run || []);
    s.container.replaceChildren(el("div", { class: "function-panel-inner" },
      el("div", { class: "function-head" },
        el("h3", { class: "function-title" }, "Functional annotation"),
        el("span", { class: "muted small" }, "Computational predictions from six tools, shown as each tool reported them.")),
      transcriptPicker(),
      el("div", { class: "segmented function-tabs", role: "tablist", "aria-label": "Annotation tool" },
        TOOLS.map(([name, label]) => el("button", {
          type: "button", role: "tab", "aria-pressed": String(name === tool), "aria-selected": String(name === tool),
          onclick: () => { tool = name; render(); },
        }, label, tabCount(tx, name, ran)))),
      el("div", { class: "function-body", role: "tabpanel" }, toolBody(tx, ran)),
      el("div", { class: "function-actions" },
        el("button", { type: "button", class: "selection-button", onclick: downloadTable,
          title: "This tool's rows for the selected transcript, as a tab-separated file" }, "Download this table (TSV)"),
        el("button", { type: "button", class: "selection-button", onclick: downloadGene,
          title: "Every transcript and tool for this gene, with the column names" }, "Download all for this gene (JSON)")),
      about()));
  }

  // 没有蛋白的原因：按注释里的类型（mRNA 只是没有可用的编码序列；tRNA 等才是非编码 RNA）和 QC 状态说明
  // Why there is no protein: from the feature type (an mRNA without a usable coding sequence is not a non-coding RNA;
  // tRNA and the like are) and the QC state.
  const QC_REASON = { internal_stop_excluded: "an internal stop codon" };
  const isMrna = (t) => !t.type || /mrna/i.test(t.type);

  function noProteinText(t) {
    if (t.status === "no_protein") {
      return isMrna(t)
        ? `No protein sequence is available for this ${t.type || "transcript"}: the annotation gives it no usable coding sequence, so the tools were not run on it.`
        : `This transcript is a ${t.type}, a non-coding RNA, so there is no protein to annotate.`;
    }
    return QC_REASON[t.status]
      ? `This transcript's protein was excluded by quality control (${QC_REASON[t.status]}), so no tool was run on it.`
      : `This transcript's protein is not available (${t.status}), so no tool was run on it.`;
  }

  function statusLabel(t) {
    if (t.status === "available") return t.length ? ` · ${num(t.length, 0)} aa` : "";
    if (t.status === "no_protein") return isMrna(t) ? " · no protein sequence" : ` · ${t.type}`;
    return " · excluded by QC";
  }

  function transcriptPicker() {
    const s = active;
    const label = (t) => `${t.id}${t.rep ? " · representative" : ""}${statusLabel(t)}`;
    if (s.gene.tx.length === 1) {
      return el("p", { class: "function-transcript small" }, "Transcript ", el("code", {}, s.transcript.id),
        s.transcript.rep ? " (representative)" : "", s.transcript.length ? ` · protein ${num(s.transcript.length, 0)} aa` : "");
    }
    const select = el("select", { class: "function-select", "aria-label": "Transcript",
      onchange: (e) => { s.transcript = s.gene.tx[Number(e.target.value)]; render(); } },
      s.gene.tx.map((t, i) => el("option", { value: i, selected: t === s.transcript }, label(t))));
    return el("label", { class: "function-transcript small" },
      el("span", { class: "muted" }, `Transcript (${s.gene.tx.length}) `), select);
  }

  function tabCount(tx, name, ran) {
    if (tx.status !== "available" || !ran.has(name)) return null;
    let n;
    if (name === "eggNOG") n = tx.eggNOG ? 1 : 0;
    else if (name === "KofamScan") n = (tx.KofamScan || []).filter((row) => row[0]).length;
    else n = (tx[name] || []).length;
    return el("span", { class: "function-count" }, ` ${n}`);
  }

  function emptyNote(text) {
    return el("p", { class: "function-empty" }, text);
  }

  function toolBody(tx, ran) {
    if (tx.status !== "available") return emptyNote(noProteinText(tx));
    if (!ran.has(tool)) return emptyNote(`${toolLabel(tool)} was not run for this annotation.`);
    if (["TAIR10", "SwissProt", "RefSeqPlant"].includes(tool)) return homology(tx);
    if (tool === "eggNOG") return eggnog(tx);
    if (tool === "KofamScan") return kofam(tx);
    return interpro(tx);
  }

  const toolLabel = (name) => TOOLS.find(([n]) => n === name)[1];

  // ---- TAIR10、Swiss-Prot、RefSeq ----------------------------------------------------------------------------------

  function homology(tx) {
    const rows = tx[tool] || [];
    const m = active.manifest;
    const criteria = "DIAMOND blastp (sensitive mode): E-value ≤ 1e-5, identity ≥ 30%, and at least 50% of both proteins aligned.";
    if (!rows.length) return [emptyNote(`No ${toolLabel(tool)} hit. ${criteria}`)];
    const cols = Object.fromEntries(m.columns[tool].map((c, i) => [c, i]));
    const metricHeads = ["Identity (%)", "Aligned (aa)", "Query cov. (%)", "Subject cov. (%)", "E-value", "Bit score"];
    const metricCells = (row) => [num(row[cols.identity]), num(row[cols.length], 0), num(row[cols.query_cov]),
      num(row[cols.subject_cov]), evalue(row[cols.evalue]), num(row[cols.bitscore], 0)].map((v, i) =>
      el("td", { class: i === 4 ? "num nowrap" : "num" }, v));
    let heads, cells;
    if (tool === "TAIR10") {
      heads = ["#", "Arabidopsis gene", "Symbol", "Description"];
      cells = (row, i) => [el("td", { class: "num" }, i + 1),
        el("td", {}, link(`https://plants.ensembl.org/Arabidopsis_thaliana/Gene/Summary?g=${row[cols.gene]}`, row[cols.gene]),
          el("div", { class: "muted small" }, row[cols.hit])),
        el("td", {}, row[cols.symbol] && row[cols.symbol] !== row[cols.gene] ? row[cols.symbol] : "–"),
        el("td", { class: "wrap-cell" }, row[cols.description] || "–")];
    } else if (tool === "SwissProt") {
      heads = ["#", "Swiss-Prot entry", "Protein", "Organism", "Gene"];
      cells = (row, i) => [el("td", { class: "num" }, i + 1),
        el("td", {}, link(`https://www.uniprot.org/uniprotkb/${row[cols.accession]}/entry`, row[cols.accession]),
          el("div", { class: "muted small" }, row[cols.entry])),
        el("td", { class: "wrap-cell" }, row[cols.name] || "–"), el("td", { class: "wrap-cell" }, el("i", {}, row[cols.organism] || "–")),
        el("td", {}, row[cols.gene_name] || "–")];
    } else {
      heads = ["#", "RefSeq protein", "Description"];
      cells = (row, i) => [el("td", { class: "num" }, i + 1),
        el("td", {}, link(`https://www.ncbi.nlm.nih.gov/protein/${row[cols.accession]}`, row[cols.accession])),
        el("td", { class: "wrap-cell" }, row[cols.description] || "–")];
    }
    const note = tool === "TAIR10"
      ? `${criteria} Top 5 Arabidopsis genes, best isoform of each (TAIR10 proteins from Ensembl Plants).`
      : `${criteria} Top 5 hits.`;
    return [
      el("div", { class: "table-wrap function-table" }, el("table", {},
        el("thead", {}, el("tr", {}, [...heads, ...metricHeads].map((h) => el("th", {}, h)))),
        el("tbody", {}, rows.map((row, i) => el("tr", {}, cells(row, i), metricCells(row)))))),
      el("p", { class: "function-note muted small" }, note),
    ];
  }

  // ---- eggNOG ------------------------------------------------------------------------------------------------------

  function goList(text, tagged) {
    // tagged：InterProScan 的 "GO:x(InterPro)|GO:y(PANTHER)"；否则逗号分隔 / tagged: InterProScan form; else comma-separated
    const items = tagged
      ? text.split("|").map((item) => { const m = item.match(/(GO:\d{7})\((\w+)\)/); return m ? [m[1], m[2]] : null; }).filter(Boolean)
      : text.split(",").filter((x) => x.startsWith("GO:")).map((id) => [id, null]);
    const terms = active.go;
    if (!terms) {
      goTerms().then((loaded) => { if (active) { active.go = loaded; render(); } }).catch(() => {});
    }
    return el("ul", { class: "function-go" }, items.map(([id, source]) => {
      const [name, ontology, status] = terms?.[id] || [];
      return el("li", {}, link(`https://www.ebi.ac.uk/QuickGO/term/${id}`, id),
        name ? ` ${name}` : terms ? " (name not found)" : "",
        ontology ? el("span", { class: "function-tag" }, ontology) : null,
        status === "obsolete" ? el("span", { class: "function-tag warn" }, "obsolete") : null,
        status?.startsWith("alt_id:") ? el("span", { class: "function-tag" }, `now ${status.slice(7)}`) : null,
        source ? el("span", { class: "muted small" }, ` from ${source}`) : null);
    }));
  }

  function eggnog(tx) {
    const row = tx.eggNOG;
    if (!row) return emptyNote("eggNOG-mapper reported no annotation for this protein.");
    const c = Object.fromEntries(active.manifest.columns.eggNOG.map((name, i) => [name, i]));
    const value = (name) => row[c[name]] || "";
    const list = (name, f) => value(name) ? value(name).split(",").map((x, i) => [i ? ", " : "", f(x.trim())]) : null;
    const field = (label, content) => content && (!Array.isArray(content) || content.length)
      ? [el("dt", {}, label), el("dd", {}, content)] : [];
    const gos = value("GOs");
    return [
      el("dl", { class: "function-facts" },
        field("Preferred name", value("Preferred_name")),
        field("Description", value("Description")),
        field("COG category", value("COG_category") ? [...value("COG_category")].map((letter, i) =>
          [i ? "; " : "", `${letter}: ${COG[letter] || "unknown category"}`]) : ""),
        field("Seed ortholog", value("seed_ortholog") ? `${value("seed_ortholog")} (E-value ${evalue(row[c.evalue])}, score ${num(row[c.score])})` : ""),
        field("Orthologous groups", value("eggNOG_OGs") ? el("span", { class: "small" }, value("eggNOG_OGs").split(",").join(", ")) : ""),
        field("Annotation level", value("max_annot_lvl")),
        field("KEGG KO", list("KEGG_ko", (x) => link(`https://www.kegg.jp/entry/${x.replace(/^ko:/, "")}`, x.replace(/^ko:/, "")))),
        field("KEGG pathway", list("KEGG_Pathway", (x) => link(`https://www.kegg.jp/pathway/${x}`, x))),
        field("KEGG module", list("KEGG_Module", (x) => link(`https://www.kegg.jp/entry/${x}`, x))),
        field("KEGG reaction", list("KEGG_Reaction", (x) => link(`https://www.kegg.jp/entry/${x}`, x))),
        field("KEGG reaction class", list("KEGG_rclass", (x) => link(`https://www.kegg.jp/entry/${x}`, x))),
        field("KEGG BRITE", value("BRITE")),
        field("KEGG TC", value("KEGG_TC")),
        field("EC", list("EC", (x) => link(`https://enzyme.expasy.org/EC/${x}`, x))),
        field("CAZy", value("CAZy")),
        field("BiGG reaction", value("BiGG_Reaction")),
        field("Pfam (eggNOG)", value("PFAMs") ? value("PFAMs").split(",").join(", ") : ""),
        field(`GO terms (${gos ? gos.split(",").length : 0})`, gos ? el("details", { class: "function-go-details" },
          el("summary", {}, "Show GO terms"), goList(gos, false)) : "")),
      el("p", { class: "function-note muted small" },
        "eggNOG-mapper transfers annotation from orthologs found in eggNOG (Viridiplantae). GO terms are inferred from those orthologs, not from experiments on this gene."),
    ];
  }

  // ---- KofamScan ---------------------------------------------------------------------------------------------------

  function kofam(tx) {
    const rows = tx.KofamScan || [];
    const total = tx.KofamScan_total || 0;
    if (!total) return emptyNote("KofamScan reported no row for this protein.");
    const c = Object.fromEntries(active.manifest.columns.KofamScan.map((name, i) => [name, i]));
    const significant = rows.filter((row) => row[c.significant]).length;
    return [
      el("div", { class: "table-wrap function-table" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Above threshold", "KO", "Definition", "Threshold", "Score", "E-value"].map((h) => el("th", {}, h)))),
        el("tbody", {}, rows.map((row) => el("tr", { class: row[c.significant] ? "function-significant" : null },
          el("td", {}, row[c.significant] ? "Yes" : "No"),
          el("td", {}, link(`https://www.kegg.jp/entry/${row[c.KO]}`, row[c.KO])),
          el("td", { class: "wrap-cell" }, row[c.definition]),
          el("td", { class: "num" }, num(row[c.threshold], 2)), el("td", { class: "num" }, num(row[c.score], 1)),
          el("td", { class: "num nowrap" }, evalue(row[c.evalue]))))))),
      el("p", { class: "function-note muted small" },
        `${plural(significant, "row")} above the KO's own score threshold (the KO assignments). Showing ${rows.length} of the ${plural(total, "row")} KofamScan reported for this protein: every row above its threshold, then the next rows in KofamScan's order.`),
    ];
  }

  // ---- InterProScan ------------------------------------------------------------------------------------------------

  function memberLink(analysis, accession) {
    const page = MEMBER_PAGE[analysis];
    return page ? link(`https://www.ebi.ac.uk/interpro/entry/${page}/${accession}/`, accession) : accession;
  }

  function domainMap(rows, c, length) {
    if (!length) return null;
    const byTrack = new Map();
    for (const row of rows) {
      const track = row[c.analysis];
      if (!byTrack.has(track)) byTrack.set(track, []);
      byTrack.get(track).push(row);
    }
    const order = (name) => { const i = TRACK_ORDER.indexOf(name); return i < 0 ? TRACK_ORDER.length : i; };
    const tracks = [...byTrack.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    return el("div", { class: "domain-map", role: "img",
      "aria-label": `Positions of ${rows.length} InterProScan ${rows.length === 1 ? "match" : "matches"} along the ${length}-aa protein; the table below lists them` },
      tracks.map((track) => el("div", { class: "domain-track" },
        el("span", { class: "domain-label small" }, track),
        el("span", { class: "domain-lane" }, byTrack.get(track).map((row) => {
          const start = Math.max(1, row[c.start]), end = Math.min(length, row[c.end]);
          const label = `${track} ${row[c.signature]}${row[c.signature_description] ? ` ${row[c.signature_description]}` : ""} · ${start}–${end}`;
          return el("span", { class: `domain-bar${NEUTRAL_TRACKS.has(track) ? " neutral" : ""}`, title: label,
            style: `left:${((start - 1) / length) * 100}%;width:${Math.max(0.6, ((end - start + 1) / length) * 100)}%` });
        })))),
      el("div", { class: "domain-axis small muted" }, el("span", {}, "1"), el("span", {}, `${num(length, 0)} aa`)));
  }

  function interpro(tx) {
    const rows = tx.InterProScan || [];
    if (!rows.length) return emptyNote("InterProScan found no match in any of its member databases.");
    const c = Object.fromEntries(active.manifest.columns.InterProScan.map((name, i) => [name, i]));
    return [
      domainMap(rows, c, tx.length),
      el("div", { class: "table-wrap function-table" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Database", "Signature", "Description", "Start", "End", "Score or E-value", "InterPro entry", "GO"].map((h) => el("th", {}, h)))),
        el("tbody", {}, rows.map((row) => el("tr", {},
          el("td", {}, row[c.analysis]),
          el("td", {}, memberLink(row[c.analysis], row[c.signature])),
          el("td", { class: "wrap-cell" }, row[c.signature_description] || "–"),
          el("td", { class: "num" }, num(row[c.start], 0)), el("td", { class: "num" }, num(row[c.end], 0)),
          el("td", { class: "num nowrap" }, evalue(row[c.score])),
          el("td", { class: "wrap-cell" }, row[c.interpro]
            ? [link(`https://www.ebi.ac.uk/interpro/entry/InterPro/${row[c.interpro]}/`, row[c.interpro]),
              row[c.interpro_description] ? el("div", { class: "small" }, row[c.interpro_description]) : null] : "–"),
          el("td", { class: "wrap-cell" }, row[c.go] ? goList(row[c.go], true) : "–")))))),
      el("p", { class: "function-note muted small" },
        "Every InterProScan match, sorted by position. GO terms come from the InterPro entry (InterPro2GO) or the PANTHER family. MobiDBLite marks disordered regions and Coils coiled coils."),
    ];
  }

  // ---- 说明和下载 / about and downloads -------------------------------------------------------------------------------

  function about() {
    const m = active.manifest;
    const t = m.tools || {};
    const version = (path, pattern) => (String(path || "").match(pattern) || [])[1] || "unknown";
    const dbDate = (name) => t.DIAMOND?.databases?.[name]?.mtime_utc?.slice(0, 10) || "unknown";
    return el("details", { class: "function-about small" },
      el("summary", {}, "About these results"),
      el("ul", {},
        el("li", {}, `TAIR10, Swiss-Prot and RefSeq: ${t.DIAMOND?.version || "DIAMOND"} blastp, ${t.DIAMOND?.options || ""}. `
          + `Database files built ${dbDate("TAIR10")} (TAIR10), ${dbDate("SwissProt")} (Swiss-Prot) and ${dbDate("RefSeqPlant")} (RefSeq plant proteins).`),
        el("li", {}, `eggNOG: ${(t["eggNOG-mapper"]?.versions || []).join(", ")}, eggNOG database ${t["eggNOG-mapper"]?.database || ""}, taxonomic scope ${t["eggNOG-mapper"]?.tax_scope || ""}.`),
        el("li", {}, `KofamScan ${version(t.KofamScan?.executable, /kofam_scan-([\d.]+)/)}, KO list of ${t.KofamScan?.ko_list?.mtime_utc?.slice(0, 10) || "unknown"}.`),
        el("li", {}, `InterProScan ${version(t.InterProScan?.executable, /interproscan-([\d.-]+)/)}; GO names from ${m.go_dictionary?.go_version || "the GO ontology"}.`),
        el("li", {}, `Built ${String(m.created_utc || "").slice(0, 10)}. These are computational predictions, not experimentally verified functions.`)));
  }

  function downloadTable() {
    const s = active;
    const tx = s.transcript;
    const columns = s.manifest.columns[tool];
    let rows = tool === "eggNOG" ? (tx.eggNOG ? [tx.eggNOG] : []) : (tx[tool] || []);
    const lines = [["gene", "transcript", "protein", ...columns].join("\t"),
      ...rows.map((row) => [s.gene.id, tx.id, tx.protein || "", ...row.map((v) => v === null ? "" : String(v).replace(/[\t\n]/g, " "))].join("\t"))];
    download(`${s.gene.id}_${tx.id}_${tool}.tsv`, lines.join("\n") + "\n", "text/tab-separated-values");
  }

  function downloadGene() {
    const s = active;
    const content = { genome: s.genome, gene: s.gene, columns: s.manifest.columns, rules: s.manifest.rules,
      tools: s.manifest.tools, built: s.manifest.created_utc };
    download(`${s.gene.id}_functional_annotation.json`, JSON.stringify(content, null, 1), "application/json");
  }

  return { load, clear, current };
})();
