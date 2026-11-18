/**
 * The parent pages' multipart/form-data reader (web/upload.ts), which "Add a version of Belay"
 * uses to stream an APK to disk: what browsers send, cut into chunks anywhere, and what they don't.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FormReader } from "../src/web/upload.js";

/** A form as undici serializes it, which is how browsers do: its Content-Type and bytes. */
async function serialize(fields: [string, string | File][]): Promise<{ type: string; bytes: Buffer }> {
  const form = new FormData();
  for (const [name, value] of fields) form.append(name, value);
  const request = new Request("https://belay.example.org/", { method: "POST", body: form });
  return { type: request.headers.get("content-type") ?? "", bytes: Buffer.from(await request.arrayBuffer()) };
}

/**
 * A request whose body arrives in chunks of `size` bytes, optionally failing after `failAfter` of
 * them; `sent.bytes` is how much of it has been read so far.
 */
function requestOf(
  type: string,
  bytes: Buffer,
  opts: { size?: number; failAfter?: number; headers?: Record<string, string>; sent?: { bytes: number } } = {},
): Request {
  const size = opts.size ?? 64 * 1024;
  const sent = opts.sent ?? { bytes: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (opts.failAfter !== undefined && sent.bytes >= opts.failAfter) {
          controller.error(new Error("the connection was reset"));
          return;
        }
        if (sent.bytes >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(bytes.subarray(sent.bytes, sent.bytes + size)));
        sent.bytes = Math.min(bytes.length, sent.bytes + size);
      },
    },
    { highWaterMark: 0 },
  );
  return new Request("https://belay.example.org/", { method: "POST", headers: { "content-type": type, ...opts.headers }, body, duplex: "half" });
}

/** Every part: text fields as text, files as their bytes. */
async function readAll(form: FormReader) {
  const parts: { name: string; filename: string | null; value: string | Buffer }[] = [];
  for (let part = await form.next(); part !== null; part = await form.next()) {
    if (part.filename === null) {
      parts.push({ ...part, value: await form.text(1024) });
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of form.file()) chunks.push(chunk as Buffer);
      parts.push({ ...part, value: Buffer.concat(chunks) });
    }
  }
  return parts;
}

const MB = 1024 * 1024;

