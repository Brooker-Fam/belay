/**
 * A phone's family agreement: the sections the family writes together, in versions. The parents
 * agree as they save a version; the kid reads it on the phone and answers "I agree" or "I want
 * to talk about it". A new version asks the kid again.
 */
import type { FC } from "hono/jsx";
import type { DeviceView } from "../../family/devices.js";
import { AGREEMENT_LIMITS, type AgreementView } from "../../family/screentime/agreement.js";
import { Csrf, Layout, Notice, Time, type View } from "../ui.js";
import { PhoneTabs } from "./screentime.js";

const KidAnswer: FC<{ view: View; a: AgreementView }> = ({ view, a }) =>
  a.kidAnswer === "agree" && a.kidAnsweredAt !== null ? (
    <span class="status ok">
      The kid agreed <Time ms={a.kidAnsweredAt} tz={view.tz} />
    </span>
  ) : a.kidAnswer === "talk" && a.kidAnsweredAt !== null ? (
    <span class="status attention">
      The kid wants to talk about it (<Time ms={a.kidAnsweredAt} tz={view.tz} />): see Requests
    </span>
  ) : (
    <span class="muted">The kid hasn't answered yet.</span>
  );

export const AgreementPage: FC<{ view: View; device: DeviceView; versions: AgreementView[]; message?: string; error?: string }> = ({
  view,
  device,
  versions,
  message,
  error,
}) => {
  const [current] = versions;
  const blanks = Math.max(1, Math.min(3, AGREEMENT_LIMITS.sections - (current?.sections.length ?? 0)));
  const sections = [...(current?.sections ?? []), ...Array.from({ length: blanks }, () => ({ title: "", text: "" }))];
  return (
    <Layout view={view} title={`${device.name}: agreement`}>
      <h1>{device.name}</h1>
      <PhoneTabs view={view} device={device} current="agreement" />
      {message && <Notice>{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      <p class="muted">
        The family agreement, in your own words, written together. The phone shows it in full; the kid answers "I agree" or "I want to talk about it",
        and a new version asks them again.
      </p>
      {current ? (
        <div class="card">
          <div class="row spread">
            <strong>Version {current.version}</strong>
            <KidAnswer view={view} a={current} />
          </div>
          <p class="small muted">
            Written <Time ms={current.createdAt} tz={view.tz} />
            {current.createdBy && ` by ${current.createdBy}`}; the parents agreed as it was saved.
          </p>
          {current.sections.map((s) => (
            <>
              <h3>{s.title}</h3>
              <blockquote>{s.text}</blockquote>
            </>
          ))}
        </div>
      ) : (
        <p class="muted">No agreement yet.</p>
      )}
      <h2>{current ? "Write a new version" : "Write the agreement"}</h2>
      <form class="card stack" method="post" action={`/devices/${device.id}/agreement`}>
        <Csrf view={view} />
        <p class="muted small">
          At most {AGREEMENT_LIMITS.sections} sections of {AGREEMENT_LIMITS.text} characters. Leave a section empty to drop it. Saving asks the kid again.
        </p>
        {sections.map((s, i) => (
          <fieldset>
            <legend>Section {i + 1}</legend>
            <label for={`title-${i}`}>Title</label>
            <input id={`title-${i}`} type="text" name="title" maxlength={AGREEMENT_LIMITS.title} value={s.title} />
            <label for={`text-${i}`}>Text</label>
            <textarea id={`text-${i}`} name="text" maxlength={AGREEMENT_LIMITS.text}>
              {s.text}
            </textarea>
          </fieldset>
        ))}
        <p>
          <button type="submit">Save{current ? " the new version" : ""}</button>
        </p>
      </form>
      {versions.length > 1 && (
        <>
          <h2>Earlier versions</h2>
          <div class="card">
            {versions.slice(1).map((a) => (
              <details>
                <summary>
                  Version {a.version}, <Time ms={a.createdAt} tz={view.tz} />
                </summary>
                <p class="small">
                  <KidAnswer view={view} a={a} />
                </p>
                {a.sections.map((s) => (
                  <>
                    <h3>{s.title}</h3>
                    <blockquote>{s.text}</blockquote>
                  </>
                ))}
              </details>
            ))}
          </div>
        </>
      )}
    </Layout>
  );
};
