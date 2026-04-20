// ===============================================
//  CORTÉX — extractPdf.js
//  PDF text extraction using pdf-parse (JS version)
// ===============================================

import fs from "fs";
import { createRequire } from "module";

// pdf-parse is CommonJS, so require() is needed
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

export async function extractPdf(filePath) {
  const buffer = fs.readFileSync(filePath);

  try {
    const data = await pdfParse(buffer);
    return data.text || "";
  } catch (err) {
    console.error("❌ PDF extraction error:", err);
    throw err;
  }
}