describe("FormReader", () => {
  it("reads a browser's form in order, the file as it arrives, cut into chunks anywhere", async () => {
    const apk = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), randomBytes(5000), Buffer.from("\r\n--not the boundary\r\n"), randomBytes(100)]);
    const { type, bytes } = await serialize([
      ["_csrf", "token-123"],
      ["version_code", "7"],
      ["version_name", "0.6.0 é"],
      ["apk", new File([apk], "belay-0.6.0.apk", { type: "application/vnd.android.package-archive" })],
    ]);
    for (const size of [1, 2, 3, 7, 61, 1000, 64 * 1024]) {
      const parts = await readAll(FormReader.open(requestOf(type, bytes, { size }), MB));
      expect(parts.map((p) => [p.name, p.filename]), `chunks of ${size}`).toEqual([
        ["_csrf", null],
        ["version_code", null],
        ["version_name", null],
        ["apk", "belay-0.6.0.apk"],
      ]);
      expect(parts.slice(0, 3).map((p) => p.value)).toEqual(["token-123", "7", "0.6.0 é"]);
      expect((parts[3]?.value as Buffer).equals(apk), `chunks of ${size}`).toBe(true);
    }
  });

  it("says when no file was chosen: browsers send an empty file name", async () => {
    // As Chrome sends a file input with nothing chosen (undici leaves the file name out instead).
    const body = Buffer.from('--b\r\nContent-Disposition: form-data; name="apk"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--b--\r\n', "latin1");
    const form = FormReader.open(requestOf("multipart/form-data; boundary=b", body), MB);
    expect(await form.next()).toEqual({ name: "apk", filename: "" });
    expect(await form.next()).toBeNull();
  });

  it("takes a quoted boundary, a preamble, an epilogue and padding after a boundary, as RFC 2046 allows", async () => {
    const body = Buffer.from(
      'This is the preamble.\r\n--b:1 2\r\nContent-Disposition: form-data; name="a"\r\n\r\none\r\n--b:1 2  \r\ncontent-disposition: FORM-DATA; filename="x.apk"; name="f"\r\n\r\nPK\x03\x04\r\n--b:1 2--\r\nThe epilogue.',
      "latin1",
    );
    const parts = await readAll(FormReader.open(requestOf('multipart/form-data; boundary="b:1 2"', body, { size: 5 }), MB));
    expect(parts).toEqual([
      { name: "a", filename: null, value: "one" },
      { name: "f", filename: "x.apk", value: Buffer.from("PK\x03\x04", "latin1") },
    ]);
  });

  it("skips what's left of a part when asked for the next one, and discard reads the rest away", async () => {
    const { type, bytes } = await serialize([
      ["apk", new File([randomBytes(200_000)], "a.apk")],
      ["after", "yes"],
      ["more", "x".repeat(50_000)],
    ]);
    const sent = { bytes: 0 };
    const form = FormReader.open(requestOf(type, bytes, { size: 4096, sent }), MB);
    expect(await form.next()).toMatchObject({ name: "apk" });
    expect(await form.next()).toEqual({ name: "after", filename: null });
    await form.discard();
    expect(sent.bytes).toBe(bytes.length);
    expect(await form.next()).toBeNull();
  });

  it("says what isn't multipart/form-data, or is larger than the limit, before reading any of it", async () => {
    let pulled = 0;
    const request = (type: string, length?: number) =>
      new Request("https://belay.example.org/", {
        method: "POST",
        headers: { "content-type": type, ...(length === undefined ? {} : { "content-length": String(length) }) },
        body: new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulled++;
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        duplex: "half",
      });
    for (const [type, length, problem] of [
      ["application/x-www-form-urlencoded", undefined, "not_multipart"],
      ["multipart/form-data", undefined, "not_multipart"],
      ['multipart/form-data; boundary="ends in a space "', undefined, "not_multipart"],
      ["multipart/form-data; boundary=a@b", undefined, "not_multipart"],
      ["multipart/form-data; boundary=x", MB + 1, "too_large"],
    ] as const) {
      await expect(FormReader.open(request(type, length), MB).next(), type).rejects.toMatchObject({ problem });
    }
    expect(pulled).toBe(0);
    // Larger than twice the limit: discard doesn't wait for it either.
    await FormReader.open(request("multipart/form-data; boundary=x", 2 * MB + 1), MB).discard();
    expect(pulled).toBe(0);
    await FormReader.open(request("multipart/form-data; boundary=x", 2 * MB), MB).discard();
    expect(pulled).toBe(1);
  });

  it("stops at the limit without a Content-Length, and when the browser stops sending", async () => {
    const { type, bytes } = await serialize([["apk", new File([randomBytes(300_000)], "a.apk")]]);
    const tooMuch = FormReader.open(requestOf(type, bytes, { size: 1000 }), 100_000);
    await expect(readAll(tooMuch)).rejects.toMatchObject({ problem: "too_large" });
    // A cancelled upload: the connection breaks partway through the file.
    const cancelled = FormReader.open(requestOf(type, bytes, { size: 1000, failAfter: 150_000 }), MB);
    await expect(readAll(cancelled)).rejects.toMatchObject({ problem: "ended" });
    await cancelled.discard();
    // Or the body just ends before the file does.
    const cut = FormReader.open(requestOf(type, bytes.subarray(0, 200_000), { size: 1000 }), MB);
    await expect(readAll(cut)).rejects.toMatchObject({ problem: "ended" });
  });

  it("after the limit, discard reads on, to twice the limit at most, and never fails", async () => {
    const { type, bytes } = await serialize([["apk", new File([randomBytes(300_000)], "a.apk")]]);
    // A little over the limit: read to the end, so the browser sees the answer.
    const sent = { bytes: 0 };
    const over = FormReader.open(requestOf(type, bytes, { size: 1000, sent }), 200_000);
    await expect(readAll(over)).rejects.toMatchObject({ problem: "too_large" });
    expect(sent.bytes).toBeLessThan(bytes.length);
    await over.discard();
    expect(sent.bytes).toBe(bytes.length);
    // Far over it: up to twice the limit, then no more.
    const far = { bytes: 0 };
    const tooFar = FormReader.open(requestOf(type, bytes, { size: 1000, sent: far }), 100_000);
    await expect(readAll(tooFar)).rejects.toMatchObject({ problem: "too_large" });
    await tooFar.discard();
    expect(far.bytes).toBeGreaterThan(200_000);
    expect(far.bytes).toBeLessThan(202_000);
    // A body that breaks while it's read away.
    const broken = FormReader.open(requestOf(type, bytes, { size: 1000, failAfter: 50_000 }), MB);
    expect(await broken.next()).toMatchObject({ name: "apk" });
    await broken.discard();
  });

  it("refuses a form that isn't one a browser sends", async () => {
    const read = (body: string, max = 1024) => readAll(FormReader.open(requestOf("multipart/form-data; boundary=b", Buffer.from(body, "latin1"), { size: 3 }), max));
    const part = (headers: string) => `--b\r\n${headers}\r\n\r\nvalue\r\n--b--\r\n`;
    await expect(read(part('Content-Type: text/plain; name="a"'))).rejects.toMatchObject({ problem: "malformed" });
    await expect(read(part('Content-Disposition: attachment; name="a"'))).rejects.toMatchObject({ problem: "malformed" });
    await expect(read(part("Content-Disposition: form-data"))).rejects.toMatchObject({ problem: "malformed" });
    await expect(read(part('not a header\r\nContent-Disposition: form-data; name="a"'))).rejects.toMatchObject({ problem: "malformed" });
    await expect(read(`--b\r\nContent-Disposition: form-data; name="a"; x="${"y".repeat(10_000)}"\r\n\r\nvalue\r\n--b--\r\n`, 100_000)).rejects.toMatchObject({
      problem: "malformed",
    });
    // A text field longer than asked for.
    await expect(read(`--b\r\nContent-Disposition: form-data; name="a"\r\n\r\n${"x".repeat(2000)}\r\n--b--\r\n`, 100_000)).rejects.toMatchObject({ problem: "malformed" });
    // No boundary at all, or no end.
    await expect(read("just some text")).rejects.toMatchObject({ problem: "ended" });
    await expect(read('--b\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue')).rejects.toMatchObject({ problem: "ended" });
  });
});
