// =============================================================
//  HTTP client for the Docling parser sidecar (see /parser).
// =============================================================

const PARSER_URL = (process.env.PARSER_URL || "http://localhost:8090").replace(/\/$/, "");
const PARSER_SECRET = process.env.PARSER_SECRET || "";
const PARSER_TIMEOUT_MS = Number(process.env.PARSER_TIMEOUT_MS || 600000);

export class ParserError extends Error {
  constructor(message, { status = 500, detail = null } = {}) {
    super(message);
    this.name = "ParserError";
    this.status = status;
    this.detail = detail;
  }
}

export async function parserHealth() {
  try {
    const res = await fetch(`${PARSER_URL}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** File types the parser can turn into a PDF rendition for viewing. */
export const RENDERABLE_EXT = new Set([".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls", ".odt", ".odp", ".ods", ".rtf"]);

/**
 * Ask the parser for a PDF rendition of an Office file (viewing only).
 * @returns {Promise<{ buffer: Buffer, pageCount: number }>}
 */
export async function renderPdf({ buffer, fileName }) {
  const form = new FormData();
  form.append("file", new Blob([buffer]), fileName);

  const res = await fetch(`${PARSER_URL}/render`, {
    method: "POST",
    headers: PARSER_SECRET ? { "X-Parser-Secret": PARSER_SECRET } : {},
    body: form,
    signal: AbortSignal.timeout(Math.min(PARSER_TIMEOUT_MS, 240000)),
  });

  if (!res.ok) {
    const text = await res.text();
    let detail = text.slice(0, 300);
    try { detail = JSON.parse(text)?.detail || detail; } catch { /* keep text */ }
    throw new ParserError(typeof detail === "string" ? detail : JSON.stringify(detail), { status: res.status });
  }

  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    pageCount: Number(res.headers.get("x-page-count") || 0),
  };
}

/**
 * Send a file to the parser and get back chunks with provenance.
 * @param {{ buffer: Buffer, fileName: string, options?: object }} args
 */
export async function parseDocument({ buffer, fileName, options = {} }) {
  const form = new FormData();
  form.append("file", new Blob([buffer]), fileName);
  form.append("options", JSON.stringify(options));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PARSER_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${PARSER_URL}/parse`, {
      method: "POST",
      headers: PARSER_SECRET ? { "X-Parser-Secret": PARSER_SECRET } : {},
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === "AbortError") {
      throw new ParserError(`The parser did not finish within ${Math.round(PARSER_TIMEOUT_MS / 60000)} minutes.`, { status: 504 });
    }
    throw new ParserError(`Could not reach the parser at ${PARSER_URL}.`, { status: 503, detail: err?.message });
  }
  clearTimeout(timer);

  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON error body */ }

  if (!res.ok) {
    const detail = body?.detail || text.slice(0, 300) || `HTTP ${res.status}`;
    throw new ParserError(typeof detail === "string" ? detail : JSON.stringify(detail), { status: res.status, detail });
  }

  if (!body || !Array.isArray(body.chunks)) {
    throw new ParserError("Parser returned an unexpected response.", { status: 502 });
  }

  return body;
}
