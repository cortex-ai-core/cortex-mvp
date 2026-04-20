// lib/rag/extractDocx.ts

import fs from "fs";
import mammoth from "mammoth";

export async function extractDocx(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });
  return result.value || "";
}

