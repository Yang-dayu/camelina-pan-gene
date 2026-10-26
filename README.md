# Camelina sativa Pan-gene Lookup

Look up a gene, transcript or protein ID across 15 Camelina annotations. Compare protein hits,
direct synteny, OrthoFinder relations, pan-gene memberships and predicted subgenome copies.
Query results can be downloaded as TSV.

Data: [Hugging Face dataset](https://huggingface.co/datasets/Dayu99/camelina-sativa-pan-gene-id).
The site reads public data files from the single dataset revision pinned in config.js.

## Files

- index.html: page structure.
- config.js: dataset addresses, example IDs and download links.
- assets/app.js: queries and result views.
- assets/style.css: presentation.
- .nojekyll: serve the static files directly on GitHub Pages.

## Publish with GitHub Pages

1. Put these files at the root of a GitHub repository and commit them to main.
2. In Settings → Pages, select Deploy from a branch, main and /(root), then save.
3. Open the published URL shown by GitHub and test a query.

No build step is required. The data stay on Hugging Face.
[GitHub Pages instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

## Reading the results

Sequence similarity, direct synteny, OrthoFinder relations and shared pan-gene membership are
separate evidence. Multiple candidates can be retained; a selected candidate is a computational
prediction. No reported hit does not prove biological absence. DH55V2 and DH55V3 are two annotations
of the same accession.

---

## 中文

输入任意一套注释中的基因、转录本或蛋白 ID，查看全部 15 套亚麻荠注释的候选对应、
比对证据和预测亚基因组拷贝，并可下载查询结果 TSV。

完整数据保存在上方的 Hugging Face 仓库；config.js 将查询和下载固定到同一数据版本。
网页无需编译：把页面文件放到 GitHub 仓库根目录，在 Settings → Pages 中选择
Deploy from a branch → main → /(root)，保存后访问 GitHub 提供的网址。

候选对应可能有多个，计算证据不等于已确认的唯一对应；未检出命中不等于生物学缺失。
