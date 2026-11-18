/** Belay itself on a phone's page: updating it, its recovery key (Phase 6), and other users (Phase 10). */
import type { FC } from "hono/jsx";
import { LIMITS } from "../../device/schemas.js";
import { type AgentFile, versionWords } from "../../family/agent.js";
import type { Command } from "../../family/commands.js";
import type { DeviceView, UpdateView } from "../../family/devices.js";
import type { Rules } from "../../family/policy.js";
import { type RecoveryState, usableKey } from "../../family/recovery.js";
import { formatBytes } from "../../ops/backups.js";
import { formatDate } from "../../time.js";
import { Csrf, Layout, Notice, PostButton, Time, type View } from "../ui.js";

/** What happened to a command, in words. */
const CommandLine: FC<{ view: View; command: Command }> = ({ view, command }) => {
  switch (command.state) {
    case "waiting":
      return (
        <p class="small">
          Sent <Time ms={command.issuedAt} tz={view.tz} />: waiting for the phone
          {command.expiresAt !== null && (
            <>
              , until <Time ms={command.expiresAt} tz={view.tz} />
            </>
          )}
          .
        </p>
      );
    case "done":
      return (
        <p class="small">
          <span class="status ok">Done</span>
          {command.resultAt !== null && (
            <>
              {" "}
              <Time ms={command.resultAt} tz={view.tz} />
            </>
          )}
          : the phone removed every other user and profile.
        </p>
      );
    case "failed":
      return (
        <>
          <p class="small">The phone couldn't do it{command.resultAt !== null && <> (<Time ms={command.resultAt} tz={view.tz} />)</>}. Belay on the phone says:</p>
          <blockquote>{command.problem ?? "nothing more"}</blockquote>
        </>
      );
    case "expired":
      return <p class="small">Not done: the phone got it after it expired, so it didn't run it.</p>;
    case "not_done":
      return <p class="small">Not done: the phone didn't get it within 7 days.</p>;
    case "replaced":
      return null;
  }
};

/**
 * Phase 10: another user or profile on the phone (health.other_users), and the parent's way to
 * remove them, with the last such command's result.
 */
export const OtherUsersCard: FC<{ view: View; device: DeviceView; commands: Command[] }> = ({ view, device, commands }) => {
  const others = device.facts?.health.other_users ?? 0;
  const latest = commands.find((c) => c.state !== "replaced");
  if (others === 0 && !latest) return null;
  const button =
    others > 0 && latest?.state !== "waiting" ? (
      <>
        <p class="small">
          Belay can remove every other user and profile from the phone, with everything in them, Android's own Parental Controls included; Belay keeps
          doing that job. The phone does it when it gets this, if that's within 7 days.
        </p>
        <PostButton
          view={view}
          action={`/devices/${device.id}/remove-other-users`}
          kind="danger"
          confirm={`Remove every other user and profile from ${device.name}? Everything in them is deleted.`}
        >
          Remove other users and profiles
        </PostButton>
      </>
    ) : null;
  return others > 0 ? (
    <Notice kind="error" standing>
      <p id="users">
        <strong>{others === 1 ? "Another user or profile is on this phone." : `${others} other users or profiles are on this phone.`}</strong> This usually
        means Android's own Parental Controls were set up in Settings.
      </p>
      {latest && <CommandLine view={view} command={latest} />}
      {button}
    </Notice>
  ) : (
    <div class="card" id="users">
      <p>
        <strong>Other users and profiles:</strong> none now.
      </p>
      {latest && <CommandLine view={view} command={latest} />}
    </div>
  );
};

