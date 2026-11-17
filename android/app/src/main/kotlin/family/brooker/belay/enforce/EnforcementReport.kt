package family.brooker.belay.enforce

import family.brooker.belay.BuildConfig
import family.brooker.belay.core.AgentUpdates
import family.brooker.belay.core.Applied
import family.brooker.belay.core.Enforcement
import family.brooker.belay.core.WireEnforcement
import family.brooker.belay.store.AgentStore

/**
 * The enforcement report the server sees (docs/protocol.md, "Enforcement"), from what each part
 * of Belay keeps: what the agent step applied (with the packages never blocked and the
 * policy's offered update), the update thread's record, the recovery key's last use, the
 * commands' last results, (Phase 4) location's status, (Phase 5) whether Belay is the dialer and
 * (Phase 3) whether Android logs network lookups, as the last step saw them. DeviceStatus
 * sends it; the agent step compares it with the last one, so any change reaches the parent page
 * within seconds.
 */
object EnforcementReport {
    /** [running]: the version code this Belay runs. */
    fun of(store: AgentStore, applied: Applied = store.applied(), running: Long = BuildConfig.VERSION_CODE.toLong()): WireEnforcement? =
        Enforcement.report(
            applied,
            agentUpdate = AgentUpdates.report(applied.agentUpdate, store.agentUpdate(), running),
            recovery = store.recovery().lastUse,
            commands = store.commandLog().results,
            location = store.locationState()?.report,
            calls = store.callsState()?.report,
            networkLog = store.networkState()?.report,
        )
}
