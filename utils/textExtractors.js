// utils/textExtractors.js
// ============================================================
//  CORTÉX — ADVANCED DOCUMENT EXTRACTORS (VISION + SAFETY)
//  Supports: PDF, DOCX, IMAGES (PNG/JPG), TXT
//  Includes PII masking + clinician/patient masking
// ============================================================

import fs from "fs";
import OpenAI from "openai";
import { fileTypeFromBuffer } from "file-type";
import { PDFDocument } from "pdf-lib";
import { maskPII } from "./sanitizers.js";

// remove mammoth + remove docx-preview — they are NOT needed

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ============================================================
//  MASTER EXTRACTOR — detects file type and routes properly
// ============================================================
export async function extractTextFromFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const type = await fileTypeFromBuffer(buffer);

  if (!type) return extractPlain(filePath);

  const ext = type.ext.toLowerCase();

  if (ext === "pdf") return extractPdfVision(buffer);
  if (ext === "docx") return extractDocxVision(buffer);
  if (["png", "jpg", "jpeg", "webp"].includes(ext))
    return extractImageVision(buffer);
  if (ext === "txt") return extractPlain(filePath);

  throw new Error(`Unsupported file type: ${ext}`);
}

// ============================================================
// 1) PDF via Vision (OpenAI)
// ============================================================
async function extractPdfVision(buffer) {
  const pdf = await PDFDocument.load(buffer);
  const pageCount = pdf.getPageCount();

  let output = "";

  // Vision can read the whole PDF — skip slicing per-page
  const base64Pdf = Buffer.from(buffer).toString("base64");

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Extract all readable text from this PDF." },
          {
            type: "input_file",
            file: { name: "document.pdf", content: base64Pdf },
          },
        ],
      },
    ],
  });

  output = res.choices?.[0]?.message?.content || "";

  return maskPII(output);
}

// ============================================================
// 2) DOCX via Vision API
// ============================================================
async function extractDocxVision(buffer) {
  const base64Docx = buffer.toString("base64");

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Extract clean text from this DOCX file." },
          {
            type: "input_file",
            file: { name: "document.docx", content: base64Docx },
          },
        ],
      },
    ],
  });

  return maskPII(res.choices?.[0]?.message?.content || "");
}

// ============================================================
// 3) IMAGE (OCR) via Vision
// ============================================================
async function extractImageVision(buffer) {
  const base64Image = buffer.toString("base64");

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Extract all text from this image." },
          {
            type: "input_image",
            image: { content: base64Image },
          },
        ],
      },
    ],
  });

  return maskPII(res.choices?.[0]?.message?.content || "");
}

// ============================================================
// 4) Plain text fallback
// ============================================================
function extractPlain(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return maskPII(raw);
}

