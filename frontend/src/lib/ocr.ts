export type OcrProgress = (status: string, progress: number) => void;

/**
 * Run Tesseract OCR on an image file. Returns the recognised text.
 * Tesseract.js is dynamically imported so the ~5MB worker doesn't bloat the
 * initial bundle.
 */
export async function ocrImage(file: File, onProgress?: OcrProgress): Promise<string> {
  const { default: Tesseract } = await import("tesseract.js");
  const result = await Tesseract.recognize(file, "eng", {
    logger: (m) => {
      onProgress?.(m.status, m.progress ?? 0);
    },
  });
  return result.data.text.trim();
}
