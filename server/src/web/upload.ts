/**
 * The one form on the parent pages that sends a file: "Add a version of Belay", an APK of up to
 * 100 MB. Hono's parseBody reads a whole body into memory (Request.formData), so this reads
 * multipart/form-data (RFC 7578) from the request's body stream as it arrives instead, part by
 * part, holding a chunk or two of it at a time: the text fields first, then the file as a
 * stream, which addAgentFile writes to disk while it hashes it.
 *
 * A browser sends a form's fields in the order they are on the page (the HTML standard's "entry
 * list"), so that form puts the CSRF token first and the file last, and the route checks the token
 * before any of the file is read.
 */
import { Readable } from "node:stream";

/** What can be wrong with an upload: the route says each in words. */
export type UploadProblem = "not_multipart" | "too_large" | "ended" | "malformed";

export class UploadError extends Error {
  override name = "UploadError";
  constructor(readonly problem: UploadProblem) {
    super(`The upload couldn't be read: ${problem}`);
  }
}

export interface FormPart {
  /** The field's name. */
  name: string;
  /** A file field's file name as the browser sent it ("" when none was chosen); null for a text field. */
  filename: string | null;
}

const CRLF = Buffer.from("\r\n", "latin1");
const BLANK_LINE = Buffer.from("\r\n\r\n", "latin1");
/** A part's headers (its Content-Disposition and Content-Type) are far shorter than this. */
const MAX_HEADERS = 8 * 1024;
/** RFC 2046's boundary characters, 1 to 70 of them, not ending in a space. */
const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/;

/** The boundary of a multipart/form-data Content-Type, or null for any other type. */
function boundaryOf(contentType: string): string | null {
  const [type = "", ...params] = contentType.split(";");
  if (type.trim().toLowerCase() !== "multipart/form-data") return null;
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq < 0 || param.slice(0, eq).trim().toLowerCase() !== "boundary") continue;
    const value = param.slice(eq + 1).trim();
    const unquoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
    return BOUNDARY.test(unquoted) ? unquoted : null;
  }
  return null;
}

/** A Content-Disposition parameter, quoted as browsers send it (they write a quote in it as %22), or a bare token. */
function parameter(disposition: string, key: "name" | "filename"): string | null {
  const match = new RegExp(`;\\s*${key}\\s*=\\s*(?:"([^"]*)"|([^\\s;"]+))`, "i").exec(disposition);
  return match ? (match[1] ?? match[2] ?? "") : null;
}

/**
 * A multipart/form-data body, read part by part. At most `maxBytes` of it are read for its
 * parts; one step runs at a time, whoever asks.
 */
