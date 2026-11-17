package family.brooker.belay.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RecoveryKeyTest {
    // Shared with the server's recovery test: the same salt and key give the same hash there.
    private val key = "7KD2M8Q4ZX1HNP3RT6VWB9CF0G"
    private val check = WireRecovery(
        version = 1,
        salt = "000102030405060708090a0b0c0d0e0f",
        hash = "de01d867f9fc4097eae169b9abdf2b2b8092afa3f3e80f38c6fdc08f283a83a1",
    )

    @Test
    fun theSharedTestVector() {
        assertEquals(check.hash, RecoveryKey.hash(check.salt, key))
        assertTrue(RecoveryKey.matches(check, key))
    }

    @Test
    fun typingIsForgiving() {
        assertTrue(RecoveryKey.matches(check, "7kd2m-8q4zx-1hnp3-rt6vw-b9cf0g"))
        assertTrue(RecoveryKey.matches(check, " 7KD2M 8Q4ZX\t1HNP3 RT6VW B9CFOG "), "O reads as 0")
        assertTrue(RecoveryKey.matches(check, "7KD2M8Q4ZXIHNP3RT6VWB9CF0G"), "I reads as 1")
        assertTrue(RecoveryKey.matches(check, "7KD2M8Q4ZXlHNP3RT6VWB9CF0G"), "l reads as 1")
    }

    @Test
    fun anythingElseIsNotTheKey() {
        assertFalse(RecoveryKey.matches(check, key.dropLast(1)))
        assertFalse(RecoveryKey.matches(check, key + "0"))
        assertFalse(RecoveryKey.matches(check, key.replaceFirst('7', '8')))
        assertNull(RecoveryKey.normalize("7KD2M8Q4ZX1HNP3RT6VWB9CF0U"), "U isn't in Crockford's alphabet")
        assertNull(RecoveryKey.normalize(""))
        assertFalse(RecoveryKey.matches(check.copy(salt = "not hex"), key))
        assertFalse(RecoveryKey.matches(check.copy(hash = check.hash.drop(2)), key))
    }

    @Test
    fun keysAreShownInGroups() {
        assertEquals("7KD2M-8Q4ZX-1HNP3-RT6VW-B9CF0G", RecoveryKey.grouped(key))
        assertEquals(key, RecoveryKey.normalize(RecoveryKey.grouped(key)))
    }
}