/** The recovery key, shown once: when a lock that can strand the phone was turned on, or a parent asked for a new one. */
export const RecoveryKeyPage: FC<{ view: View; device: DeviceView; grouped: string; replaced: boolean; because: "hardening" | "asked" }> = ({
  view,
  device,
  grouped,
  replaced,
  because,
}) => (
  <Layout view={view} title="Recovery key">
    <h1>Recovery key for {device.name}</h1>
    {because === "hardening" && <Notice>Saved. Locking that can strand the phone, so here's its recovery key.</Notice>}
    <Notice kind="warn">It's shown only now. Print it, or keep it in a password manager.</Notice>
    <pre id="secret" class="code">
      {grouped}
    </pre>
    <p>
      <button type="button" class="quiet" data-copy="secret" hidden>
        Copy
      </button>
    </p>
    <p>
      If this server is ever lost, typing this key in Belay on the phone (About Belay, then Recovery) lifts the factory reset and debugging locks for
      24 hours, without the server, so the phone can be repaired. It works once; then make a new one on the phone's page.
    </p>
    <p class="muted">
      The phone gets only a check of this key, never the key, within seconds if it's online.
      {replaced && " The earlier key stops working once the phone has this one."} Belay keeps only the check too.
    </p>
    <p>
      <a class="go" href={`/devices/${device.id}#hardening`}>
        Back to {device.name}
      </a>
    </p>
  </Layout>
);

/** Whether the phone has a recovery key, when it was last used, and the button for a new one. */
export const RecoveryCard: FC<{ view: View; device: DeviceView; rules: Rules; recovery: RecoveryState }> = ({ view, device, rules, recovery }) => {
  const locked = rules.restrictions.factory_reset || rules.restrictions.debugging;
  const used = recovery.current?.usedAt != null;
  return (
    <div class="card">
      <p>
        <strong>Recovery key.</strong> If this server is ever lost, the recovery key typed on the phone lifts the factory reset and debugging locks for
        24 hours, with no server, so the phone can be repaired. It works once.
      </p>
      {used && recovery.lastUse && recovery.lastUse.version === recovery.current?.version ? (
        <Notice kind="warn">
          The phone reports the recovery key was used on it, <Time ms={recovery.lastUse.usedAt} tz={view.tz} /> by its clock, opening repair access until{" "}
          <Time ms={recovery.lastUse.until} tz={view.tz} />. It won't work again: make a new one. If no one in the family used it, the phone may not be in
          the family's hands.
        </Notice>
      ) : usableKey(recovery) && recovery.current ? (
        <p class="small">
          This phone has one, made <Time ms={recovery.current.createdAt} tz={view.tz} />
          {recovery.current.createdBy ? ` by ${recovery.current.createdBy}` : " with the server's admin command"}. Keep it printed or in a password manager.
        </p>
      ) : locked ? (
        <Notice kind="warn">There's no recovery key for this phone yet. Make one now: it's how the phone can be repaired if this server is lost.</Notice>
      ) : (
        <p class="muted small">Turning on a lock above makes one for this phone. You can make one now too.</p>
      )}
      {recovery.lastUse && recovery.lastUse.version !== recovery.current?.version && (
        <p class="muted small">
          The phone reported an earlier key used <Time ms={recovery.lastUse.usedAt} tz={view.tz} />.
        </p>
      )}
      <PostButton
        view={view}
        action={`/devices/${device.id}/recovery-key`}
        kind="quiet"
        confirm={usableKey(recovery) ? `Make a new recovery key for ${device.name}? The old one stops working.` : undefined}
      >
        Make a new recovery key
      </PostButton>
    </div>
  );
};

const STATE_WORDS: Record<NonNullable<UpdateView["state"]>, string> = {
  downloading: "The phone is downloading it.",
  checking: "The phone is checking it.",
  installing: "The phone is installing it.",
  failed: "The phone couldn't install it.",
  done: "The phone installed it.",
};

/** The update offered to the phone, and how it's going, as the phone says. */
const OfferState: FC<{ view: View; device: DeviceView; update: UpdateView }> = ({ view, device, update }) => {
  const running = device.facts?.agent_version_code ?? null;
  const failed = update.state === "failed" && update.doneAt === null;
  return (
    <div class="stack">
      <p>
        <strong>Offered: Belay {update.words}</strong>, <Time ms={update.offeredAt} tz={view.tz} />.
      </p>
      {update.doneAt !== null && running !== null && running < update.versionCode ? (
        <p>
          The phone ran it from <Time ms={update.doneAt} tz={view.tz} />, but runs version {running} now: an older one was put back, over adb.
          {update.state === "failed" && " Belay on the phone won't install this one again by itself."}
        </p>
      ) : update.doneAt !== null ? (
        <p>
          <span class="status ok">The phone runs it, or a newer version,</span> since <Time ms={update.doneAt} tz={view.tz} />.
        </p>
      ) : running !== null && running >= update.versionCode ? (
        <Notice kind="warn">
          The phone runs version {running}, which isn't older, so it won't install this one: Android doesn't install an older version over a newer
          one.
        </Notice>
      ) : (
        <p>
          {update.state ? STATE_WORDS[update.state] : "The phone hasn't started on it yet: it gets it with its next rules."}
          {update.stateAt !== null && (
            <span class="small muted">
              {" "}
              (<Time ms={update.stateAt} tz={view.tz} />)
            </span>
          )}
        </p>
      )}
      {failed && update.problem && (
        <>
          <p class="small muted">Belay on the phone says:</p>
          <blockquote>{update.problem}</blockquote>
        </>
      )}
      {failed && <p class="small">It can still be updated from a computer: turn on maintenance mode, then install it over adb.</p>}
      {update.doneAt === null && (
        <div>
          <PostButton view={view} action={`/devices/${device.id}/update/withdraw`} kind="quiet">
            Stop offering it
          </PostButton>
        </div>
      )}
    </div>
  );
};

/** What the phone checks in an update before installing it (docs/protocol.md, "Updates"), for the pages that add and offer one. */
const PHONE_CHECKS =
  "Before it installs anything, Belay on the phone checks the file itself: that it's Belay, that its version code is the one given here and higher than the phone's, and that it's signed with the same key as the Belay on the phone. It refuses anything else.";

/** What the server does with an APK, which is less than the phone does. */
const SERVER_KEEPS = "The server keeps the file as it is: it only checks that it starts like an APK.";

/**
 * "Add a version of Belay": the APK a parent built with the setup kit or build-release.sh, to
 * offer next. The CSRF token comes first and the file last: the browser sends them in this order,
 * and the server checks the token before it reads the file (web/upload.ts).
 */
const AddVersionForm: FC<{ view: View; device: DeviceView; running: number | null }> = ({ view, device, running }) => (
  <form class="stack card" method="post" action={`/devices/${device.id}/update/add`} enctype="multipart/form-data" id="update-add">
    <Csrf view={view} />
    <h3>Add a version of Belay</h3>
    <p class="small">
      Built a newer Belay with your family's key, with the setup kit or <code>build-release.sh</code>? Add its APK file to this server here, then
      offer it to the phone.
    </p>
    <label for="update-add-code">Version code</label>
    <input id="update-add-code" type="text" name="version_code" inputmode="numeric" pattern="[0-9]{1,10}" maxlength={10} required autocomplete="off" />
    <p class="muted small">
      A whole number, like 7. The setup kit and <code>build-release.sh</code> print it when they build Belay, and the kit's copy of the file has it
      in its name. The phone refuses a file whose version code isn't this one.
      {running !== null && ` The phone runs version code ${running} now, and only installs a higher one.`}
    </p>
    <label for="update-add-name">Version name (optional)</label>
    <input
      id="update-add-name"
      type="text"
      name="version_name"
      maxlength={50}
      pattern="[0-9A-Za-z][0-9A-Za-z.+_\-]{0,49}"
      title="Letters, digits and . + _ -, like 0.6.0"
      placeholder="0.6.0"
      autocomplete="off"
      autocapitalize="off"
      spellcheck={false}
    />
    <label for="update-add-apk">The APK file</label>
    <input id="update-add-apk" type="file" name="apk" accept=".apk" required />
    <p class="muted small">
      At most {LIMITS.maxAgentBytes / 1024 / 1024} MB. The setup kit keeps each one it builds in your key folder, like <code>~/.config/belay</code>{" "}
      (on a Mac, press Cmd+Shift+G in the file chooser to type that folder).
    </p>
    <p class="muted small">
      {SERVER_KEEPS} {PHONE_CHECKS}
    </p>
    <div>
      <button type="submit">Add this version</button>
    </div>
  </form>
);

export const UpdateCard: FC<{ view: View; device: DeviceView; files: AgentFile[] }> = ({ view, device, files }) => {
  const f = device.facts;
  const running = f?.agent_version_code ?? null;
  return (
    <>
      <div class="card">
        <p>
          {f ? (
            <>
              Belay on the phone is version {f.agent_version_name} (version code {f.agent_version_code}).
            </>
          ) : (
            "Belay on the phone hasn't said which version it runs yet."
          )}
        </p>
        {device.update && <OfferState view={view} device={device} update={device.update} />}
        {files.length > 0 ? (
          <form class="stack" method="post" action={`/devices/${device.id}/update`}>
            <Csrf view={view} />
            <label for="update-version">Offer a version of Belay to this phone</label>
            <select id="update-version" name="sha256">
              {files.map((file) => (
                <option value={file.sha256}>
                  Belay {versionWords(file)}, added {formatDate(file.addedAt, view.tz)}
                  {running !== null && file.versionCode <= running ? " (not newer than the phone's)" : ""}
                </option>
              ))}
            </select>
            <p class="muted small">
              Before installing it, Belay on the phone checks that the file is Belay, signed with the same key, and newer than the version it runs.
              Android doesn't install an older version over a newer one, so a version with a problem is fixed with a newer one.
            </p>
            <div>
              <button type="submit">Offer this version</button>
            </div>
          </form>
        ) : (
          <p class="muted small">
            There's no version of Belay on this server yet.{device.revokedAt === null && " Add the one you built below, then offer it here."}
          </p>
        )}
        {device.signing.pinned !== null && (
          <p class="muted small">
            Belay's signing certificate (SHA-256, as <code>apksigner verify --print-certs</code> shows it): <code class="digest">{device.signing.pinned}</code>, since{" "}
            <Time ms={device.signing.pinnedAt ?? device.enrolledAt} tz={view.tz} />.
            {device.signing.changed && device.signing.reported !== null && (
              <>
                {" "}
                <strong>
                  The phone now reports another one: <code class="digest">{device.signing.reported}</code>.
                </strong>
              </>
            )}
          </p>
        )}
      </div>
      {device.revokedAt === null && <AddVersionForm view={view} device={device} running={running} />}
    </>
  );
};

/**
 * A version of Belay on the server, seen from a phone's page: after "Add a version of Belay", its
 * SHA-256 and version, and the button to offer it to that phone.
 */
export const VersionPage: FC<{ view: View; device: DeviceView; file: AgentFile; message?: string | undefined }> = ({ view, device, file, message }) => {
  const running = device.facts?.agent_version_code ?? null;
  return (
    <Layout view={view} title={`Belay ${versionWords(file)}`}>
      <p class="small">
        <a href={`/devices/${device.id}#update`}>← {device.name}</a>
      </p>
      <h1>Belay {versionWords(file)} is on the server</h1>
      {message && <Notice>{message}</Notice>}
      <div class="card">
        <dl class="facts">
          <dt>Version code</dt>
          <dd>{file.versionCode}</dd>
          {file.versionName && (
            <>
              <dt>Version name</dt>
              <dd>{file.versionName}</dd>
            </>
          )}
          <dt>The file's SHA-256</dt>
          <dd>
            <code class="digest">{file.sha256}</code>
          </dd>
          <dt>Size</dt>
          <dd>{formatBytes(file.size)}</dd>
          <dt>Added</dt>
          <dd>
            <Time ms={file.addedAt} tz={view.tz} />
          </dd>
        </dl>
        <p class="muted small">
          That SHA-256 is the file's own, the one the setup kit and <code>build-release.sh</code> print as the file's SHA-256: it isn't the
          certificate's.
        </p>
      </div>
      <p>
        {SERVER_KEEPS} {PHONE_CHECKS}
      </p>
      {running !== null && running >= file.versionCode && (
        <Notice kind="warn">
          {device.name} runs version code {running}, which isn't older, so it won't install this one: Android doesn't install an older version over a
          newer one.
        </Notice>
      )}
      {device.revokedAt === null ? (
        <p>
          <PostButton view={view} action={`/devices/${device.id}/update`} fields={{ sha256: file.sha256 }}>
            Offer it to {device.name}
          </PostButton>
        </p>
      ) : (
        <p>{device.name} is disconnected, so it can't be updated.</p>
      )}
      <p class="muted small">Each phone's page can offer it too, under Updating Belay.</p>
    </Layout>
  );
};
