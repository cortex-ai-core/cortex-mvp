"""
Cortéx parser service.

One endpoint: POST /parse (multipart: file, optional options JSON).
Reads the document with Docling, chunks it with Docling's HybridChunker,
and returns chunks with page/box/heading provenance for citations.

Runs on CPU. No network access needed at runtime once models are baked in.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

import tiktoken
from fastapi import FastAPI, File, Form, Header, HTTPException, Response, UploadFile
from fastapi.concurrency import run_in_threadpool

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import (
    EasyOcrOptions,
    PdfPipelineOptions,
    RapidOcrOptions,
    TableFormerMode,
    TesseractCliOcrOptions,
)
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
from docling_core.transforms.chunker.tokenizer.openai import OpenAITokenizer
from docling_core.types.doc import ContentLayer, CoordOrigin, DocItemLabel
from docling_core.types.doc.document import SectionHeaderItem, TextItem, TitleItem

log = logging.getLogger("parser")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# Bump when the chunk output changes shape or content (heading recovery, index density).
PARSER_VERSION = os.environ.get("PARSER_VERSION", "docling-cpu-2")
PARSER_SECRET = os.environ.get("PARSER_SECRET", "")
OCR_ENGINE = os.environ.get("OCR_ENGINE", "rapidocr")  # easyocr | tesseract | rapidocr
MAX_TOKENS = int(os.environ.get("CHUNK_MAX_TOKENS", "512"))
EMBED_MODEL = os.environ.get("EMBED_MODEL", "text-embedding-3-small")
MAX_PAGES = int(os.environ.get("MAX_PAGES", "300"))

ALLOWED_SUFFIXES = {
    ".pdf", ".docx", ".pptx", ".xlsx", ".md", ".txt", ".html", ".htm",
    ".png", ".jpg", ".jpeg", ".tif", ".tiff",
}

app = FastAPI(title="Cortéx parser", version=PARSER_VERSION)


# -------------------------------------------------------------------
# Converter + chunker are built once. Docling models load lazily on the
# first convert, so /health warms them.
# -------------------------------------------------------------------
def build_converter() -> DocumentConverter:
    pdf_opts = PdfPipelineOptions()
    pdf_opts.do_ocr = True
    pdf_opts.do_table_structure = True
    pdf_opts.table_structure_options.mode = TableFormerMode.ACCURATE
    pdf_opts.table_structure_options.do_cell_matching = True
    if OCR_ENGINE == "rapidocr":
        pdf_opts.ocr_options = RapidOcrOptions(lang=["english"])
    elif OCR_ENGINE == "tesseract":
        pdf_opts.ocr_options = TesseractCliOcrOptions(lang=["eng"])
    else:
        pdf_opts.ocr_options = EasyOcrOptions(lang=["en"])
    # Only OCR bitmap regions; native text is read from the text layer.
    pdf_opts.ocr_options.force_full_page_ocr = False

    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_opts),
            InputFormat.IMAGE: PdfFormatOption(pipeline_options=pdf_opts),
        }
    )


def build_chunker() -> HybridChunker:
    tokenizer = OpenAITokenizer(
        tokenizer=tiktoken.encoding_for_model(EMBED_MODEL),
        max_tokens=MAX_TOKENS,
    )
    return HybridChunker(tokenizer=tokenizer, merge_peers=True)


CONVERTER = build_converter()
CHUNKER = build_chunker()
ENCODING = tiktoken.encoding_for_model(EMBED_MODEL)


# -------------------------------------------------------------------
# Provenance helpers
# -------------------------------------------------------------------
KIND_MAP = {
    DocItemLabel.TABLE: "table",
    DocItemLabel.LIST_ITEM: "list",
    DocItemLabel.CAPTION: "caption",
    DocItemLabel.TITLE: "title",
    DocItemLabel.SECTION_HEADER: "heading",
    DocItemLabel.CODE: "code",
    DocItemLabel.FORMULA: "formula",
    DocItemLabel.PICTURE: "figure",
}


def item_kind(labels: list[Any]) -> str:
    """Pick the most specific kind present in a chunk's items."""
    kinds = [KIND_MAP.get(lbl, "paragraph") for lbl in labels]
    for k in ("table", "code", "figure", "list", "caption", "title", "heading"):
        if k in kinds:
            return k
    return "paragraph"


