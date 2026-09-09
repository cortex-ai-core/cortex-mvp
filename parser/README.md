# Cortéx parser service

Docling on CPU, wrapped in one HTTP endpoint. The backend's ingest worker sends a
file and gets back chunks that carry page numbers, bounding boxes, and heading
paths, which is what citations are built from.

## Run locally

```bash
docker build -t cortex-parser ./parser
docker run --rm -p 8090:8090 -e PARSER_SECRET=dev -m 4g cortex-parser
curl -s http://localhost:8090/health
curl -s -X POST http://localhost:8090/parse -H "X-Parser-Secret: dev" -F "file=@some.pdf" | jq '.page_count, (.chunks | length), .chunks[0]'
```

## Endpoint

`POST /parse` — multipart with `file` and an optional `options` JSON string.
Header `X-Parser-Secret` must match `PARSER_SECRET` when that env var is set.

Response (abridged):

```json
{
  "parser": "docling",
  "parser_version": "docling-cpu-2",
  "page_count": 12,
  "markdown": "...",
  "chunks": [
    {
      "index": 17,
      "text": "| Vendor | Amount | Signed |...",
      "embed_text": "3. Budget > 3.2 Vendors\n| Vendor | Amount | Signed |...",
      "item_kind": "table",
      "headings": ["3. Budget", "3.2 Vendors"],
      "section_label": "3. Budget › 3.2 Vendors",
      "page_start": 4,
      "page_end": 4,
      "bboxes": [{ "page": 4, "l": 0.08, "t": 0.31, "r": 0.92, "b": 0.55 }],
      "token_count": 371,
      "content_hash": "…"
    }
  ],
  "warnings": [],
  "stats": {
    "headings_docling": 40,
    "headings_recovered": { "page_header": 0, "text": 1 },
    "headings_total": 41,
    "chunks_with_section_label": 58
  },
  "timings": { "convert_s": 21.4, "chunk_s": 0.3 }
}
```

Boxes are normalized to the page (0..1) with a top-left origin, so they are
independent of the viewer that draws them. Word, PowerPoint, and Excel files have
no fixed pages; their chunks carry `headings` and `section_label` but null pages.

`index` is dense (0..n-1 over the returned chunks; empty chunks are dropped
before numbering). Heading text is carried in `headings` / `section_label` and
prepended in `embed_text`; `text` is the body only, so it never repeats a
heading across consecutive chunks of the same section.

### Heading recovery

Docling's layout model occasionally labels a real heading as `page_header` or
plain `text`; the chunker then folds it into the previous section and the
following chunks lose their `section_label`. Before chunking the service
promotes, conservatively:

- `page_header` items whose text does not recur on 3+ pages (running heads
  repeat, real headings do not; digits are folded so "Page 3" matches "Page 4");
- short `text` lines (under 12 words, no trailing period) that are numbered
  (`2.`, `3.1`, `IV)`) or set entirely in capitals.

Promoted items become real `SectionHeaderItem`s at the same position, so
provenance is unchanged. The count is reported in `stats.headings_recovered`
and, when non-zero, as a `warnings` entry, e.g.
`heading recovery: promoted 1 item(s) to section headers (0 page header(s), 1 text line(s))`.
`stats` also carries `headings_docling`, `headings_total`, and
`chunks_with_section_label`.

`parser_version` is `docling-cpu-2` for this behaviour (`docling-cpu-1` had
sparse indexes and no recovery pass).

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PARSER_SECRET` | empty (no auth) | Shared secret the backend sends in `X-Parser-Secret` |
| `OCR_ENGINE` | `rapidocr` | `rapidocr` (default; best accuracy on symbols and table cells in testing), `easyocr`, or `tesseract` (fastest, lowest memory, weaker on table cells) |
| `CHUNK_MAX_TOKENS` | `512` | Upper bound per chunk, measured with the embedding model's tokenizer |
| `EMBED_MODEL` | `text-embedding-3-small` | Tokenizer to size chunks for |
| `MAX_PAGES` | `300` | Reject longer documents |
| `OMP_NUM_THREADS` | `4` | CPU threads for the models |

## Sizing

Layout and table models need roughly 2 to 3 GB resident. Run with 4 GB. On a
modern CPU a native-text page takes about one to three seconds; a fully scanned
page five to fifteen.
