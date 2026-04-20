// lib/memory/summarizeMemory.js
// Step 32M — Fail-Safe Memory Summarizer

/**
 * Summarizes memory results into a compact text block
 * safe for injection into the system prompt.
 *
 * @param {Array} results - array of memory objects:
 *   { memoryId, text, score, metadata, finalScore }
 */
export function summarizeMemoryResults(results = []) {
  try {
    // Defensive guard: always return a usable summary
    if (!Array.isArray(results) || results.length === 0) {
      return "(no relevant memory found)";
    }

    // Limit to top 3 to avoid prompt overgrowth
    const top = results.slice(0, 3);

    const lines = top.map((m) => {
      // Protect against malformed memory objects
      const text = typeof m.text === "string" ? m.text.slice(0, 120) : "(invalid memory text)";
      const score =
        typeof m.finalScore === "number"
          ? m.finalScore.toFixed(2)
          : "N/A";

      return `• ${text}... (score: ${score})`;
    });

    return "Memory Recall:\n" + lines.join("\n");

  } catch (err) {
    console.error("❌ summarizeMemoryResults() error:", err);

    // Absolute fail-safe return
    return "(memory unavailable)";
  }
}