def normalized_boxes(doc, chunk) -> tuple[list[dict], int | None, int | None]:
    """
    Flatten every provenance entry of every item in the chunk into
    {page, l, t, r, b} in 0..1 with a top-left origin. Returns the box
    list plus the min/max page numbers.
    """
    boxes: list[dict] = []
    pages: list[int] = []

    for item in chunk.meta.doc_items or []:
        for prov in getattr(item, "prov", None) or []:
            page_no = int(prov.page_no)
            page = doc.pages.get(page_no)
            if page is None or page.size is None:
                continue
            w, h = float(page.size.width), float(page.size.height)
            if w <= 0 or h <= 0:
                continue

            bb = prov.bbox
            if bb.coord_origin == CoordOrigin.BOTTOMLEFT:
                bb = bb.to_top_left_origin(page_height=h)

            boxes.append(
                {
                    "page": page_no,
                    "l": round(max(0.0, min(1.0, bb.l / w)), 4),
                    "t": round(max(0.0, min(1.0, bb.t / h)), 4),
                    "r": round(max(0.0, min(1.0, bb.r / w)), 4),
                    "b": round(max(0.0, min(1.0, bb.b / h)), 4),
                }
            )
            pages.append(page_no)

    if not pages:
        return boxes, None, None
    return boxes, min(pages), max(pages)


def section_label(headings: list[str] | None) -> str | None:
    if not headings:
        return None
    cleaned = [h.strip() for h in headings if h and h.strip()]
    return " › ".join(cleaned) if cleaned else None


# -------------------------------------------------------------------
# Heading recovery
#
# Docling's layout model sometimes labels a real heading as PAGE_HEADER
# or plain TEXT. The HybridChunker only treats TitleItem/SectionHeaderItem
# instances as headings (an isinstance check, not a label check), so a
# mislabelled heading is folded into the body of the previous section and
# the following chunks lose their section_label. This pass runs before
# chunking and, conservatively, promotes:
#   (a) PAGE_HEADER items whose text does not recur on 3+ pages
#       (running heads repeat page after page; real headings do not), and
#   (b) short TEXT lines that look like headings: fewer than 12 words, no
#       trailing period, and either numbered ("2.", "3.1", "IV)") or set
#       entirely in capitals.
# A promoted item is replaced in doc.texts by a SectionHeaderItem with the
# same self_ref/prov/text, so provenance and reading order are untouched.
# -------------------------------------------------------------------
HEADING_MAX_WORDS = 12
RUNNING_HEAD_MIN_PAGES = 3  # seen on this many distinct pages => running head, keep as is
HEADING_NUMBER_RE = re.compile(r"^(\d+(\.\d+)*|[IVX]+)[.)]?\s+\S")


def _norm_head(text: str) -> str:
    """Collapse whitespace, fold digits, lowercase: 'Page 3 of 9' == 'Page 4 of 9'."""
    return re.sub(r"\d+", "#", re.sub(r"\s+", " ", text)).strip().lower()


def _looks_like_heading(text: str) -> bool:
    t = text.strip()
    if not t or t.endswith("."):
        return False
    words = t.split()
    if len(words) >= HEADING_MAX_WORDS:
        return False
    if HEADING_NUMBER_RE.match(t):
        return True
    alpha_words = [w for w in words if any(ch.isalpha() for ch in w)]
    return len(alpha_words) >= 2 and t == t.upper()


def _promote(doc, item: TextItem, level: int) -> SectionHeaderItem:
    """Swap `item` for an equivalent SectionHeaderItem at the same texts[] slot."""
    fields = {k: getattr(item, k) for k in TextItem.model_fields if k != "label"}
    fields["content_layer"] = ContentLayer.BODY  # page headers live in FURNITURE, which the chunker skips
    fields["level"] = level
    new = SectionHeaderItem(**fields)
    idx = int(item.self_ref.rsplit("/", 1)[1])
    assert doc.texts[idx].self_ref == item.self_ref
    doc.texts[idx] = new
    return new


