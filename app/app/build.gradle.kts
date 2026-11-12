plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.dsh.botcrew"
    compileSdk = 35
    // 钉住 NDK 版本：机器上装了两个，不钉的话 AGP 会自己挑一个，换个环境编出来的东西就不一样。
    ndkVersion = "28.2.13676358"

    defaultConfig {
        applicationId = "com.dsh.botcrew"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        // 队伍地址与 token 从本地配置读，不进仓库；没配时指向模拟器里的宿主机。
        // 默认指向队伍自己的监听，不是网关：配对和消息面都在这条路上，网关只有对话条目。
        // 端口按 stateDir 算出来，见 backend/src/app/lan-server.ts 的 lanPort。
        val gateway = providers.gradleProperty("crewGateway").getOrElse("http://10.0.2.2:43499")
        val gatewayToken = providers.gradleProperty("crewToken").getOrElse("")
        buildConfigField("String", "GW_BASE", "\"$gateway\"")
        buildConfigField("String", "GW_TOKEN", "\"$gatewayToken\"")
        // 内置配对：调试包直接带着设备凭据出门，省掉每次手输地址和码。
        // 空字符串表示不内置，照常走配对屏。
        val builtInDevice = providers.gradleProperty("crewDevice").getOrElse("")
        val builtInToken = providers.gradleProperty("crewCredential").getOrElse("")
        buildConfigField("String", "CREW_DEVICE", "\"$builtInDevice\"")
        buildConfigField("String", "CREW_CREDENTIAL", "\"$builtInToken\"")

        // JNI 包装对每个 ABI 都编，隧道本体（libtailcat.so）由 jniLibs 按 ABI 提供，
        // 目前只有 arm64-v8a。见 src/main/cpp/README.md。
        externalNativeBuild {
            cmake {
                // 纯 C，不引 C++ 运行时：省掉一份 libc++_shared.so，包里也没有别的 C++ 代码。
                arguments += "-DANDROID_STL=none"
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    packaging {
        // 压缩原生库：隧道本体 16.6MB，压完 6.4MB，APK 从 26MB 降到 16MB。
        // 不压缩时那份 .so 在包里是 STORED（为了 16KB 页对齐），增量打包只能往后追加，
        // 于是每次打包都多出一份完整的 .so 当死字节；压缩后只会多出变化的那一段（实测几百 KB）。
        // 代价：安装时系统把它解到 /data（多占 16MB 磁盘）。调试包天天重装，选小的那份。
        jniLibs { useLegacyPackaging = true }
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
