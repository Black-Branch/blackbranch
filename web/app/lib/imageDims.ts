/** Read the pixel dimensions of an image file, or null if it can't be decoded. */
export function probeImageDims(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise((res) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { res({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { res(null); URL.revokeObjectURL(url); };
    img.src = url;
  });
}
