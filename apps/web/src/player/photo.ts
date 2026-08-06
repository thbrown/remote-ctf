const MAX_PHOTO_PX = 128; // HUB-171

/** Downscales an image file to <=128x128 and returns raw base64 (no data: URL prefix -
 * the server decodes it straight with Buffer.from(..., 'base64')). */
export async function downscalePhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_PHOTO_PX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unsupported');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}
