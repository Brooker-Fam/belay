// The plan's phone over Tango (ya-webadb, MIT): adb's shell, install and reboot, in the browser
// over WebUSB (webusb.ts) or in Node through an adb server (server.ts).

import type { Adb } from "@yume-chan/adb";
import { PackageManager } from "@yume-chan/android-bin";
import { ReadableStream } from "@yume-chan/stream-extra";
import type { DeviceEntry, Phone, ShellResult } from "../plan/interpreter.js";

/** How to reach phones: list them, connect to one, and wait for one to come back. */
export interface Connector {
  devices(): Promise<DeviceEntry[]>;
  connect(serial: string): Promise<Adb>;
  /** Until the phone with this serial is connected again (after a restart). */
  waitFor(serial: string): Promise<void>;
}

const CHUNK = 64 * 1024;
/** How long a restarting phone may take to drop its connection. */
const GONE_WITHIN_MS = 60_000;

export class TangoPhone implements Phone {
  private adb: Adb | undefined;
  private serial = "";

  constructor(
    private readonly connector: Connector,
    /** The APK's bytes, by the name the plan has for it ({apk}). */
    private readonly readApk: (apk: string) => Promise<Uint8Array>,
  ) {}

  devices(): Promise<DeviceEntry[]> {
    return this.connector.devices();
  }

  async use(serial: string): Promise<void> {
    this.serial = serial;
    this.adb = await this.connector.connect(serial);
  }

  private connected(): Adb {
    if (this.adb === undefined) throw new Error("not connected to a phone yet");
    return this.adb;
  }

  /** `adb shell`: the words joined by spaces, as adb does, so the phone's shell reads quotes. */
  async shell(words: string[]): Promise<ShellResult> {
    const adb = this.connected();
    const shell = adb.subprocess.shellProtocol;
    if (shell?.isSupported === true) {
      const r = await shell.spawnWaitText(words);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    }
    // Without shell protocol v2 (Android 7 and older) there's no exit status, like adb's.
    return { stdout: await adb.subprocess.noneProtocol.spawnWaitText(words), stderr: "", exitCode: 0 };
  }

  /**
   * `adb install`: a streamed install, as adb does it (abb_exec "package install -S"), which
   * allowlists restricted permissions like a shell install (platform notes I4). The answer is
   * Android's: "Success", or "Failure [INSTALL_FAILED_...]".
   */
  async install(args: string[], apk: string): Promise<string> {
    let allowTest = false;
    let requestDowngrade = false;
    for (const arg of args) {
      if (arg === "-t") allowTest = true;
      else if (arg === "-d") requestDowngrade = true;
      else if (arg !== "-r") return `The setup kit can't install with ${arg}\n`; // -r is Tango's default
    }
    const bytes = await this.readApk(apk);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + CHUNK));
        offset += CHUNK;
      },
    });
    try {
      await new PackageManager(this.connected()).installStream(bytes.length, stream, { allowTest, requestDowngrade });
      return "Success\n";
    } catch (e) {
      return `${(e as Error).message}\n`;
    }
  }

  /**
   * `adb reboot`, then until the phone has really gone: waiting for it to come back any sooner
   * could find the old connection still there (the browser lists the old USB device for a
   * moment). The request itself may end with the connection.
   */
  async reboot(): Promise<void> {
    const adb = this.connected();
    this.adb = undefined;
    await adb.power.reboot().catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([adb.disconnected, new Promise((resolve) => (timer = setTimeout(resolve, GONE_WITHIN_MS)))]);
    clearTimeout(timer);
    await adb.close().catch(() => undefined);
  }

  async waitForDevice(): Promise<void> {
    await this.connector.waitFor(this.serial);
    this.adb = await this.connector.connect(this.serial);
  }

  /** Lets the connection go, at the end. */
  async close(): Promise<void> {
    const adb = this.adb;
    this.adb = undefined;
    await adb?.close().catch(() => undefined);
  }
}
