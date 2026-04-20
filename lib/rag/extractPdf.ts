// lib/rag/extractPdf.ts

import fs from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

export async function extractPdf(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);

  const data = await pdfParse(buffer);

  return data.text || "";
}

