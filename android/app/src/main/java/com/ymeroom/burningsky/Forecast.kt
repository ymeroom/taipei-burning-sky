package com.ymeroom.burningsky

import org.json.JSONException
import org.json.JSONObject
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/**
 * 這個檔案刻意不 import 任何 android.* ——所有判斷邏輯集中在此，
 * 才能在電腦上用 JUnit 直接驗證，不需要裝置或模擬器。
 * 其餘檔案只做「呼叫這裡的純函式 + 操作 Android 框架」。
 */

/** camBurnIndex 門檻沿用網站等級：50 分以上是「值得一看」，才值得打擾使用者 */
const val NOTIFY_THRESHOLD = 50

/** 與網站同一判準：排程最大間隔 15.5 小時，門檻須高於此值才不會每天誤報 */
const val STALE_HOURS = 16

private val TAIPEI: ZoneId = ZoneId.of("Asia/Taipei")
private val DATE_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd")

data class EventData(val eventTimeMs: Long, val score: Int, val level: String)

data class LocationRow(val id: String, val name: String, val events: Map<String, EventData>)

data class Forecast(val generatedAtMs: Long, val locations: List<LocationRow>)

/** 單一地點在某場次的分數，供 widget 與通知使用 */
data class LocationScore(
    val id: String,
    val name: String,
    val score: Int,
    val level: String,
    val eventTimeMs: Long,
)

/**
 * 解析 data.json。格式不如預期一律丟 IllegalArgumentException——
 * 沿用專案「大聲失敗、不用壞資料覆蓋好資料」的原則，由呼叫端決定保留舊資料。
 */
fun parseForecast(json: String): Forecast {
    val root = try {
        JSONObject(json)
    } catch (e: JSONException) {
        throw IllegalArgumentException("data.json 不是合法 JSON", e)
    }

    val generatedAt = root.optString("generatedAt", "")
    val generatedAtMs = try {
        Instant.parse(generatedAt).toEpochMilli()
    } catch (e: DateTimeParseException) {
        throw IllegalArgumentException("generatedAt 格式不正確：$generatedAt", e)
    }

    val arr = root.optJSONArray("locations")
        ?: throw IllegalArgumentException("data.json 缺少 locations")
    if (arr.length() == 0) throw IllegalArgumentException("data.json 的 locations 是空的")

    val locations = (0 until arr.length()).map { i ->
        val o = arr.getJSONObject(i)
        val eventsObj = o.optJSONObject("events") ?: JSONObject()
        val events = eventsObj.keys().asSequence().associateWith { kind ->
            val e = eventsObj.getJSONObject(kind)
            EventData(
                eventTimeMs = parseEventTime(e.getString("eventTime")),
                score = e.getInt("score"),
                level = e.optString("level", ""),
            )
        }
        LocationRow(
            id = o.getString("id"),
            name = o.getString("name"),
            events = events,
        )
    }
    return Forecast(generatedAtMs, locations)
}

private fun parseEventTime(iso: String): Long = try {
    OffsetDateTime.parse(iso).toInstant().toEpochMilli()
} catch (e: DateTimeParseException) {
    throw IllegalArgumentException("eventTime 格式不正確：$iso", e)
}

/**
 * 挑「下一場」：取所有地點所有場次中時間最近且尚未過去者的場次類型。
 * 全部都過去時（資料嚴重過期）回時間最近的那一場而非 null——
 * widget 仍要顯示東西，過期本身交由 [isStale] 的警示處理。
 * 只有在完全沒有任何事件資料時才回 null。
 */
fun nextEventKind(f: Forecast, nowMs: Long): String? {
    val all = f.locations.flatMap { loc -> loc.events.map { (kind, ev) -> kind to ev.eventTimeMs } }
    if (all.isEmpty()) return null
    val future = all.filter { it.second > nowMs }
    // 有未來事件就取最早的那個；全部都過去時取「最晚」的——
    // 那是離現在最近的一場。取最早會挑到最舊、最不相關的資料。
    return if (future.isNotEmpty()) future.minByOrNull { it.second }?.first
    else all.maxByOrNull { it.second }?.first
}

/** 該場次有資料的地點，依分數由高到低。沒有該場次的地點不會出現。 */
fun scoresFor(f: Forecast, kind: String): List<LocationScore> =
    f.locations.mapNotNull { loc ->
        loc.events[kind]?.let { ev ->
            LocationScore(loc.id, loc.name, ev.score, ev.level, ev.eventTimeMs)
        }
    }.sortedByDescending { it.score }

fun isStale(f: Forecast, nowMs: Long): Boolean =
    nowMs - f.generatedAtMs > STALE_HOURS * 3600_000L

/**
 * 事件所屬的台北日期。必須用台北時區——清晨事件（如 05:26+08:00）的 UTC 是前一天，
 * 用 UTC 取日期會把它算成前一天，導致去重鍵錯亂。
 */
fun eventDateKey(eventTimeMs: Long): String =
    Instant.ofEpochMilli(eventTimeMs).atZone(TAIPEI).format(DATE_FMT)

/** 去重鍵：同一場事件只通知一次 */
fun notifyKey(f: Forecast, kind: String): String? =
    scoresFor(f, kind).firstOrNull()?.let { "${eventDateKey(it.eventTimeMs)}:$kind" }

/**
 * 三條規則都要成立才通知：分數夠高、這場還沒通知過、事件尚未發生。
 * 第二條是必要的——每小時輪詢一次，沒有去重會對同一場事件重複轟炸。
 */
fun shouldNotify(f: Forecast, kind: String, lastKey: String?, nowMs: Long): Boolean {
    val top = scoresFor(f, kind).firstOrNull() ?: return false
    if (top.score < NOTIFY_THRESHOLD) return false
    if (top.eventTimeMs <= nowMs) return false
    return notifyKey(f, kind) != lastKey
}
