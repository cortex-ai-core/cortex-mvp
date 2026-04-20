// ===============================================
//  CORTÉX — extractText.js
//  Unified text extractor for TXT, PDF, DOCX
// ===============================================

import fs from "fs";
import path from "path";

import { extractPdf } from "./extractPdf.js";
import { extractDocx } from "./extractDocx.js";

export async function extractTextFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case ".txt":
    case ".md":
      return fs.readFileSync(filePath, "utf8");

    case ".pdf":
      return await extractPdf(filePath);

    case ".docx":
      return await extractDocx(filePath);

    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}

