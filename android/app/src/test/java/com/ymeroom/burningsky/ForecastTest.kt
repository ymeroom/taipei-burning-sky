package com.ymeroom.burningsky

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 取自 2026-08-11 線上真實 data.json 的四地點結構：
 * taipei 有日落＋日出、tamsui 與 gaomei 只有日落、wanggaoliao 只有日出。
 */
private const val SAMPLE = """
{
  "generatedAt": "2026-08-11T16:15:05.980Z",
  "trigger": "sunrise-run",
  "locations": [
    { "id": "taipei", "name": "台北市中心", "events": {
        "sunset":  { "eventTime": "2026-08-12T18:31:00+08:00", "score": 37, "level": "普通" },
        "sunrise": { "eventTime": "2026-08-12T05:26:00+08:00", "score": 43, "level": "普通" } } },
    { "id": "tamsui", "name": "淡水漁人碼頭", "events": {
        "sunset":  { "eventTime": "2026-08-12T18:32:00+08:00", "score": 41, "level": "普通" } } },
    { "id": "gaomei", "name": "高美濕地", "events": {
        "sunset":  { "eventTime": "2026-08-12T18:34:00+08:00", "score": 39, "level": "普通" } } },
    { "id": "wanggaoliao", "name": "望高寮", "events": {
        "sunrise": { "eventTime": "2026-08-12T05:31:00+08:00", "score": 43, "level": "普通" } } }
  ]
}
"""

private fun ms(iso: String): Long = java.time.OffsetDateTime.parse(iso).toInstant().toEpochMilli()

class ParseTest {
    @Test fun `解析出四個地點與各自宣告的場次`() {
        val f = parseForecast(SAMPLE)
        assertEquals(4, f.locations.size)
        assertEquals(listOf("taipei", "tamsui", "gaomei", "wanggaoliao"), f.locations.map { it.id })

        val taipei = f.locations.first { it.id == "taipei" }
        assertEquals(setOf("sunset", "sunrise"), taipei.events.keys)
        assertEquals("台北市中心", taipei.name)
        assertEquals(37, taipei.events["sunset"]!!.score)

        // 高美是西向夕陽點，資料裡本來就沒有日出場
        assertEquals(setOf("sunset"), f.locations.first { it.id == "gaomei" }.events.keys)
        assertEquals(setOf("sunrise"), f.locations.first { it.id == "wanggaoliao" }.events.keys)
    }

    @Test fun `解析出 generatedAt 與事件時刻`() {
        val f = parseForecast(SAMPLE)
        assertEquals(ms("2026-08-11T16:15:05.980Z"), f.generatedAtMs)
        assertEquals(ms("2026-08-12T18:31:00+08:00"),
            f.locations.first { it.id == "taipei" }.events["sunset"]!!.eventTimeMs)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `非 JSON 丟 IllegalArgumentException`() { parseForecast("這不是 JSON") }

    @Test(expected = IllegalArgumentException::class)
    fun `缺 locations 丟 IllegalArgumentException`() { parseForecast("""{"generatedAt":"2026-08-11T16:15:05.980Z"}""") }

    @Test(expected = IllegalArgumentException::class)
    fun `locations 為空陣列丟 IllegalArgumentException`() {
        parseForecast("""{"generatedAt":"2026-08-11T16:15:05.980Z","locations":[]}""")
    }
}

class NextEventTest {
    private val f = parseForecast(SAMPLE)

    @Test fun `日落之前，下一場是日落`() {
        assertEquals("sunset", nextEventKind(f, ms("2026-08-12T12:00:00+08:00")))
    }

    @Test fun `日落之後，下一場是隔天日出`() {
        // 真實情況：23:30 那班算出來的日出是「隔天」的。
        // 把 fixture 的日出挪到 08-13，模擬日落已過、日出仍在未來的狀態。
        val tomorrowSunrise = f.copy(locations = f.locations.map { loc ->
            val ev = loc.events["sunrise"] ?: return@map loc
            loc.copy(events = loc.events + ("sunrise" to
                ev.copy(eventTimeMs = ev.eventTimeMs + 24 * 3600_000L)))
        })
        assertEquals("sunrise", nextEventKind(tomorrowSunrise, ms("2026-08-12T20:00:00+08:00")))
    }

