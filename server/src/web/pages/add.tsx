import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import type { PendingCode } from "../../device/enroll.js";
import { formatDuration, formatTime } from "../../time.js";
import { Csrf, Layout, Notice, PostButton, type View } from "../ui.js";

const DOCS = "https://github.com/brooker-fam/belay/blob/main/docs";

export const AddPage: FC<{ view: View; pending: PendingCode[]; error?: string }> = ({ view, pending, error }) => (
  <Layout view={view} title="Add a phone">
    <h1>Add a phone</h1>
    <p>
      Belay manages a phone as its <em>device owner</em>, which Android only allows on a phone with no accounts on it. Setting it up takes a computer
      with a USB cable and about 20 minutes. The full steps for a Pixel are in <a href={`${DOCS}/pixel.md`}>docs/pixel.md</a>.
    </p>
    <ol class="steps">
      <li>
        <strong>Factory reset the phone</strong> (Settings → System → Reset options → Erase all data). This deletes everything on it.
      </li>
      <li>
        <strong>Set it up without a Google account</strong>: connect to Wi-Fi and skip signing in. You add the parent-owned Google account after Belay
        is set up.
      </li>
      <li>
        <strong>Turn on USB debugging</strong>: Settings → About phone → tap Build number seven times, then Settings → System → Developer options →
        USB debugging. Connect the phone to your computer and allow it.
      </li>
      <li>
        <strong>Make an enrollment code below</strong>, then run <code>provision.sh</code> from the Belay repository on your computer with the server
        and code it shows. It installs Belay, makes it the device owner and connects it to this server.
      </li>
    </ol>
    {error && <Notice kind="error">{error}</Notice>}
    <form class="stack card" method="post" action="/add">
      <Csrf view={view} />
      <label for="name">What do you call this phone?</label>
      <input id="name" type="text" name="name" maxlength={60} required placeholder="Sam's phone" />
      <div>
        <button type="submit">Make an enrollment code</button>
      </div>
      <p class="muted small">The code works once and expires in 30 minutes.</p>
    </form>
    {pending.length > 0 && (
      <>
        <h2>Waiting to enroll</h2>
        {pending.map((p) => (
          <div class="card row spread">
            <span>
              {p.deviceName}: expires in {formatDuration(p.expiresAt - view.now)}
            </span>
            <PostButton view={view} action="/add/cancel" kind="quiet" fields={{ code: p.codeHash }}>
              Cancel
            </PostButton>
          </div>
        ))}
      </>
    )}
  </Layout>
);

export const CodePage: FC<{
  view: View;
  deviceName: string;
  code: string;
  display: string;
  expiresAt: number;
  server: string;
  link: string;
  qrSvg: string;
  reconnect: boolean;
}> = ({ view, deviceName, code, display, expiresAt, server, link, qrSvg, reconnect }) => (
  <Layout view={view} title="Enrollment code">
    <h1>
      {reconnect ? "Reconnect" : "Enroll"} {deviceName}
    </h1>
    <Notice>
      This code works once, until {formatTime(expiresAt, view.tz)}. It's shown only on this page: if you leave, make a new one.
    </Notice>
    <div class="card">
      <p class="code" id="code">
        {display}
      </p>
      <p class="muted small">Server: {server}</p>
    </div>
    <h2>With a computer (recommended)</h2>
    <p>From the Belay repository, with the phone connected over USB:</p>
    <pre id="command">{`cd android\nscripts/provision.sh --server ${server} --code ${code}`}</pre>
    <p>
      <button type="button" class="quiet" data-copy="command" hidden>
        Copy
      </button>
    </p>
    <h2>On the phone</h2>
    <p>If Belay is already on the phone, open it, tap Connect, and scan this QR code (or type the server and the code).</p>
    <div class="qr" role="img" aria-label="QR code with the server address and the enrollment code">
      {raw(qrSvg)}
    </div>
    <p class="pkg">{link}</p>
    <p>
      <a href="/">Back to phones</a>
    </p>
  </Layout>
);
