package family.brooker.belay.core

import kotlinx.serialization.Serializable

@Serializable
enum class ChangeKind { INSTALLED, UPDATED, REMOVED, REINSTALLED }

/**
 * Which layer of change detection noticed a change. The layers overlap on purpose,
 * so a missed broadcast never means a missed install:
 * 1. [BROADCAST]: a package broadcast reached a receiver while the agent was running.
 * 2. [CHANGED_PACKAGES]: PackageManager.getChangedPackages listed it on a later wake.
 * 3. [SNAPSHOT]: a full inventory scan (after a boot, daily) differed from the last one.
 */
@Serializable
enum class Detection { BROADCAST, CHANGED_PACKAGES, SNAPSHOT }

/** One app change, written to the log (and, from Phase 1, the outbox) as soon as it is found. */
@Serializable
data class AppChange(
    /** Client-generated UUID: the server de-duplicates on it. */
    val id: String,
    val kind: ChangeKind,
    val packageName: String,
    /** Untrusted text from the app's developer. */
    val label: String,
    val from: VersionRef? = null,
    val to: VersionRef? = null,
    /** When it happened, from the package's own install/update time, where Android keeps one. */
    val happenedAt: Long? = null,
    val detectedAt: Long,
    val detection: Detection,
)

object InventoryDiff {
    /**
     * Compares what the agent knew ([previous]) with what is installed now ([current]),
     * for the packages in [scope], or for every package when [scope] is null. For a scoped
     * diff, [current] only needs the packages of [scope] that are still installed.
     *
     * Pure and deterministic: the same inputs give the same changes, ordered by package.
     */
    fun diff(
        previous: Map<String, PackageRecord>,
        current: Map<String, PackageRecord>,
        scope: Set<String>?,
        detectedAt: Long,
        detection: (String) -> Detection,
        newId: () -> String,
    ): List<AppChange> {
        val names = (scope ?: (previous.keys + current.keys)).sorted()
        return names.mapNotNull { name ->
            val before = previous[name]
            val now = current[name]
            when {
                before == null && now == null -> null
                before == null && now != null -> AppChange(
                    id = newId(), kind = ChangeKind.INSTALLED, packageName = name, label = now.label,
                    to = now.version, happenedAt = now.firstInstallTime,
                    detectedAt = detectedAt, detection = detection(name),
                )
                before != null && now == null -> AppChange(
                    id = newId(), kind = ChangeKind.REMOVED, packageName = name, label = before.label,
                    from = before.version, happenedAt = null,
                    detectedAt = detectedAt, detection = detection(name),
                )
                before != null && now != null && now.firstInstallTime != before.firstInstallTime -> AppChange(
                    id = newId(), kind = ChangeKind.REINSTALLED, packageName = name, label = now.label,
                    from = before.version, to = now.version, happenedAt = now.firstInstallTime,
                    detectedAt = detectedAt, detection = detection(name),
                )
                before != null && now != null &&
                    (now.versionCode != before.versionCode || now.lastUpdateTime != before.lastUpdateTime) -> AppChange(
                    id = newId(), kind = ChangeKind.UPDATED, packageName = name, label = now.label,
                    from = before.version, to = now.version, happenedAt = now.lastUpdateTime,
                    detectedAt = detectedAt, detection = detection(name),
                )
                else -> null
            }
        }
    }

    /** [previous] with the packages of [scope] (or all, when null) replaced by what [current] says. */
    fun merge(
        previous: Map<String, PackageRecord>,
        current: Map<String, PackageRecord>,
        scope: Set<String>?,
    ): Map<String, PackageRecord> {
        if (scope == null) return current
        val merged = previous.toMutableMap()
        for (name in scope) {
            val now = current[name]
            if (now == null) merged.remove(name) else merged[name] = now
        }
        return merged
    }
}
