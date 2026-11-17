package family.brooker.belay.calls

import android.content.ContentValues
import android.content.Context
import android.provider.BlockedNumberContract
import android.util.Log
import family.brooker.belay.Agent
import family.brooker.belay.core.calls.PhoneNumbers

/**
 * Android's block list (BlockedNumberContract, docs/platform-notes.md T6): only the system, the
 * default dialer, the default SMS app and carrier apps may read or write it, and the platform then
 * blocks calls and texts from those numbers (and stops blocking for 2 hours after the kid contacts
 * emergency services). Belay writes it only as the default dialer, and only the entries it added
 * itself (core's CallsPlan.blockList); the kid's own entries are never touched.
 */
object BlockList {
    /** The numbers on the list, as Belay compares them; null when Belay can't read it (not the dialer). */
    fun read(context: Context): Set<String>? {
        if (!usable(context)) return null
        val projection = arrayOf(BlockedNumberContract.BlockedNumbers.COLUMN_ORIGINAL_NUMBER, BlockedNumberContract.BlockedNumbers.COLUMN_E164_NUMBER)
        return try {
            context.contentResolver.query(BlockedNumberContract.BlockedNumbers.CONTENT_URI, projection, null, null, null)?.use { c ->
                val out = HashSet<String>()
                while (c.moveToNext()) {
                    val key = PhoneNumbers.e164(c.getString(1)) ?: PhoneNumbers.key(c.getString(0))
                    if (key != null) out += key
                }
                out
            }
        } catch (e: RuntimeException) {
            Log.w(Agent.TAG, "calls: couldn't read the block list: ${e.javaClass.simpleName}")
            null
        }
    }

    /** Adds [number] (E.164). True when it's on the list afterwards. */
    fun add(context: Context, number: String): Boolean = try {
        val values = ContentValues().apply {
            put(BlockedNumberContract.BlockedNumbers.COLUMN_ORIGINAL_NUMBER, number)
            put(BlockedNumberContract.BlockedNumbers.COLUMN_E164_NUMBER, number)
        }
        context.contentResolver.insert(BlockedNumberContract.BlockedNumbers.CONTENT_URI, values) != null
    } catch (e: RuntimeException) {
        Log.w(Agent.TAG, "calls: couldn't add a number to the block list: ${e.javaClass.simpleName}")
        false
    }

    /** Takes [number] (E.164) off the list. True when it's off afterwards. */
    fun remove(context: Context, number: String): Boolean = try {
        BlockedNumberContract.unblock(context, number)
        true
    } catch (e: RuntimeException) {
        Log.w(Agent.TAG, "calls: couldn't take a number off the block list: ${e.javaClass.simpleName}")
        false
    }

    private fun usable(context: Context): Boolean = try {
        BlockedNumberContract.canCurrentUserBlockNumbers(context)
    } catch (e: RuntimeException) {
        false
    }
}
