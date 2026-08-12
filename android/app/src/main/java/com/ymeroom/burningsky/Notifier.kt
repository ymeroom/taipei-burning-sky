package com.ymeroom.burningsky

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

object Notifier {

    const val CHANNEL_ID = "burning-sky-alert"
    private const val NOTIFICATION_ID = 1
    private const val SITE_URL = "https://ymeroom.github.io/taipei-burning-sky/"
    private val TAIPEI: ZoneId = ZoneId.of("Asia/Taipei")
    private val HHMM: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

    fun ensureChannel(ctx: Context) {
        val ch = NotificationChannel(
            CHANNEL_ID,
            "火燒雲提醒",
            // DEFAULT 而非 HIGH：會出現在通知列並響一聲，但不強制蓋在畫面上。
            // 這是「今晚可以去拍」的提示，不是緊急事件。
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "任一地點分數達 $NOTIFY_THRESHOLD 分以上時提醒，同一場事件只發一次"
        }
        ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    fun notifyBurn(ctx: Context, kind: String, top: LocationScore) {
        val title = if (kind == "sunrise") "明早可能會燒" else "今晚可能會燒"
        val eventLabel = if (kind == "sunrise") "日出" else "日落"
        val time = Instant.ofEpochMilli(top.eventTimeMs).atZone(TAIPEI).format(HHMM)
        val diff = top.eventTimeMs - System.currentTimeMillis()
        val h = diff / 3600_000
        val m = (diff % 3600_000) / 60_000
        val countdown = if (h > 0) "還有 $h 小時" else "還有 $m 分"

        val pi = PendingIntent.getActivity(
            ctx, 0, Intent(Intent.ACTION_VIEW, Uri.parse(SITE_URL)),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val n = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title)
            .setContentText("${top.name} ${top.score} 分・${top.level}")
            .setStyle(
                NotificationCompat.BigTextStyle().bigText(
                    "${top.name} ${top.score} 分・${top.level}\n$eventLabel $time，$countdown"
                )
            )
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()

        // 權限被拒時 notify 會被系統忽略，widget 仍照常運作——這是刻意的降級而非錯誤
        try {
            NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, n)
        } catch (e: SecurityException) {
            android.util.Log.i("BurningSky", "沒有通知權限，略過本次提醒", e)
        }
    }
}
