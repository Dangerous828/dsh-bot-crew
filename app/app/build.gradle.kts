plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.dsh.botcrew"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dsh.botcrew"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        // 队伍地址与 token 从本地配置读，不进仓库；没配时指向模拟器里的宿主机。
        val gateway = providers.gradleProperty("crewGateway").getOrElse("http://10.0.2.2:8788")
        val gatewayToken = providers.gradleProperty("crewToken").getOrElse("")
        buildConfigField("String", "GW_BASE", "\"$gateway\"")
        buildConfigField("String", "GW_TOKEN", "\"$gatewayToken\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
