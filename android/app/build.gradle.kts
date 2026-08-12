plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.ymeroom.burningsky"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.ymeroom.burningsky"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

// 刻意維持極少相依：這個 App 只做一件事（抓一份小 JSON、畫幾個數字、必要時發通知）。
// 網路用 JDK 內建的 HttpURLConnection、JSON 用 Android 內建的 org.json，
// widget 用傳統 RemoteViews 而非 Compose/Glance——後者會把 APK 從約 2MB 撐到 8MB 以上。
dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.work:work-runtime-ktx:2.9.0")
    testImplementation("junit:junit:4.13.2")
}
