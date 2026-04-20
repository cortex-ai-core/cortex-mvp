import Tesseract from "tesseract.js";
import fs from "fs";

const imagePath = "./test.png"; // use any small image with text

if (!fs.existsSync(imagePath)) {
  console.error("❌ test.png not found. Place a small image with text in the server folder.");
  process.exit(1);
}

Tesseract.recognize(imagePath, "eng")
  .then(({ data: { text } }) => {
    console.log("🟢 OCR Output:");
    console.log(text);
  })
  .catch(err => {
    console.error("❌ OCR Error:", err);
  });

