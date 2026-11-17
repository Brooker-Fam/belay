// A fake adb server on 127.0.0.1: enough of adb's host protocol (SERVICES.TXT in AOSP's
// packages/modules/adb) for Tango's AdbServerClient, answering for a fixture's fake phone. So the
// tests run the real Tango client, over TCP, with shell protocol v2, a streamed install and a
// restart, without a phone.

import { createServer, type Server, type Socket } from "node:net";
import type { FakePhone, Fixture } from "./fake-phone.js";

const FEATURES = "shell_v2,cmd,abb_exec,stat_v2,ls_v2";

class Reader {
  private buffer = Buffer.alloc(0);
  private ended = false;
  private wake: (() => void) | undefined;

  constructor(socket: Socket) {
    socket.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.wake?.();
    });
    const end = (): void => {
      this.ended = true;
      this.wake?.();
    };
    socket.on("end", end);
    socket.on("close", end);
    socket.on("error", end);
  }

  async read(length: number): Promise<Buffer | undefined> {
    while (this.buffer.length < length) {
      if (this.ended) return undefined;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return out;
  }
}

const hex4 = (n: number): string => n.toString(16).padStart(4, "0");
const okay = (socket: Socket, payload?: string): void => {
  socket.write(payload === undefined ? "OKAY" : `OKAY${hex4(Buffer.byteLength(payload))}${payload}`);
};
const fail = (socket: Socket, why: string): void => {
  socket.end(`FAIL${hex4(Buffer.byteLength(why))}${why}`);
};
function packet(id: number, data: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(id, 0);
  header.writeUInt32LE(data.length, 1);
  return Buffer.concat([header, data]);
}

/** What the phone itself answers to an install: adb's client adds the rest of what adb install prints. */
export function deviceInstallAnswer(adbInstallOutput: string): string {
  return adbInstallOutput
    .split("\n")
    .filter((line) => line !== "Performing Streamed Install")
    .map((line) => line.replace(/^adb: failed to install [^:]*: /, ""))
    .join("\n");
}

export class FakeAdbServer {
  private server: Server | undefined;
  private transportId = 1n;
  private disconnectWaiters: Socket[] = [];

  constructor(
    private readonly fixture: Fixture,
    private readonly devices: Fixture["devices"],
    private readonly phone: FakePhone,
  ) {}

  async start(): Promise<number> {
    const server = createServer((socket) => void this.serve(socket));
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return address.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.disconnectWaiters) socket.destroy();
    const server = this.server;
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  private list(): string {
    return (this.devices ?? []).map((d) => `${d.serial} ${d.state} product:sdk_gphone64 model:sdk_gphone64 device:emu64 transport_id:${this.transportId}\n`).join("");
  }

  private async serve(socket: Socket): Promise<void> {
    socket.on("error", () => undefined);
    const reader = new Reader(socket);
    let onDevice = false;
    for (;;) {
      const length = await reader.read(4);
      if (length === undefined) return;
      const request = (await reader.read(Number.parseInt(length.toString("latin1"), 16)))?.toString("latin1");
      if (request === undefined) return;
      let m: RegExpExecArray | null;
      if (!onDevice) {
        if (request === "host:version") {
          okay(socket, hex4(41));
          socket.end();
        } else if (request === "host:devices-l") {
          okay(socket, this.list());
          socket.end();
        } else if ((m = /^host:tport:serial:(.*)$/.exec(request)) !== null) {
          if (!(this.devices ?? []).some((d) => d.serial === m?.[1] && d.state === "device")) {
            fail(socket, `device '${m[1] ?? ""}' not found`);
            return;
          }
          okay(socket);
          const id = Buffer.alloc(8);
          id.writeBigUInt64LE(this.transportId);
          socket.write(id);
          onDevice = true;
          continue;
        } else if ((m = /^host:transport-id:(\d+)$/.exec(request)) !== null) {
          if (BigInt(m[1] ?? "0") !== this.transportId) {
            fail(socket, "no such transport");
            return;
          }
          okay(socket);
          onDevice = true;
          continue;
        } else if (/^host-serial:.*:wait-for-any-device$/.test(request)) {
          okay(socket);
          await this.phone.waitForDevice();
          okay(socket);
          socket.end();
        } else if (/^host-transport-id:\d+:wait-for-any-disconnect$/.test(request)) {
          okay(socket);
          this.disconnectWaiters.push(socket);
        } else {
          fail(socket, `unknown host service ${request}`);
        }
        return;
      }
      if (request === "host:features") {
        okay(socket, FEATURES);
        socket.end();
      } else if (request.startsWith("shell,v2,raw:")) {
        okay(socket);
        const r = await this.phone.shell(request.slice("shell,v2,raw:".length).split(" "));
        const parts = [];
        if (r.stdout !== "") parts.push(packet(1, Buffer.from(r.stdout)));
        if (r.stderr !== "") parts.push(packet(2, Buffer.from(r.stderr)));
        parts.push(packet(3, Buffer.from([r.exitCode & 0xff])));
        socket.end(Buffer.concat(parts));
      } else if (request.startsWith("abb_exec:")) {
        // abb_exec:package\0install\0<options>\0-S\0<size>\0, then the APK.
        const words = request.slice("abb_exec:".length).split("\0").filter((w) => w !== "");
        const size = Number.parseInt(words[words.indexOf("-S") + 1] ?? "0", 10);
        okay(socket);
        await reader.read(size);
        const args = words.slice(2).filter((w, i, all) => w !== "-S" && all[i - 1] !== "-S");
        socket.end(deviceInstallAnswer(await this.phone.install(args, "{apk}")));
      } else if (request === "reboot:") {
        okay(socket);
        await this.phone.reboot();
        this.transportId++;
        for (const waiter of this.disconnectWaiters.splice(0)) waiter.end("OKAY");
        socket.end();
      } else {
        fail(socket, `unknown device service ${request} (${this.fixture.name})`);
      }
      return;
    }
  }
}
