package family.brooker.belay

import android.content.Intent
import android.os.ParcelFileDescriptor
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import family.brooker.belay.core.HandoverFrp
import family.brooker.belay.core.HandoverPlan
import family.brooker.belay.core.WireHandover
import family.brooker.belay.core.WirePolicy
import family.brooker.belay.store.AgentStore
import family.brooker.belay.ui.MainActivity
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Phase 11 on the phone: with a test policy that hands the phone over (DebugTools.policyOverride,
 * debug builds only), the step holds none of the hand-over's locks, records that a debug build left
 * reset protection alone (a release build clears it), and Home shows the hand-over with the
 * design's words, read from the screen's accessibility tree. The override is cleared afterwards
 * and a step puts the real policy back. Nothing here sets reset protection or the factory-reset
 * and debugging locks (CLAUDE.md, "Ask before"); a debug build refuses them anyway.
 */
@RunWith(AndroidJUnit4::class)
class HandoverInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val store = AgentStore.get(context)

    @After
    fun putBack() {
        DebugTools.policyOverride = null
        agentStep()
    }

    @Test
    fun theHandOverScreenAppearsForAHandOverPolicy() {
        // Connected before Belay's screen starts: Compose fills in its accessibility tree for a connected service.
        instrumentation.uiAutomation
        val real = store.policy() ?: WirePolicy(version = 0)
        assumeTrue("the server is handing this phone over already", real.handover == null)
        val at = System.currentTimeMillis()
        DebugTools.policyOverride = real.copy(version = real.version + VERSION_OFFSET, handover = WireHandover(at = at, by = "A made-up parent"))
        agentStep()
        val applied = store.applied()
        assertEquals(at, applied.handover?.at)
        assertEquals(HandoverFrp.SKIPPED_DEBUG, applied.handover?.frp)
        assertTrue("Belay still holds a hand-over lock: ${applied.locks}", applied.locks.none { it in HandoverPlan.LIFTS })
        assertNull("a debug build holds reset protection", applied.frpAccounts)

        shell("input keyevent KEYCODE_WAKEUP")
        shell("wm dismiss-keyguard")
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            awaitText(context.getString(R.string.handover_title))
            awaitText(context.getString(R.string.handover_intro))
            awaitText(context.getString(R.string.handover_started_by, "A made-up parent", "").substringBefore(" on "))
        } finally {
            activity.finish()
        }

        // Taken back: the record goes with it.
        DebugTools.policyOverride = null
        agentStep()
        assertNull("the hand-over's record stayed after the policy dropped it", store.applied().handover)
    }

    /** Waits up to 20 s for [text] in Belay's screen, and fails with what the screen shows instead. */
    private fun awaitText(text: String) {
        val deadline = System.currentTimeMillis() + 20_000
        var shown: List<String> = emptyList()
        while (System.currentTimeMillis() < deadline) {
            shown = screenTexts()
            if (shown.any { text in it }) return
            Thread.sleep(250)
        }
        fail("\"$text\" isn't on Belay's screen; it shows: ${shown.take(40)}")
    }

    /** Every text in the window in front, if it's Belay's (Compose's nodes are virtual children). */
    private fun screenTexts(): List<String> {
        val root = instrumentation.uiAutomation.rootInActiveWindow ?: return emptyList()
        if (root.packageName != context.packageName) return listOf("(${root.packageName} is in front)")
        val out = ArrayList<String>()
        val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            node.text?.let { out += it.toString() }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::addLast)
        }
        return out
    }

    private fun agentStep() {
        val done = CountDownLatch(1)
        Agent.handle(context, Trigger.APP_OPENED) { done.countDown() }
        assertTrue("the agent didn't finish a step", done.await(60, TimeUnit.SECONDS))
    }

    /** As the shell user; its standard output. */
    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
            .bufferedReader().use { it.readText() }

    private companion object {
        /** Test policies get versions of their own, well past the server's. */
        const val VERSION_OFFSET = 5_000_000
    }
}
