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
        // applicationId 可被 crewAppId 覆盖：只用于「装一份隔离副本做真机验证」，不切包名时逐字不变。
        applicationId = providers.gradleProperty("crewAppId").getOrElse("com.dsh.botcrew")
        minSdk = 26
        targetSdk = 35
        // 版本走 Gradle 参数：发布脚本按最新递增 -PcrewVersionCode=…；缺省是给本地/调试包的一档。
        // 诊断页与 OTA 判定都以真实安装的 versionCode 为准（见 OtaRuntime.installedVersionCode）。
        versionCode = providers.gradleProperty("crewVersionCode").getOrElse("2").toInt()
        versionName = providers.gradleProperty("crewVersionName").getOrElse("0.2.0")

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

        // 诊断上报 + 公网 bootstrap（lead 确认部署域名与预期 crew 后再注入；两者默认空，缺省不启用，不给别的 server 送 token）。
        // - PUBLIC_BASE：本次固定部署的公网域名（真实 HTTPS），作缺失 fallback 的 bootstrap 候选；默认空。
        // - EXPECTED_CREW：该部署的 server.crew 指纹（与 mDNS 同源），bootstrap 精确比对用；默认空。
        // - DIAG_BASE：诊断上报地址，默认生产域名；空则用 DiagUploader.DEFAULT_BASE。
        val publicBase = providers.gradleProperty("crewPublicBase").getOrElse("")
        val expectedCrew = providers.gradleProperty("crewExpectedCrew").getOrElse("")
        val diagBase = providers.gradleProperty("crewDiagBase").getOrElse("")
        buildConfigField("String", "CREW_PUBLIC_BASE", "\"$publicBase\"")
        buildConfigField("String", "CREW_EXPECTED_CREW", "\"$expectedCrew\"")
        buildConfigField("String", "CREW_DIAG_BASE", "\"$diagBase\"")

        // 轻量构建标记（只标识哪次构建，不当版本号用；不引 git 自动 commit）：
        // 最终发布指定 -PcrewBuildId=cellular-20261115-r1；generic 默认 local。
        // 诊断 body.build 与诊断页都显示它，便于服务端对照「哪个真实 APK」。
        val buildId = providers.gradleProperty("crewBuildId").getOrElse("local")
        buildConfigField("String", "CREW_BUILD_ID", "\"$buildId\"")

        // OTA 入口：manifest 与 APK 同 origin，只走 HTTPS，不带任何配对凭据。
        // 发布时可用 -PcrewUpdateUrl=… 指到预发；缺省是生产静态目录。
        val updateUrl = providers.gradleProperty("crewUpdateUrl")
            .getOrElse("https://crew.kentonnie.top/updates/android/manifest.json")
        buildConfigField("String", "OTA_MANIFEST_URL", "\"$updateUrl\"")

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

    // 探测的失败/超时路径会走 android.util.Log，而 JVM 单测里它是「not mocked」直接抛。
    // 要测的正是那些路径，所以让 stub 返回默认值（Log 变成空操作），不额外引 mock 框架。
    testOptions { unitTests.isReturnDefaultValues = true }

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
