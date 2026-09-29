/** Reads a local file (photo, audio) as base64 — works with every fetch implementation. */
export async function readBase64(uri: string): Promise<string | null> {
  try {
    const blob = await (await fetch(uri)).blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result.split(',')[1] ?? null : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
