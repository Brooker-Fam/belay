/** Belay itself on a phone's page: updating it, and its recovery key (Phase 6). */
import type { FC } from "hono/jsx";
import { type AgentFile, versionWords } from "../../family/agent.js";
import type { DeviceView, UpdateView } from "../../family/devices.js";
import type { Rules } from "../../family/policy.js";
import { type RecoveryState, usableKey } from "../../family/recovery.js";
import { formatDate } from "../../time.js";
import { Csrf, Layout, Notice, PostButton, Time, type View } from "../ui.js";

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
      <a href={`/devices/${device.id}#hardening`}>Back to {device.name}</a>
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
          The recovery key was used on the phone, <Time ms={recovery.lastUse.usedAt} tz={view.tz} /> by its clock, opening repair access until{" "}
          <Time ms={recovery.lastUse.until} tz={view.tz} />. It won't work again: make a new one.
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
          An earlier key was used <Time ms={recovery.lastUse.usedAt} tz={view.tz} />.
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
      {update.doneAt !== null ? (
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

export const UpdateCard: FC<{ view: View; device: DeviceView; files: AgentFile[] }> = ({ view, device, files }) => {
  const f = device.facts;
  const running = f?.agent_version_code ?? null;
  return (
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
        <p class="muted small">To update Belay without a computer, add its APK to this server with the agent-add command (docs/server.md), then offer it here.</p>
      )}
      {device.signing.pinned !== null && (
        <p class="muted small">
          Belay's signing certificate (SHA-256) <code>{device.signing.pinned.slice(0, 16)}…</code>, since <Time ms={device.signing.pinnedAt ?? device.enrolledAt} tz={view.tz} />.
          {device.signing.changed && device.signing.reported !== null && (
            <>
              {" "}
              <strong>
                The phone now reports another one, <code>{device.signing.reported.slice(0, 16)}…</code>.
              </strong>
            </>
          )}
        </p>
      )}
    </div>
  );
};