export class FormReader {
  /** What's been read and not used yet. It starts with a line break: the body's first boundary has none before it, every other one does. */
  private buffer: Buffer = CRLF;
  private received = 0;
  private ended = false;
  private broken: UploadError | null;
  /** Before the first boundary, after a boundary, in a part's body, or after the last boundary. */
  private state: "start" | "between" | "part" | "end" = "start";
  private delivered = 0;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array> | null,
    /** A line break, "--" and the boundary: what ends every part. */
    private readonly delimiter: Buffer,
    private readonly maxBytes: number,
    /** The body's Content-Length, if it gave one. */
    private readonly declared: number | null,
    problem: UploadError | null,
  ) {
    this.broken = problem;
  }

  /**
   * A reader for the request's form. It reads none of the body yet: when the body isn't
   * multipart/form-data, or its Content-Length is over `maxBytes`, the first `next()` says so,
   * and `discard()` can still read the rest away.
   */
  static open(request: Request, maxBytes: number): FormReader {
    const boundary = boundaryOf(request.headers.get("content-type") ?? "");
    const length = request.headers.get("content-length")?.trim() ?? "";
    const declared = /^\d{1,16}$/.test(length) ? Number(length) : null;
    const problem =
      boundary === null
        ? new UploadError("not_multipart")
        : declared !== null && declared > maxBytes
          ? new UploadError("too_large")
          : request.body === null
            ? new UploadError("ended")
            : null;
    return new FormReader(request.body?.getReader() ?? null, Buffer.from(`\r\n--${boundary ?? ""}`, "latin1"), maxBytes, declared, problem);
  }

  /** How much of the current part's body has been handed on. */
  get partBytes(): number {
    return this.delivered;
  }

  /** The next part, or null after the last one. Whatever is left of the current part is skipped. */
  next(): Promise<FormPart | null> {
    return this.serial(() => this.nextPart());
  }

  /** The current part's value as text (UTF-8), at most `max` bytes of it. */
  text(max: number): Promise<string> {
    return this.serial(async () => {
      const pieces: Buffer[] = [];
      let size = 0;
      for (let piece = await this.piece(); piece !== null; piece = await this.piece()) {
        size += piece.length;
        if (size > max) throw new UploadError("malformed");
        pieces.push(piece);
      }
      return Buffer.concat(pieces).toString("utf8");
    });
  }

  /** The current part's bytes as they arrive. The stream fails with an UploadError if the body ends before the part does. */
  file(): Readable {
    const pieces = async function* (form: FormReader): AsyncGenerator<Buffer> {
      for (;;) {
        const piece = await form.serial(() => form.piece());
        if (piece === null) return;
        yield piece;
      }
    };
    return Readable.from(pieces(this), { objectMode: false });
  }

  /**
   * Reads the rest of the body and keeps none of it, whatever is in it: a browser shows the
   * answer to an upload once it has sent all of it, and may not show one that comes sooner. Up
   * to twice `maxBytes` of body in all: a larger one isn't worth the wait (Node then closes the
   * connection). Never fails; after it, there are no more parts.
   */
  discard(): Promise<void> {
    return this.serial(async () => {
      this.state = "end";
      this.buffer = Buffer.alloc(0);
      const most = 2 * this.maxBytes;
      if (this.reader === null || this.broken?.problem === "ended" || (this.declared !== null && this.declared > most)) return;
      while (!this.ended && this.received <= most) {
        const next = await this.reader.read().catch(() => null);
        if (next === null) {
          this.broken = new UploadError("ended");
          return;
        }
        if (next.done) this.ended = true;
        else this.received += next.value.byteLength;
      }
    });
  }

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Reads the next chunk of the body into the buffer; false at its end. */
  private async more(): Promise<boolean> {
    if (this.broken) throw this.broken;
    if (this.ended || this.reader === null) return false;
    // The browser stopped sending (a cancelled upload, a lost connection): the stream fails.
    const next = await this.reader.read().catch(() => null);
    if (next === null) {
      this.broken = new UploadError("ended");
      throw this.broken;
    }
    if (next.done) {
      this.ended = true;
      return false;
    }
    this.received += next.value.byteLength;
    if (this.received > this.maxBytes) {
      this.broken = new UploadError("too_large");
      throw this.broken;
    }
    this.buffer = Buffer.concat([this.buffer, next.value]);
    return true;
  }

  private async nextPart(): Promise<FormPart | null> {
    if (this.broken) throw this.broken;
    while (this.state === "part") await this.piece();
    if (this.state === "end") return null;
    if (this.state === "start") {
      // Browsers send nothing before the first boundary; anything there is skipped.
      for (let at = this.buffer.indexOf(this.delimiter); ; at = this.buffer.indexOf(this.delimiter)) {
        if (at >= 0) {
          this.buffer = this.buffer.subarray(at + this.delimiter.length);
          break;
        }
        this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - (this.delimiter.length - 1)));
        if (!(await this.more())) throw new UploadError("ended");
      }
      this.state = "between";
    }
    // After a boundary: "--" ends the form. Otherwise the rest of its line, the part's headers and a blank line.
    while (this.buffer.length < 2) if (!(await this.more())) throw new UploadError("ended");
    if (this.buffer[0] === 0x2d && this.buffer[1] === 0x2d) {
      this.state = "end";
      return null;
    }
    let end = this.buffer.indexOf(BLANK_LINE);
    while (end < 0) {
      if (this.buffer.length > MAX_HEADERS) throw new UploadError("malformed");
      if (!(await this.more())) throw new UploadError("ended");
      end = this.buffer.indexOf(BLANK_LINE);
    }
    if (end > MAX_HEADERS) throw new UploadError("malformed");
    const [padding = "", ...lines] = this.buffer.subarray(0, end).toString("utf8").split("\r\n");
    this.buffer = this.buffer.subarray(end + BLANK_LINE.length);
    if (!/^[ \t]*$/.test(padding)) throw new UploadError("malformed");
    let disposition = "";
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon < 1) throw new UploadError("malformed");
      if (line.slice(0, colon).trim().toLowerCase() === "content-disposition") disposition = line.slice(colon + 1).trim();
    }
    const name = parameter(disposition, "name");
    if (!/^form-data\s*(;|$)/i.test(disposition) || name === null) throw new UploadError("malformed");
    this.state = "part";
    this.delivered = 0;
    return { name, filename: parameter(disposition, "filename") };
  }

  /** The current part's next bytes, or null at its end, when the boundary after it has been read too. */
  private async piece(): Promise<Buffer | null> {
    for (;;) {
      if (this.state !== "part") return null;
      const at = this.buffer.indexOf(this.delimiter);
      if (at >= 0) {
        const piece = this.buffer.subarray(0, at);
        this.buffer = this.buffer.subarray(at + this.delimiter.length);
        this.state = "between";
        this.delivered += piece.length;
        return piece.length > 0 ? piece : null;
      }
      // The boundary may start in the last few bytes: they wait for the next chunk.
      const safe = this.buffer.length - (this.delimiter.length - 1);
      if (safe > 0) {
        const piece = this.buffer.subarray(0, safe);
        this.buffer = this.buffer.subarray(safe);
        this.delivered += piece.length;
        return piece;
      }
      if (!(await this.more())) throw new UploadError("ended");
    }
  }
}
