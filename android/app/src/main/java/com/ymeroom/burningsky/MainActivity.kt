package com.ymeroom.burningsky

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * 極簡主畫面。刻意不重做網站已有的因子拆解與歷史——那些點 widget 或通知就會開網站。
 * 這一頁的存在意義是：請求通知權限、讓使用者確認 App 真的有在運作。
 */
class MainActivity : Activity() {

    private val taipei: ZoneId = ZoneId.of("Asia/Taipei")
    private val hhmm: DateTimeFormatter = DateTimeFormatter.ofPattern("MM/dd HH:mm")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        Notifier.ensureChannel(this)
        SyncScheduler.ensureScheduled(this)
        requestNotificationPermissionIfNeeded()

        findViewById<Button>(R.id.refresh).setOnClickListener {
            SyncScheduler.syncNow(this)
            findViewById<TextView>(R.id.generated).text = "更新中…稍候重開此頁查看"
        }
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun render() {
        val f = Repository.load(this)
        val generated = findViewById<TextView>(R.id.generated)
        val scoresView = findViewById<TextView>(R.id.scores)

        if (f == null) {
            generated.text = "尚未同步"
            scoresView.text = "還沒有資料。按「立即更新」抓一次。"
        } else {
            val now = System.currentTimeMillis()
            generated.text = buildString {
                append("資料更新於 ")
                append(Instant.ofEpochMilli(f.generatedAtMs).atZone(taipei).format(hhmm))
                if (isStale(f, now)) append("（已過期）")
            }
            val kind = nextEventKind(f, now)
            scoresView.text = if (kind == null) {
                "資料裡沒有任何場次。"
            } else {
                val label = if (kind == "sunrise") "日出" else "日落"
                buildString {
                    append("下一場・").append(label).append('\n')
                    scoresFor(f, kind).forEach { s ->
                        append(s.name).append("　").append(s.score).append(" 分・").append(s.level).append('\n')
                    }
                }.trimEnd()
            }
        }

        findViewById<TextView>(R.id.notify_status).text = when {
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU -> "通知：已開啟（分數達 $NOTIFY_THRESHOLD 分時提醒，同一場只發一次）"
            hasNotificationPermission() -> "通知：已開啟（分數達 $NOTIFY_THRESHOLD 分時提醒，同一場只發一次）"
            else -> "通知：未授權。widget 仍會正常更新，只是不會主動提醒。可到系統設定開啟。"
        }
    }

    private fun hasNotificationPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasNotificationPermission()) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        render()
    }
}