def recover_headings(doc) -> dict[str, int]:
    """Relabel mislabelled headings in place. Returns counts by original label."""
    stats = {"page_header": 0, "text": 0}
    layers = {ContentLayer.BODY, ContentLayer.FURNITURE}
    # Materialize first: we mutate doc.texts while walking.
    walk = [it for it, _ in doc.iterate_items(included_content_layers=layers)]

    # (a) which page-header texts recur across pages
    pages_by_text: dict[str, set[int]] = defaultdict(set)
    for it in walk:
        if isinstance(it, TextItem) and it.label == DocItemLabel.PAGE_HEADER and it.text.strip():
            pages_by_text[_norm_head(it.text)] |= {int(p.page_no) for p in it.prov}

    level = 1
    for it in walk:
        if isinstance(it, (TitleItem, SectionHeaderItem)):
            level = getattr(it, "level", 1) or 1
            continue
        if type(it) is not TextItem or not it.text.strip():
            continue

        if it.label == DocItemLabel.PAGE_HEADER:
            pages = {int(p.page_no) for p in it.prov}
            if not pages:  # no page provenance (Word headers): cannot tell a running head apart
                continue
            seen_on = pages_by_text.get(_norm_head(it.text), set())
            words = it.text.split()
            if len(seen_on) < RUNNING_HEAD_MIN_PAGES and len(words) < 25 and any(w.isalpha() for w in words):
                _promote(doc, it, level)
                stats["page_header"] += 1
        elif it.label in (DocItemLabel.TEXT, DocItemLabel.PARAGRAPH) and it.content_layer == ContentLayer.BODY:
            if _looks_like_heading(it.text):
                _promote(doc, it, level)
                stats["text"] += 1
    return stats


def count_headings(doc) -> int:
    return sum(1 for it, _ in doc.iterate_items() if isinstance(it, (TitleItem, SectionHeaderItem)))


# -------------------------------------------------------------------
# Core parse
# -------------------------------------------------------------------
def parse_file(path: Path, warnings: list[str]) -> dict:
    t0 = time.time()
    result = CONVERTER.convert(str(path))
    doc = result.document
    t_convert = time.time() - t0

    page_count = len(doc.pages) if doc.pages else 0
    if page_count > MAX_PAGES:
        raise HTTPException(
            status_code=413,
            detail=f"Document has {page_count} pages; the limit is {MAX_PAGES}.",
        )

    for err in getattr(result, "errors", None) or []:
        warnings.append(str(getattr(err, "error_message", err)))

    headings_before = count_headings(doc)
    recovered = recover_headings(doc)
    headings_after = count_headings(doc)
    n_recovered = sum(recovered.values())
    if n_recovered:
        warnings.append(
            f"heading recovery: promoted {n_recovered} item(s) to section headers "
            f"({recovered['page_header']} page header(s), {recovered['text']} text line(s))"
        )

    t1 = time.time()
    chunks_out: list[dict] = []
    for chunk in CHUNKER.chunk(dl_doc=doc):
        text = (chunk.text or "").strip()
        if not text:
            continue

        embed_text = CHUNKER.contextualize(chunk=chunk).strip()
        headings = list(chunk.meta.headings or [])
        labels = [getattr(i, "label", None) for i in (chunk.meta.doc_items or [])]
        boxes, p_start, p_end = normalized_boxes(doc, chunk)

        chunks_out.append(
            {
                "index": len(chunks_out),  # dense: assigned after the empty-text filter
                "text": text,
                "embed_text": embed_text,
                "item_kind": item_kind(labels),
                "headings": headings,
                "section_label": section_label(headings),
                "page_start": p_start,
                "page_end": p_end,
                "bboxes": boxes,
                "token_count": len(ENCODING.encode(embed_text)),
                "content_hash": hashlib.sha256(text.encode("utf-8")).hexdigest()[:32],
            }
        )
    t_chunk = time.time() - t1

    markdown = doc.export_to_markdown()

    log.info(
        "parsed %s pages=%d chunks=%d headings=%d(+%d recovered) convert=%.1fs chunk=%.1fs",
        path.name, page_count, len(chunks_out), headings_after, n_recovered, t_convert, t_chunk,
    )

    return {
        "parser": "docling",
        "parser_version": PARSER_VERSION,
        "page_count": page_count,
        "markdown": markdown,
        "chunks": chunks_out,
        "warnings": warnings,
        "stats": {
            "headings_docling": headings_before,
            "headings_recovered": recovered,
            "headings_total": headings_after,
            "chunks_with_section_label": sum(1 for c in chunks_out if c["section_label"]),
        },
        "timings": {"convert_s": round(t_convert, 2), "chunk_s": round(t_chunk, 2)},
    }


