/**
 * Decode every Focus3 QR in an image file. We expect QR contents in the form
 * "focus3:<task-id>" — anything else is ignored.
 *
 * jsqr only finds one QR per call, so we mask each detection and re-run until
 * no more codes are found (capped at 30 detections to keep things bounded).
 */
export async function decodeFocus3QRs(file: File): Promise<string[]> {
  const jsQR = (await import("jsqr")).default;
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const ids = new Set<string>();
    for (let attempt = 0; attempt < 30; attempt++) {
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: "dontInvert",
      });
      if (!code) break;
      if (code.data && code.data.startsWith("focus3:")) {
        ids.add(code.data.slice("focus3:".length));
      }
      // Mask the located region so the next jsQR pass finds the next code.
      const x1 = Math.max(0, Math.floor(code.location.topLeftCorner.x));
      const y1 = Math.max(0, Math.floor(code.location.topLeftCorner.y));
      const x2 = Math.min(
        imageData.width,
        Math.floor(code.location.bottomRightCorner.x),
      );
      const y2 = Math.min(
        imageData.height,
        Math.floor(code.location.bottomRightCorner.y),
      );
      for (let yy = y1; yy < y2; yy++) {
        for (let xx = x1; xx < x2; xx++) {
          const i = (yy * imageData.width + xx) * 4;
          imageData.data[i] = 255;
          imageData.data[i + 1] = 255;
          imageData.data[i + 2] = 255;
        }
      }
    }
    return Array.from(ids);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}
