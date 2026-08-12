package com.ymeroom.burningsky

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

private const val TAG = "BurningSky"

class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    override fun doWork(): Result {
        val ctx = applicationContext

        // 1. 抓。失敗就重試，已存的舊資料原封不動——widget 繼續顯示上次的結果。
        val json = try {
            Repository.fetch()
        } catch (e: Exception) {
            Log.w(TAG, "抓取 data.json 失敗，保留舊資料並稍後重試", e)
            return Result.retry()
        }

        // 2. 存。先確認能解析再存，避免把壞資料蓋掉好資料。
        try {
            parseForecast(json)
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "data.json 格式非預期，不覆蓋既有資料", e)
            return Result.success()
        }
        Repository.save(ctx, json)

        val f = Repository.load(ctx) ?: return Result.success()

        // 3. 不管有沒有要通知，widget 都要更新
        updateAllWidgets(ctx)

        // 4. 通知判斷。沒有任何事件資料時到此為止。
        val kind = nextEventKind(f, System.currentTimeMillis()) ?: return Result.success()
        if (shouldNotify(f, kind, Repository.lastNotifyKey(ctx), System.currentTimeMillis())) {
            val top = scoresFor(f, kind).first()
            Notifier.notifyBurn(ctx, kind, top)
            notifyKey(f, kind)?.let { Repository.setLastNotifyKey(ctx, it) }
            Log.i(TAG, "已發出提醒：$kind ${top.name} ${top.score} 分")
        }
        return Result.success()
    }
}

object SyncScheduler {

    private const val WORK_NAME = "burning-sky-sync"

    /**
     * 每小時輪詢一次，需有網路。
     *
     * 為什麼是輪詢而不是對準 15:00／23:30：GitHub Actions 的 cron 實測會延遲
     * 1–2.5 小時，固定時刻去抓反而常抓到舊資料。一次請求只有幾 KB，對電池沒有
     * 可感知的影響。
     *
     * KEEP 政策讓這個函式可以重複呼叫（App 啟動、開機都會叫）而不會重設排程。
     */
    fun ensureScheduled(ctx: Context) {
        val req = PeriodicWorkRequestBuilder<SyncWorker>(1, TimeUnit.HOURS)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()
            )
            .build()
        WorkManager.getInstance(ctx)
            .enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    /** 主畫面「立即更新」按鈕用 */
    fun syncNow(ctx: Context) {
        WorkManager.getInstance(ctx).enqueue(OneTimeWorkRequestBuilder<SyncWorker>().build())
    }
}

/**
 * 開機與 App 更新後的復原。
 *
 * MY_PACKAGE_REPLACED 是必要的：App 一被覆蓋安裝，桌面就會退回 initialLayout，
 * 而那個版面的頁尾寫死是「載入中…」。沒有這段，使用者每次更新 App 後都會看到
 * 一個假的載入中狀態，最久要等一小時才會被下次輪詢救回來（2026-08-12 實機撞到）。
 * 這裡直接用快取重畫，不需要等網路。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
                SyncScheduler.ensureScheduled(ctx)
                updateAllWidgets(ctx)
            }
        }
    }
}
