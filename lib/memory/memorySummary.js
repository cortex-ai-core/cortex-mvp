// lib/memory/memorySummary.js

export function summarizeMemoryResults(results) {
  if (!results || results.length === 0) {
    return "No relevant memories were found.";
  }

  let summary = `Top ${results.length} relevant memories:\n`;

  results.forEach((r, i) => {
    summary += `\n${i + 1}. ${r.text.slice(0, 120)}... (relevance: ${
      Math.round(r.finalScore * 100) / 100
    })`;
  });

  return summary;
}

