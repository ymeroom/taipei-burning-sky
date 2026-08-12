// AGP 固定 8.1.4：與本機已快取的 Gradle 8.2 相容。
// 升到 AGP 8.5+ 會要求 Gradle 8.7，觸發額外下載。
plugins {
    id("com.android.application") version "8.1.4" apply false
    id("org.jetbrains.kotlin.android") version "1.9.22" apply false
}
