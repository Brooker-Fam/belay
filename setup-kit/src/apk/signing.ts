// The APK's signing certificate, from the APK Signing Block (source.android.com/docs/security/
// features/apksigning/v2 and v3): the first signer's first certificate of the newest scheme there,
// as Android 13 and later use it. Its SHA-256 is what apksigner prints as "certificate SHA-256
// digest" and what make-release-key.sh printed (platform notes I6).
//
// This only reads the certificate; it doesn't check the signature. Android does, when it
// installs: an APK whose signature doesn't match the certificate it names is refused.

import { ApkFormatError, type Zip } from "./zip.js";

const MAGIC = "APK Sig Block 42";
/** Block ids: APK Signature Scheme v3.1, v3, v2. */
const SCHEMES: [number, string][] = [
  [0x1b93ad61, "v3.1"],
  [0xf05368c0, "v3"],
  [0x7109871a, "v2"],
];

export interface Certificate {
  der: Uint8Array;
  scheme: string;
}

/** The signing certificate, or undefined when the APK has no v2 or v3 signature. */
export function signingCertificate(zip: Zip): Certificate | undefined {
  const { bytes, view, centralDirectory } = zip;
  const footer = centralDirectory - 24;
  if (footer < 8 || new TextDecoder().decode(bytes.subarray(footer + 8, centralDirectory)) !== MAGIC) return undefined;
  const size = Number(view.getBigUint64(footer, true));
  const start = centralDirectory - size - 8;
  if (start < 0 || Number(view.getBigUint64(start, true)) !== size) throw new ApkFormatError("the APK Signing Block is damaged");
  const blocks = new Map<number, [number, number]>();
  for (let p = start + 8; p < footer; ) {
    const length = Number(view.getBigUint64(p, true));
    if (length < 4 || p + 8 + length > footer) throw new ApkFormatError("the APK Signing Block is damaged");
    blocks.set(view.getUint32(p + 8, true), [p + 12, p + 8 + length]);
    p += 8 + length;
  }
  for (const [id, scheme] of SCHEMES) {
    const block = blocks.get(id);
    if (block === undefined) continue;
    // signers → the first signer → its signed data → certificates → the first one. Every part
    // is a uint32 length and that many bytes.
    const r = new Reader(view, block[0], block[1]);
    const signer = r.part().part();
    const signedData = signer.part();
    signedData.part(); // digests
    const der = signedData.part().part().rest();
    return { der: bytes.slice(der[0], der[1]), scheme };
  }
  return undefined;
}

class Reader {
  constructor(
    private readonly view: DataView,
    private p: number,
    private readonly end: number,
  ) {}
  part(): Reader {
    if (this.p + 4 > this.end) throw new ApkFormatError("the APK's signature is damaged");
    const length = this.view.getUint32(this.p, true);
    const start = this.p + 4;
    if (start + length > this.end) throw new ApkFormatError("the APK's signature is damaged");
    this.p = start + length;
    return new Reader(this.view, start, start + length);
  }
  rest(): [number, number] {
    return [this.p, this.end];
  }
}

// X.509, as far as the subject's name: Certificate ::= SEQUENCE { tbsCertificate SEQUENCE {
// [0] version OPTIONAL, serialNumber, signature, issuer, validity, subject, ... }, ... }.

interface Der {
  tag: number;
  start: number;
  end: number;
  next: number;
}

function der(bytes: Uint8Array, p: number, end: number): Der {
  const fail = (): never => {
    throw new ApkFormatError("the APK's certificate is damaged");
  };
  if (p + 2 > end) fail();
  const tag = bytes[p] ?? 0;
  let length = bytes[p + 1] ?? 0;
  let start = p + 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n === 0 || n > 4 || start + n > end) fail();
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + (bytes[start + i] ?? 0);
    start += n;
  }
  if (start + length > end) fail();
  return { tag, start, end: start + length, next: start + length };
}

function children(bytes: Uint8Array, node: Der): Der[] {
  const out: Der[] = [];
  for (let p = node.start; p < node.end; ) {
    const child = der(bytes, p, node.end);
    out.push(child);
    p = child.next;
  }
  return out;
}

const NAMES: Record<string, string> = {
  "2.5.4.3": "CN",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.9": "STREET",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.12": "T",
  "2.5.4.5": "SERIALNUMBER",
  "0.9.2342.19200300.100.1.25": "DC",
  "0.9.2342.19200300.100.1.1": "UID",
  "1.2.840.113549.1.9.1": "EMAILADDRESS",
};

function oid(bytes: Uint8Array, node: Der): string {
  const parts: number[] = [];
  let value = 0;
  for (let p = node.start; p < node.end; p++) {
    const b = bytes[p] ?? 0;
    value = value * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      if (parts.length === 0) parts.push(value < 80 ? Math.floor(value / 40) : 2, value < 80 ? value % 40 : value - 80);
      else parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

/**
 * The certificate subject, as apksigner prints it ("certificate DN": Java's X500Name, the
 * most specific part first), like "CN=Belay release key".
 */
export function subjectName(cert: Uint8Array): string {
  const top = der(cert, 0, cert.length);
  const tbs = children(cert, top)[0];
  if (tbs === undefined) throw new ApkFormatError("the APK's certificate is damaged");
  const fields = children(cert, tbs);
  const subject = fields[(fields[0]?.tag ?? 0) === 0xa0 ? 5 : 4];
  if (subject === undefined) throw new ApkFormatError("the APK's certificate is damaged");
  const rdns = children(cert, subject).map((set) =>
    children(cert, set)
      .map((seq) => {
        const [type, value] = children(cert, seq);
        if (type === undefined || value === undefined) return "";
        const id = oid(cert, type);
        // A BMPString (0x1e) is UTF-16; the others an APK's certificate uses are ASCII or UTF-8.
        const text = new TextDecoder(value.tag === 0x1e ? "utf-16be" : "utf-8").decode(cert.subarray(value.start, value.end));
        const name = NAMES[id] ?? `OID.${id}`;
        return `${name}=${/[,+"\\<>;=]|^\s|\s$/.test(text) ? `"${text.replace(/(["\\])/g, "\\$1")}"` : text}`;
      })
      .join(" + "),
  );
  return rdns.reverse().join(", ");
}

/** The SHA-256 of DER bytes, lowercase hex, as apksigner prints it. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  // An APK's bytes are never in a SharedArrayBuffer.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
