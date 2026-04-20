// ===============================================
//  CORTÉX — extractDocx.js
//  DOCX text extraction using mammoth (JS version)
// ===============================================

import fs from "fs";
import mammoth from "mammoth";

export async function extractDocx(filePath) {
  const buffer = fs.readFileSync(filePath);

  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  } catch (err) {
    console.error("❌ DOCX extraction error:", err);
    throw err;
  }
}

