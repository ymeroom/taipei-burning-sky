package com.ymeroom.burningsky

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private const val SITE_URL = "https://ymeroom.github.io/taipei-burning-sky/"
private val TAIPEI: ZoneId = ZoneId.of("Asia/Taipei")
private val HHMM: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

private val KIND_LABEL = mapOf("sunset" to "日落", "sunrise" to "日出")

/** 三個地點欄位的 view id，依序對應分數由高到低 */
private val SLOTS = listOf(
    Triple(R.id.slot0, R.id.score0, R.id.name0),
    Triple(R.id.slot1, R.id.score1, R.id.name1),
    Triple(R.id.slot2, R.id.score2, R.id.name2),
)

class BurningSkyWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        ids.forEach { mgr.updateAppWidget(it, buildViews(ctx)) }
    }
}

/** 供 SyncWorker 在抓到新資料後呼叫 */
fun updateAllWidgets(ctx: Context) {
    val mgr = AppWidgetManager.getInstance(ctx)
    val ids = mgr.getAppWidgetIds(ComponentName(ctx, BurningSkyWidget::class.java))
    if (ids.isEmpty()) return
    val views = buildViews(ctx)
    ids.forEach { mgr.updateAppWidget(it, views) }
}

private fun buildViews(ctx: Context): RemoteViews {
    val v = RemoteViews(ctx.packageName, R.layout.widget_burning_sky)

    // 整個 widget 可點，開網站看因子拆解
    val pi = PendingIntent.getActivity(
        ctx, 0, Intent(Intent.ACTION_VIEW, Uri.parse(SITE_URL)),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    v.setOnClickPendingIntent(R.id.widget_root, pi)

    val now = System.currentTimeMillis()
    val f = Repository.load(ctx)
    val kind = f?.let { nextEventKind(it, now) }

    // 首次安裝尚未同步，或資料壞掉：顯示載入中而非空白
    if (f == null || kind == null) {
        v.setTextViewText(R.id.kind, "火燒雲預報")
        v.setTextViewText(R.id.event_time, "")
        v.setTextViewText(R.id.countdown, "")
        SLOTS.forEachIndexed { i, (slot, score, name) ->
            v.setViewVisibility(slot, if (i == 0) View.VISIBLE else View.GONE)
            v.setTextViewText(score, "—")
            v.setTextViewText(name, "")
        }
        v.setTextViewText(R.id.footer, "載入中…")
        return v
    }

    val scores = scoresFor(f, kind)
    val eventMs = scores.firstOrNull()?.eventTimeMs ?: 0L

    v.setTextViewText(R.id.kind, "下一場・${KIND_LABEL[kind] ?: kind}")
    v.setTextViewText(R.id.event_time, Instant.ofEpochMilli(eventMs).atZone(TAIPEI).format(HHMM))
    v.setTextViewText(R.id.countdown, countdownText(eventMs, now))

    SLOTS.forEachIndexed { i, (slot, scoreId, nameId) ->
        val s = scores.getOrNull(i)
        if (s == null) {
            // 日出場只有兩個地點，第三欄整個藏起來
            v.setViewVisibility(slot, View.GONE)
        } else {
            v.setViewVisibility(slot, View.VISIBLE)
            v.setTextViewText(scoreId, s.score.toString())
            v.setTextViewText(nameId, shortName(s.name))
            // 最高分（第一個）用等級色加亮，其餘用次要色，一眼看出今天該去哪
            val color = if (i == 0) levelColor(ctx, s.score) else ctx.getColor(R.color.ink_soft)
            v.setTextColor(scoreId, color)
        }
    }

    v.setTextViewText(
        R.id.footer,
        if (isStale(f, now)) "⚠ 資料過期"
        else "更新於 " + Instant.ofEpochMilli(f.generatedAtMs).atZone(TAIPEI).format(HHMM),
    )
    v.setTextColor(
        R.id.footer,
        ctx.getColor(if (isStale(f, now)) R.color.warn else R.color.muted),
    )
    return v
}

private fun levelColor(ctx: Context, score: Int): Int = ctx.getColor(
    when {
        score >= 75 -> R.color.lv3
        score >= 50 -> R.color.lv2
        score >= 25 -> R.color.lv1
        else -> R.color.lv0
    }
)

/** widget 很窄，地點名要縮短：「淡水漁人碼頭」→「淡水」 */
private fun shortName(name: String): String = when {
    name.startsWith("台北") -> "台北"
    name.startsWith("淡水") -> "淡水"
    name.startsWith("高美") -> "高美"
    name.startsWith("望高寮") -> "望高寮"
    name.length <= 4 -> name
    else -> name.take(3)
}

private fun countdownText(eventMs: Long, nowMs: Long): String {
    val diff = eventMs - nowMs
    if (diff <= 0) return "進行中／已結束"
    val h = diff / 3600_000
    val m = (diff % 3600_000) / 60_000
    return if (h > 0) "還有 $h 小時 $m 分" else "還有 $m 分"
}
