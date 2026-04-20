// ===============================================
// Cortéx File Parser — Step 15D
// Supports: PDF, DOCX, TXT
// ===============================================

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import mammoth from "mammoth";

// Require wrapper for CommonJS modules (like pdf-parse)
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

// ===============================================
// Detect file extension
// ===============================================
function getExtension(filename) {
  return filename.split(".").pop().toLowerCase();
}

// ===============================================
// Parse TXT
// ===============================================
async function parseTXT(buffer) {
  return buffer.toString("utf-8");
}

// ===============================================
// Parse PDF (using CommonJS require wrapper → works in ESM)
// ===============================================
async function parsePDF(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text || "";
  } catch (err) {
    console.error("❌ PDF parsing error:", err);
    throw new Error("Failed to parse PDF file");
  }
}

// ===============================================
// Parse DOCX
// ===============================================
async function parseDOCX(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  } catch (err) {
    console.error("❌ DOCX parsing error:", err);
    throw new Error("Failed to parse DOCX file");
  }
}

// ===============================================
// Main Parser Entry Point
// ===============================================
export async function parseFile(fileBuffer, filename) {
  const ext = getExtension(filename);

  switch (ext) {
    case "txt":
      return await parseTXT(fileBuffer);

    case "pdf":
      return await parsePDF(fileBuffer);

    case "docx":
      return await parseDOCX(fileBuffer);

    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}

