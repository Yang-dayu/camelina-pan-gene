// Rank stored sequence matches for a user's alignment selection. This does not
// change Homeologs predictions or infer orthology from the ranking.
"use strict";

window.AlignmentCandidates = (() => {
  const metadataFields = ["chromosome", "start", "end", "length"];
  const metricFields = ["identity", "query_coverage", "target_coverage", "bitscore", "evalue"];
  const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const percentage = (value) => number(value) !== null && value >= 0 && value <= 100 ? value : null;
  // The source uses positive numeric synteny states (including 2 for an anchor),
  // while OrthoFinder normally uses 0/1. Preserve evidence from either encoding.
  const flag = (value) => value === true || typeof value === "number" && Number.isFinite(value) && value > 0;
  const nonempty = (value) => typeof value === "string" && value.length > 0 ? value : null;

  function columns(value, name) {
    if (Array.isArray(value)) return Object.fromEntries(value.map((field, index) => [field, index]));
    if (value && typeof value === "object") return value;
    throw new TypeError(`${name} must be a manifest column list or an index map.`);
  }

  function threshold(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new RangeError("The dual-coverage threshold must be a number between 0 and 100.");
    }
    return value;
  }

  function record(row, map) {
    const read = (field) => row[map[field]];
    const gene_id = nonempty(read("target_id"));
    if (!gene_id) return null;
    const evalue = read("evalue");
    return {
      gene_id, chromosome: nonempty(read("chromosome")),
      start: number(read("start")), end: number(read("end")), length: number(read("protein_length")),
      identity: percentage(read("identity_pct")), query_coverage: percentage(read("query_coverage_pct")),
      target_coverage: percentage(read("target_coverage_pct")), bitscore: number(read("bitscore")),
      // Preserve scientific notation and zero as reported. E-values are not
      // converted to floating point or used to break strong-match ties.
      evalue: typeof evalue === "string" && evalue.length > 0 ? evalue
        : typeof evalue === "number" && Number.isFinite(evalue) && evalue >= 0 ? String(evalue) : null,
      synteny: flag(read("synteny")), cross_synteny: flag(read("cross_synteny")),
      orthofinder: flag(read("orthofinder")),
    };
  }

  // A position-conflict record has no SG slots. Keep its explicit review
  // candidates selectable without assigning them an ortholog or homeolog role.
  function reviewRecord(row, map) {
    const read = (field) => row[map[field]];
    const gene_id = nonempty(read("gene_id"));
    if (!gene_id) return null;
    const evidence = String(read("evidence") || "").split("+");
    const flags = Array.isArray(read("flags")) ? read("flags") : [];
    return {
      gene_id, chromosome: nonempty(read("chromosome")), start: number(read("start")),
      end: number(read("end")), length: null,
      identity: percentage(read("identity_pct")), query_coverage: percentage(read("query_coverage_pct")),
      target_coverage: percentage(read("target_coverage_pct")), bitscore: number(read("bitscore")), evalue: null,
      synteny: evidence.includes("synteny"), cross_synteny: evidence.includes("cross_synteny"),
      orthofinder: evidence.includes("orthofinder"),
      role: nonempty(read("role")), state: nonempty(read("state")), flags: [...flags],
      reason: nonempty(read("reason")), review_required: read("state") === "to_verify" || flags.includes("position_conflict"),
      review_cell: row,
    };
  }

  function mergeMissing(first, next) {
    if (!first) return next;
    const merged = { ...first };
    for (const field of [...metadataFields, ...metricFields]) {
      if (merged[field] === null) merged[field] = next[field];
    }
    merged.synteny ||= next.synteny;
    merged.cross_synteny ||= next.cross_synteny;
    merged.orthofinder ||= next.orthofinder;
    merged.review_required ||= next.review_required;
    if (next.review_required) {
      for (const field of ["role", "state", "reason", "review_cell"]) merged[field] = next[field];
    }
    if (first.flags || next.flags) merged.flags = [...new Set([...(first.flags || []), ...(next.flags || [])])];
    return merged;
  }

  function collectCandidates({ target, targetColumns, hitColumns, relationColumns, homeologId = null,
                               homeologCandidates = [], cellColumns = null }) {
    const targetMap = columns(targetColumns, "targetColumns");
    const hitMap = columns(hitColumns, "hitColumns");
    const relationMap = columns(relationColumns, "relationColumns");
    const byId = new Map();
    for (const [kind, map] of [["hits", hitMap], ["relations", relationMap]]) {
      const stored = target?.[targetMap[kind]];
      let rows = Array.isArray(stored) ? stored : [];
      // Query-annotation exports store the self hit separately from other hits.
      // It remains an explicit selectable sequence, including in another SG view.
      const self = kind === "hits" ? target?.[targetMap.self_hit] : null;
      if (Array.isArray(self)) rows = [self, ...rows];
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const item = record(row, map);
        if (!item) continue;
        if (!byId.has(item.gene_id)) byId.set(item.gene_id, { hit: null, relation: null });
        const combined = byId.get(item.gene_id);
        const family = kind === "hits" ? "hit" : "relation";
        combined[family] = mergeMissing(combined[family], item);
      }
    }
    if (homeologCandidates.length) {
      const cellMap = columns(cellColumns, "cellColumns");
      for (const row of homeologCandidates) {
        if (!Array.isArray(row)) continue;
        const item = reviewRecord(row, cellMap);
        if (!item) continue;
        if (!byId.has(item.gene_id)) byId.set(item.gene_id, { hit: null, relation: null });
        const combined = byId.get(item.gene_id);
        combined.review = mergeMissing(combined.review, item);
      }
    }
    return [...byId.values()].map(({ hit, relation, review }) => {
      let merged = mergeMissing(hit, relation || hit);
      if (review) merged = mergeMissing(merged, review);
      return { ...merged, homeolog_selected: merged.gene_id === homeologId };
    });
  }

  function isComplete(candidate, coverageThreshold = 80) {
    threshold(coverageThreshold);
    return percentage(candidate?.query_coverage) !== null && percentage(candidate?.target_coverage) !== null &&
      candidate.query_coverage >= coverageThreshold && candidate.target_coverage >= coverageThreshold;
  }

  const descending = (left, right) => {
    const a = number(left), b = number(right);
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    return b - a;
  };
  const minimumCoverage = (candidate) => percentage(candidate.query_coverage) !== null && percentage(candidate.target_coverage) !== null
    ? Math.min(candidate.query_coverage, candidate.target_coverage) : null;

  function sortCandidates(candidates, { coverageThreshold = 80, sort = "bitscore" } = {}) {
    threshold(coverageThreshold);
    if (sort !== "bitscore" && sort !== "identity") throw new RangeError("Unknown candidate sort order.");
    if (!Array.isArray(candidates)) throw new TypeError("Candidates must be an array.");
    return [...candidates].sort((a, b) => {
      const completeness = Number(isComplete(b, coverageThreshold)) - Number(isComplete(a, coverageThreshold));
      if (completeness) return completeness;
      const primary = sort === "identity" ? "identity" : "bitscore";
      const secondary = sort === "identity" ? "bitscore" : "identity";
      return descending(a[primary], b[primary]) || descending(a[secondary], b[secondary]) ||
        descending(minimumCoverage(a), minimumCoverage(b)) ||
        (a.gene_id < b.gene_id ? -1 : a.gene_id > b.gene_id ? 1 : 0);
    });
  }

  const recommend = (candidates, options) => sortCandidates(candidates, options)[0] || null;
  return Object.freeze({ collectCandidates, isComplete, sort: sortCandidates, recommend });
})();