    @Test fun `全部事件都過去時，回離現在最近的那一場而非最舊的`() {
        // 資料嚴重過期時仍要顯示東西（交由過期警示提醒），
        // 但要挑最晚發生的那場——挑最早的會顯示最舊、最不相關的資料。
        assertEquals("sunset", nextEventKind(f, ms("2026-08-20T12:00:00+08:00")))
    }

    @Test fun `完全沒有事件資料時回 null`() {
        val empty = Forecast(0L, listOf(LocationRow("x", "X", emptyMap())))
        assertNull(nextEventKind(empty, 0L))
    }
}

class ScoresForTest {
    private val f = parseForecast(SAMPLE)

    @Test fun `日落場三個地點，依分數由高到低`() {
        val s = scoresFor(f, "sunset")
        assertEquals(listOf("tamsui", "gaomei", "taipei"), s.map { it.id })
        assertEquals(listOf(41, 39, 37), s.map { it.score })
        assertEquals("淡水漁人碼頭", s[0].name)
    }

    @Test fun `日出場只有兩個地點，不含只有日落的那些`() {
        val ids = scoresFor(f, "sunrise").map { it.id }
        assertEquals(2, ids.size)
        assertTrue(ids.containsAll(listOf("taipei", "wanggaoliao")))
        assertFalse(ids.contains("gaomei"))
        assertFalse(ids.contains("tamsui"))
    }

    @Test fun `未知場次回空清單`() {
        assertTrue(scoresFor(f, "midnight").isEmpty())
    }
}

class StaleTest {
    private val f = parseForecast(SAMPLE)
    private val gen = ms("2026-08-11T16:15:05.980Z")

    @Test fun `未滿 16 小時不算過期`() {
        assertFalse(isStale(f, gen + (15.9 * 3600_000).toLong()))
    }

    @Test fun `超過 16 小時算過期`() {
        assertTrue(isStale(f, gen + (16.1 * 3600_000).toLong()))
    }

    @Test fun `門檻常數為 16 小時`() = assertEquals(16, STALE_HOURS)
}

class EventDateKeyTest {
    @Test fun `以台北時區取日期`() {
        assertEquals("2026-08-12", eventDateKey(ms("2026-08-12T18:31:00+08:00")))
    }

    @Test fun `清晨事件跨 UTC 日界仍屬台北當天`() {
        // 05:26+08:00 的 UTC 是前一天 21:26；用 UTC 取日期會得到 08-11，是錯的
        assertEquals("2026-08-12", eventDateKey(ms("2026-08-12T05:26:00+08:00")))
    }
}

class ShouldNotifyTest {
    private val f = parseForecast(SAMPLE)
    private val beforeSunset = ms("2026-08-12T12:00:00+08:00")

    private fun withTopScore(score: Int): Forecast = f.copy(
        locations = f.locations.map { loc ->
            val ev = loc.events["sunset"] ?: return@map loc
            if (loc.id == "tamsui") loc.copy(events = loc.events + ("sunset" to ev.copy(score = score))) else loc
        }
    )

    @Test fun `門檻常數為 50`() = assertEquals(50, NOTIFY_THRESHOLD)

    @Test fun `最高分 49 不發`() {
        assertFalse(shouldNotify(withTopScore(49), "sunset", null, beforeSunset))
    }

    @Test fun `最高分剛好 50 就發`() {
        assertTrue(shouldNotify(withTopScore(50), "sunset", null, beforeSunset))
    }

    @Test fun `同一場事件已通知過就不再發`() {
        val high = withTopScore(80)
        val key = notifyKey(high, "sunset")
        assertEquals("2026-08-12:sunset", key)
        assertFalse(shouldNotify(high, "sunset", key, beforeSunset))
    }

    @Test fun `通知過別場事件不影響這一場`() {
        assertTrue(shouldNotify(withTopScore(80), "sunset", "2026-08-12:sunrise", beforeSunset))
    }

    @Test fun `事件時刻已過就不發`() {
        val afterSunset = ms("2026-08-12T19:30:00+08:00")
        assertFalse(shouldNotify(withTopScore(80), "sunset", null, afterSunset))
    }

    @Test fun `沒有該場次資料時不發，也不炸`() {
        assertFalse(shouldNotify(f, "midnight", null, beforeSunset))
        assertNull(notifyKey(f, "midnight"))
    }
}
