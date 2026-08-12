package com.ymeroom.burningsky

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import java.net.HttpURLConnection
import java.net.URL

/**
 * 抓取與本機儲存。刻意很薄——所有判斷邏輯都在 Forecast.kt。
 *
 * 網路用 JDK 內建的 HttpURLConnection：這只是一個幾 KB 的 GET，
 * 不值得為它引入 OkHttp 或 Retrofit。
 */
object Repository {

    const val DATA_URL = "https://ymeroom.github.io/taipei-burning-sky/data.json"

    private const val PREFS = "burning_sky"
    private const val KEY_JSON = "forecast_json"
    private const val KEY_LAST_NOTIFY = "last_notify_key"
    private const val TIMEOUT_MS = 15_000
    private const val TAG = "BurningSky"

    /** 抓原始 JSON 字串。任何失敗都往外拋，由呼叫端決定重試並保留舊資料。 */
    fun fetch(): String {
        val conn = (URL(DATA_URL).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            setRequestProperty("Accept", "application/json")
        }
        try {
            val code = conn.responseCode
            if (code != HttpURLConnection.HTTP_OK) {
                throw java.io.IOException("HTTP $code：$DATA_URL")
            }
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun save(ctx: Context, json: String) {
        prefs(ctx).edit().putString(KEY_JSON, json).apply()
    }

    /**
     * 讀出已存的預報。解析失敗回 null 並記 log，**不清掉已存的 JSON**——
     * 沿用專案原則：壞資料不覆蓋好資料，也不因為一次解析失敗就把歷史清空。
     */
    fun load(ctx: Context): Forecast? {
        val json = prefs(ctx).getString(KEY_JSON, null) ?: return null
        return try {
            parseForecast(json)
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "已存的 data.json 解析失敗，保留原檔不動", e)
            null
        }
    }

    /**
     * 監聽資料變更。背景同步是非同步的，畫面開著時資料可能晚一步才到——
     * 沒有這個監聽，使用者按下「立即更新」後畫面會一直停在舊狀態，
     * 要離開再回來才會更新。
     */
    fun registerChangeListener(ctx: Context, l: SharedPreferences.OnSharedPreferenceChangeListener) {
        prefs(ctx).registerOnSharedPreferenceChangeListener(l)
    }

    fun unregisterChangeListener(ctx: Context, l: SharedPreferences.OnSharedPreferenceChangeListener) {
        prefs(ctx).unregisterOnSharedPreferenceChangeListener(l)
    }

    fun lastNotifyKey(ctx: Context): String? = prefs(ctx).getString(KEY_LAST_NOTIFY, null)

    fun setLastNotifyKey(ctx: Context, key: String) {
        prefs(ctx).edit().putString(KEY_LAST_NOTIFY, key).apply()
    }
}
