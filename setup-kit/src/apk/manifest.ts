// The two things the plan needs from an APK's compiled AndroidManifest.xml (Android's binary
// XML, frameworks/base libs/androidfw ResourceTypes.h): the package name, and whether the
// application is test-only (android:testOnly, which only debug builds set).

import { ApkFormatError } from "./zip.js";

const RES_STRING_POOL = 0x0001;
const RES_XML = 0x0003;
const RES_XML_RESOURCE_MAP = 0x0180;
const RES_XML_START_ELEMENT = 0x0102;
const UTF8_FLAG = 0x100;
const TYPE_STRING = 0x03;
const TYPE_INT_BOOLEAN = 0x12;
const NO_INDEX = 0xffffffff;
const ANDROID_NS = "http://schemas.android.com/apk/res/android";
/** android:testOnly's resource id (android.R.attr.testOnly). */
const ATTR_TEST_ONLY = 0x01010272;

export interface Manifest {
  package: string;
  testOnly: boolean;
}

export function readManifest(bytes: Uint8Array): Manifest {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (): never => {
    throw new ApkFormatError("AndroidManifest.xml isn't a compiled manifest");
  };
  if (bytes.length < 8 || view.getUint16(0, true) !== RES_XML) fail();
  let strings: string[] = [];
  let resourceIds: number[] = [];
  let pkg = "";
  let testOnly = false;
  let p = view.getUint16(2, true);
  while (p + 8 <= bytes.length) {
    const type = view.getUint16(p, true);
    const headerSize = view.getUint16(p + 2, true);
    const size = view.getUint32(p + 4, true);
    if (size < 8 || p + size > bytes.length) fail();
    if (type === RES_STRING_POOL) {
      strings = readStrings(view, p, size);
    } else if (type === RES_XML_RESOURCE_MAP) {
      resourceIds = [];
      for (let q = p + headerSize; q + 4 <= p + size; q += 4) resourceIds.push(view.getUint32(q, true));
    } else if (type === RES_XML_START_ELEMENT) {
      const ext = p + headerSize;
      const name = strings[view.getUint32(ext + 4, true)];
      const attributeStart = view.getUint16(ext + 8, true);
      const attributeSize = view.getUint16(ext + 10, true);
      const attributeCount = view.getUint16(ext + 12, true);
      for (let i = 0; i < attributeCount; i++) {
        const a = ext + attributeStart + i * attributeSize;
        if (a + 20 > p + size) fail();
        const nsIndex = view.getUint32(a, true);
        const nameIndex = view.getUint32(a + 4, true);
        const raw = view.getUint32(a + 8, true);
        const dataType = view.getUint8(a + 15);
        const data = view.getUint32(a + 16, true);
        const ns = nsIndex === NO_INDEX ? "" : (strings[nsIndex] ?? "");
        const attr = strings[nameIndex] ?? "";
        if (name === "manifest" && ns === "" && attr === "package") {
          pkg = raw !== NO_INDEX ? (strings[raw] ?? "") : dataType === TYPE_STRING ? (strings[data] ?? "") : "";
        }
        const isTestOnly = resourceIds[nameIndex] === ATTR_TEST_ONLY || (ns === ANDROID_NS && attr === "testOnly");
        if (name === "application" && isTestOnly) testOnly = dataType === TYPE_INT_BOOLEAN ? data !== 0 : strings[raw] === "true";
      }
    }
    p += size;
  }
  if (pkg === "") fail();
  return { package: pkg, testOnly };
}

function readStrings(view: DataView, p: number, size: number): string[] {
  const count = view.getUint32(p + 8, true);
  const flags = view.getUint32(p + 16, true);
  const stringsStart = view.getUint32(p + 20, true);
  const headerSize = view.getUint16(p + 2, true);
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let q = p + stringsStart + view.getUint32(p + headerSize + i * 4, true);
    if (q >= p + size) throw new ApkFormatError("AndroidManifest.xml's strings are damaged");
    if (utf8) {
      // The length in UTF-16 units, then in bytes: one byte each, or two with the high bit set.
      q += (view.getUint8(q) & 0x80) !== 0 ? 2 : 1;
      let length = view.getUint8(q);
      if ((length & 0x80) !== 0) {
        length = ((length & 0x7f) << 8) | view.getUint8(q + 1);
        q += 2;
      } else {
        q += 1;
      }
      out.push(new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + q, length)));
    } else {
      let length = view.getUint16(q, true);
      if ((length & 0x8000) !== 0) {
        length = ((length & 0x7fff) << 16) | view.getUint16(q + 2, true);
        q += 4;
      } else {
        q += 2;
      }
      let s = "";
      for (let k = 0; k < length; k++) s += String.fromCharCode(view.getUint16(q + k * 2, true));
      out.push(s);
    }
  }
  return out;
}
