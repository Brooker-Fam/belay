package family.brooker.belay.core

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The sixth review's G4: the kid's "What your parent can see" says what the parents' AI app can
 * always read (core's AiAlways), and docs/mcp.md's "Always included" says it for parents. One
 * entry per item on each side, so neither can gain an item the other doesn't have.
 */
class AiAlwaysTest {
    /** docs/mcp.md, from wherever the tests run (Gradle runs them in android/core). */
    private fun mcpDoc(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val doc = File(dir, "docs/mcp.md")
            if (doc.isFile) return doc
            dir = dir.parentFile
        }
        error("docs/mcp.md not found above ${File("").absolutePath}")
    }

    /** The bold labels of the list that follows "**Always included**" in docs/mcp.md. */
    private fun docLabels(): List<String> {
        val lines = mcpDoc().readLines()
        val start = lines.indexOfFirst { it.startsWith("**Always included**") }
        assertTrue(start >= 0, "docs/mcp.md has an \"**Always included**\" list")
        val list = lines.drop(start + 1).dropWhile { !it.startsWith("- ") }.takeWhile { it.isNotBlank() }
        return list.filter { it.startsWith("- **") }.map { line ->
            val label = line.removePrefix("- **").substringBefore("**")
            label.removeSuffix(":")
        }
    }

    @Test
    fun `docs mcp's always included list and the kid's phone have the same items`() {
        assertEquals(AiAlways.ITEMS.map { it.docLabel }, docLabels())
    }

    @Test
    fun `the kid's words are plain sentences, with no time, number or name of the family's`() {
        for (item in AiAlways.ITEMS) {
            assertTrue(item.words.first().isUpperCase(), item.words)
            assertTrue(item.words.none(Char::isDigit), "no numbers: ${item.words}")
            assertTrue(item.words.length < 200, item.words)
        }
    }
}
