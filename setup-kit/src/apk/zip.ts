// Just enough of the ZIP format to read an APK: the central directory, one entry's bytes, and
// where the central directory starts (the APK Signing Block sits right before it). Works the
// same in the browser and in Node (DecompressionStream).

export class ApkFormatError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeader: number;
}

export interface Zip {
  bytes: Uint8Array;
  view: DataView;
  centralDirectory: number;
  entries: ZipEntry[];
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function readZip(bytes: Uint8Array): Zip {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record: 22 bytes, then a comment of up to 65535.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD && i + 22 + view.getUint16(i + 20, true) === bytes.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ApkFormatError("this isn't a ZIP file, so it can't be an APK");
  const count = view.getUint16(eocd + 10, true);
  const centralDirectory = view.getUint32(eocd + 16, true);
  if (centralDirectory === 0xffffffff || count === 0xffff) throw new ApkFormatError("ZIP64 files aren't APKs Belay builds");
  const entries: ZipEntry[] = [];
  let p = centralDirectory;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL) throw new ApkFormatError("the ZIP's central directory is damaged");
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength)),
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      localHeader: view.getUint32(p + 42, true),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return { bytes, view, centralDirectory, entries };
}

/** An entry's contents, inflated. */
export async function readEntry(zip: Zip, name: string): Promise<Uint8Array | undefined> {
  const entry = zip.entries.find((e) => e.name === name);
  if (entry === undefined) return undefined;
  const p = entry.localHeader;
  if (p + 30 > zip.bytes.length || zip.view.getUint32(p, true) !== LOCAL) throw new ApkFormatError(`${name}'s ZIP header is damaged`);
  const start = p + 30 + zip.view.getUint16(p + 26, true) + zip.view.getUint16(p + 28, true);
  const data = zip.bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new ApkFormatError(`${name} uses a compression APKs don't`);
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
