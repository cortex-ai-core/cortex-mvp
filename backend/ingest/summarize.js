// =============================================================
//  Document summary, produced once at ingest time.
//  Stored in documents.metadata.ingest.summary and used for
//  overview questions ("what is in X?", "summarize X").
// =============================================================

const SUMMARY_MODEL = process.env.SUMMARY_MODEL || process.env.CORTEX_MODEL || "gpt-5.1";
// ~40k tokens of markdown per call; longer documents are summarized from an outline
const SUMMARY_MAX_CHARS = Number(process.env.SUMMARY_MAX_CHARS || 160000);

function buildOutline(chunks) {
  // Fallback input for very long documents: section labels + a lead sentence each.
  const seen = new Set();
  const lines = [];
  for (const c of chunks) {
    const label = c.section_label || "(untitled)";
    const key = `${label}|${c.page_start ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lead = (c.text || "").replace(/\s+/g, " ").slice(0, 220);
    lines.push(`- [p.${c.page_start ?? "?"}] ${label}: ${lead}`);
  }
  return lines.join("\n");
}

export function renderOverview(summary, { fileName, pageCount } = {}) {
  if (!summary) return "";
  const parts = [];
  parts.push(`DOCUMENT: ${fileName}${pageCount ? ` (${pageCount} pages)` : ""}`);
  if (summary.purpose) parts.push(`PURPOSE: ${summary.purpose}`);
  if (summary.audience) parts.push(`AUDIENCE: ${summary.audience}`);
  if (Array.isArray(summary.sections) && summary.sections.length) {
    parts.push("SECTIONS:");
    for (const s of summary.sections) {
      parts.push(`- ${s.title}${s.pages ? ` (pages ${s.pages})` : ""}: ${s.summary}`);
    }
  }
  if (Array.isArray(summary.key_facts) && summary.key_facts.length) {
    parts.push("KEY FACTS:");
    for (const f of summary.key_facts) parts.push(`- ${f}`);
  }
  return parts.join("\n");
}

/**
 * What a document *is*, as one embeddable text: title, type, purpose, section
 * titles, entities, a few key facts. Kept short so the embedding captures the
 * document's identity rather than its detail. Stored on documents.profile_text
 * and embedded into documents.embedding (migration 0006).
 */
export function documentProfileText({ title, summary, sectionLabels = [] }, maxChars = 2000) {
  const parts = [];
  if (title) parts.push(`Document: ${title}`);
  if (summary?.document_type) parts.push(`Type: ${summary.document_type}`);
  if (summary?.purpose) parts.push(`Purpose: ${summary.purpose}`);
  if (summary?.audience) parts.push(`Audience: ${summary.audience}`);
  const fromSummary = Array.isArray(summary?.sections) ? summary.sections.map((s) => s?.title).filter(Boolean) : [];
  const sections = [...new Set((fromSummary.length ? fromSummary : sectionLabels).filter(Boolean))].slice(0, 25);
  if (sections.length) parts.push(`Sections: ${sections.join("; ")}`);
  if (Array.isArray(summary?.entities) && summary.entities.length) parts.push(`Entities: ${summary.entities.slice(0, 15).join(", ")}`);
  if (Array.isArray(summary?.key_facts) && summary.key_facts.length) parts.push(`Key facts: ${summary.key_facts.slice(0, 8).join(" | ")}`);
  return parts.join("\n").slice(0, maxChars);
}

/**
 * @returns {Promise<object|null>} structured summary, or null if the call failed
 */
export async function summarizeDocument({ openai, fileName, markdown = "", chunks = [], pageCount = null, log }) {
  const useOutline = !markdown || markdown.length > SUMMARY_MAX_CHARS;
  const body = useOutline ? buildOutline(chunks) : markdown;
  if (!body.trim()) return null;

  const system = `You write faithful, compact summaries of business and technical documents for an executive knowledge base.
Only state what the document says. Do not speculate or add outside knowledge.
Return JSON with exactly these keys:
{
  "purpose": string (1-2 sentences: what this document is and what it is for),
  "audience": string (who it is written for, or "" if unclear),
  "document_type": string (e.g. "program review", "device description", "grant proposal", "resume"),
  "sections": [{ "title": string, "pages": string ("4-7" or "" when unknown), "summary": string (1-3 sentences) }],
  "key_facts": [string] (up to 12 specific, checkable facts with numbers, names, dates, codes),
  "entities": [string] (organizations, people, products, programs named; up to 15)
}
Keep "sections" to the document's real top-level structure (5-20 entries). Preserve exact figures and codes.`;

  const user = `FILE NAME: ${fileName}
PAGES: ${pageCount ?? "unknown"}
INPUT: ${useOutline ? "section outline (document too long for full text)" : "full text as markdown"}

${body}`;

  try {
    const t0 = Date.now();
    const res = await openai.chat.completions.create({
      model: SUMMARY_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const raw = res.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw);
    log?.info?.({ file: fileName, model: SUMMARY_MODEL, ms: Date.now() - t0, outline: useOutline, sections: parsed.sections?.length }, "ingest: summary written");
    return {
      ...parsed,
      model: SUMMARY_MODEL,
      from: useOutline ? "outline" : "full_text",
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    log?.warn?.({ file: fileName, err: err?.message }, "ingest: summary failed (non-fatal)");
    return null;
  }
}
