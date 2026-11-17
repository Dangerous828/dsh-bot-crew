package com.dsh.botcrew

/**
 * 公网 bootstrap 的**准入判定**（纯函数，可单测）。
 *
 * ## 为什么单独抽出来
 *
 * bootstrap 会带着**设备凭据**去打一个 build 注入的部署域名。这条路径最危险的错误是：
 * 把「build 里配的预期 crew」当成「本机已登记的可信身份」，于是空 savedCrew 也会去发 token。
 * 这里把判定收成一个纯函数，让「空 savedCrew / 预期不符 / 配置为空 → 0 请求」可被单测钉死，
 * 而不是在 MainActivity 里被调用的那一刻偷偷替换参数。
 *
 * ## 硬规则（lead 冻结）
 *
 * bootstrap **仅当**下面全部成立才允许，否则一律拒绝（不请求、不发 token）：
 * 1. `savedCrew` 非空 —— 本机**已登记**的可信服务器指纹（来自既有可信入口响应或新 pair）；
 * 2. `injectedBase` 非空 —— build 注入了部署域名（generic 默认空）；
 * 3. `expectedCrew` 非空 —— build 注入了预期 crew；
 * 4. `savedCrew == expectedCrew` —— 已登记身份与部署预期**逐字相等**。
 *
 * **绝不**用 `expectedCrew` 兜底 `savedCrew`（不能拿 build 预期值伪装成已登记身份）；
 * 也不靠「候选 domain 回 200」反过来建立身份——那只是本次 auth 路由可答，不是同机证明。
 */
object BootstrapGate {

    /** 准入决定。[allowed]=true 时才可发起 bootstrap；[base]/[expectCrew] 是请求参数。 */
    data class Decision(
        val allowed: Boolean,
        val base: String = "",
        val expectCrew: String = "",
        val reason: String = "",
    )

    /**
     * 判定是否允许 bootstrap。
     *
     * @param savedCrew 本机已登记的可信指纹（PairedCrew.serverCrew 或 crew）。空=未登记。
     * @param injectedBase build 注入的部署域名（CREW_PUBLIC_BASE）。generic 默认空。
     * @param expectedCrew build 注入的预期 crew（CREW_EXPECTED_CREW）。generic 默认空。
     * @param savedFallback 本地现有公网入口；非空说明已有可用入口，无需 bootstrap。
     */
    fun decide(savedCrew: String, injectedBase: String, expectedCrew: String, savedFallback: String): Decision {
        val crew = savedCrew.trim()
        val base = injectedBase.trim()
        val expect = expectedCrew.trim()
        // 已有非空公网入口：不 bootstrap（交给 trustedPublicBase 精确更新，不另开候选）。
        if (savedFallback.isNotBlank()) {
            return Decision(false, reason = "已有公网入口，无需 bootstrap")
        }
        // 空 savedCrew：绝不 bootstrap（不能拿预期值伪装身份，也不能靠候选 200 建立身份）。
        if (crew.isEmpty()) {
            return Decision(false, reason = "空 savedCrew：首次身份只经可信已配置入口响应或 new-pair 登记")
        }
        // 配置为空：generic 包默认不联网 bootstrap。
        if (base.isEmpty() || expect.isEmpty()) {
            return Decision(false, reason = "未注入部署域名/预期 crew（generic 默认）")
        }
        // 已登记身份必须与部署预期逐字相等。
        if (crew != expect) {
            return Decision(false, reason = "savedCrew 与预期不符：不向 bootstrap 发 token")
        }
        return Decision(true, base = base, expectCrew = expect)
    }
}

/**
 * 上传入口选择（纯函数，可单测）。**只**从可信来源取 HTTPS 上传地址，空/非法/不可信 → null（不上报、不发 token）。
 *
 * 来源优先级：
 * 1. 本机已登记同 crew 的 `serverPublicBase`（服务端自报可信 HTTPS）——最可信。
 * 2. 本机 `fallbackBase`，但必须 HTTPS —— 它是配对/发现记下的入口。
 * 3. build 注入的 `diagBase`，但**必须** savedCrew 与 expectedCrew 都非空且精确相等（不拿预期值伪装身份）。
 * 任一来源须经 [DiagUploader.validEndpoint]（HTTPS、无 userinfo/query/hash）校验。
 */
object UploadEndpoint {
    data class Decision(val url: String = "", val reason: String = "")

    fun decide(
        serverPublicBase: String,
        fallbackBase: String,
        savedCrew: String,
        diagBase: String,
        expectedCrew: String,
    ): Decision {
        // 1) 服务端自报可信入口（本机已配对后 timeline 的 server.public_base）。
        val spb = serverPublicBase.trim()
        if (spb.isNotEmpty() && DiagUploader.validEndpoint(spb)) return Decision(spb, "serverPublicBase")
        // 2) 本机 fallback，须 HTTPS。
        val fb = fallbackBase.trim()
        if (fb.isNotEmpty() && DiagUploader.validEndpoint(fb)) return Decision(fb, "fallbackBase")
        // 3) 注入 DIAG_BASE：须 savedCrew==expectedCrew 精确匹配（不拿预期值伪装身份），且合法 HTTPS。
        val db = diagBase.trim()
        val crew = savedCrew.trim()
        val expect = expectedCrew.trim()
        if (db.isNotEmpty() && DiagUploader.validEndpoint(db) &&
            crew.isNotEmpty() && expect.isNotEmpty() && crew == expect
        ) {
            return Decision(db, "diagBase(crew-matched)")
        }
        return Decision("", "no_trusted_https_endpoint")
    }
}

/**
 * bootstrap + 上传入口的综合准入（把 crew 精确比对与 https 校验都收在纯逻辑里，供 MainActivity 单测）。
 */