# -------------------------------------------------------------------
# Routes
# -------------------------------------------------------------------
@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "parser": "docling",
        "version": PARSER_VERSION,
        "ocr": OCR_ENGINE,
        "render": shutil.which("soffice") is not None,
    }


# -------------------------------------------------------------------
# /render — Office file → PDF rendition (viewing only; parsing still
# reads the original so Word heading structure is preserved).
# -------------------------------------------------------------------
RENDER_SUFFIXES = {".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls", ".odt", ".odp", ".ods", ".rtf"}


def render_pdf(src: Path, out_dir: Path) -> Path:
    env = dict(os.environ, HOME="/tmp")  # soffice needs a writable profile dir
    cmd = [
        "soffice", "--headless", "--norestore", "--nologo",
        "--convert-to", "pdf", "--outdir", str(out_dir), str(src),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180, env=env)
    pdf = out_dir / (src.stem + ".pdf")
    if proc.returncode != 0 or not pdf.exists():
        raise RuntimeError((proc.stderr or proc.stdout or "soffice failed").strip()[:300])
    return pdf


@app.post("/render")
async def render(
    file: UploadFile = File(...),
    x_parser_secret: str | None = Header(default=None),
):
    if PARSER_SECRET and x_parser_secret != PARSER_SECRET:
        raise HTTPException(status_code=401, detail="Bad parser secret.")

    name = file.filename or "upload"
    suffix = Path(name).suffix.lower()
    if suffix not in RENDER_SUFFIXES:
        raise HTTPException(status_code=415, detail=f"No PDF rendition for {suffix or 'this type'}")
    if shutil.which("soffice") is None:
        raise HTTPException(status_code=501, detail="LibreOffice is not installed in this image.")

    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / f"source{suffix}"
        src.write_bytes(await file.read())
        try:
            t0 = time.time()
            pdf = await run_in_threadpool(render_pdf, src, Path(tmp))
            data = pdf.read_bytes()
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="Rendering timed out.")
        except Exception as exc:  # noqa: BLE001
            log.exception("render failed for %s", name)
            raise HTTPException(status_code=422, detail=f"Could not render this document: {exc}") from exc

        pages = 0
        try:
            import pypdfium2 as pdfium
            pages = len(pdfium.PdfDocument(data))
        except Exception:  # noqa: BLE001
            pass

        log.info("rendered %s -> pdf pages=%d bytes=%d in %.1fs", name, pages, len(data), time.time() - t0)
        return Response(content=data, media_type="application/pdf", headers={"X-Page-Count": str(pages)})


@app.post("/parse")
async def parse(
    file: UploadFile = File(...),
    options: str | None = Form(default=None),
    x_parser_secret: str | None = Header(default=None),
) -> dict:
    if PARSER_SECRET and x_parser_secret != PARSER_SECRET:
        raise HTTPException(status_code=401, detail="Bad parser secret.")

    name = file.filename or "upload"
    suffix = Path(name).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(status_code=415, detail=f"Unsupported file type: {suffix or 'none'}")

    opts: dict = {}
    if options:
        try:
            opts = json.loads(options)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="options must be JSON")

    warnings: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / f"upload{suffix}"
        size = 0
        with target.open("wb") as fh:
            while True:
                piece = await file.read(1 << 20)
                if not piece:
                    break
                size += len(piece)
                fh.write(piece)
        if size == 0:
            raise HTTPException(status_code=400, detail="Empty file.")

        try:
            payload = await run_in_threadpool(parse_file, target, warnings)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("parse failed for %s", name)
            raise HTTPException(status_code=422, detail=f"Could not read this document: {exc}") from exc

    payload["file_name"] = name
    payload["byte_size"] = size
    payload["options"] = opts
    return payload
