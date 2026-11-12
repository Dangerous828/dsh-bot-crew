/*
 * libtailcat 的 JNI 包装。
 *
 * 只做三件事：把句柄包成 jlong、把 Java 数组换成原生缓冲、把状态码换成 Java 异常。
 * 隧道本身（NAT 穿透、WireGuard、userspace TCP 栈）在库里，这里不做任何协议判断。
 *
 * 为什么用 dlopen 而不是直接链接 libtailcat.so：那个库只有 arm64 一份（真机架构），
 * 直接链接会让 x86_64 模拟器上连这个包装库都装不进去 —— 整台机器就没法用。
 * 改成运行期找符号之后，模拟器上包装库照常加载，第一次真正要建隧道时才知道缺库，
 * 上层按「这台机器没有 P2P」退回局域网/公网。
 */

#include <jni.h>
#include <android/log.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "tailcat_abi.h"

#define TAG "CrewTailcat"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

/* 符号表：只取这个 App 用得到的那些，其余留给以后的版本。 */
typedef struct {
    uint32_t (*abi_version)(void);
    int32_t (*token_new)(int64_t, tc_handle *, char **);
    int32_t (*close)(tc_handle, char **);
    void (*free_mem)(void *);
    int32_t (*client_new)(char *, tc_handle *, char **);
    int32_t (*client_dial)(tc_handle, tc_handle, uint16_t, int32_t, tc_handle *, char **);
    int32_t (*conn_read)(tc_handle, tc_handle, void *, size_t, size_t *, char **);
    int32_t (*conn_write)(tc_handle, tc_handle, void *, size_t, size_t *, char **);
    int32_t (*conn_close_write)(tc_handle, tc_handle, char **);
} tc_api;

static tc_api api;
static int api_loaded;          /* 1 = 试过了（成不成看 api_loaded_ok） */
static int api_loaded_ok;
static char api_problem[512];

/* 取函数地址。ISO C 不允许把 void* 直接当函数指针用，走 memcpy 是唯一不依赖编译器扩展的办法。 */
static int bind_symbol(void *lib, const char *name, void *slot) {
    void *found = dlsym(lib, name);
    if (found == NULL) {
        snprintf(api_problem, sizeof api_problem, "libtailcat.so 里没有 %s", name);
        return 0;
    }
    memcpy(slot, &found, sizeof found);
    return 1;
}

/* 首次调用时把库打开并找齐符号。成功返回 1；失败时 api_problem 里有原因。 */
static int ensure_api(void) {
    if (api_loaded) return api_loaded_ok;
    api_loaded = 1;

    /*
     * 先按 soname 找。App 的原生库目录在链接器的默认搜索路径里，
     * 上面 Kotlin 那次 System.loadLibrary("tailcat") 已经把路径登记过一次，
     * 所以 arm64 真机上这一步一定命中。
     */
    void *lib = dlopen("libtailcat.so", RTLD_NOW | RTLD_LOCAL);
    if (lib == NULL) {
        const char *why = dlerror();
        snprintf(api_problem, sizeof api_problem, "打不开 libtailcat.so：%s", why ? why : "没有说明");
        LOGE("%s", api_problem);
        return 0;
    }

    int ok = bind_symbol(lib, "tc_abi_version", &api.abi_version) &&
        bind_symbol(lib, "tc_token_new", &api.token_new) &&
        bind_symbol(lib, "tc_close", &api.close) &&
        bind_symbol(lib, "tc_free", &api.free_mem) &&
        bind_symbol(lib, "tc_client_new", &api.client_new) &&
        bind_symbol(lib, "tc_client_dial", &api.client_dial) &&
        bind_symbol(lib, "tc_conn_read", &api.conn_read) &&
        bind_symbol(lib, "tc_conn_write", &api.conn_write) &&
        bind_symbol(lib, "tc_conn_close_write", &api.conn_close_write);
    if (!ok) {
        LOGE("%s", api_problem);
        dlclose(lib);
        return 0;
    }

    api_loaded_ok = 1;
    LOGI("libtailcat 已加载，ABI %u", api.abi_version());
    return 1;
}

static void throw_java(JNIEnv *env, const char *type, const char *message) {
    jclass found = (*env)->FindClass(env, type);
    if (found != NULL) (*env)->ThrowNew(env, found, message);
}

static void throw_unavailable(JNIEnv *env) {
    char message[600];
    snprintf(message, sizeof message, "这台机器上没有 P2P 通道：%s",
        api_problem[0] ? api_problem : "libtailcat.so 不可用");
    throw_java(env, "java/lang/IllegalStateException", message);
}

/*
 * 把库返回的状态码翻成人能读的异常。error 是库分配的字符串，必须交回 tc_free ——
 * 用 free() 会破坏 Go 那边的分配器。
 */
static void throw_status(JNIEnv *env, const char *action, int32_t status, char *error) {
    char message[600];
    snprintf(message, sizeof message, "%s 失败（status=%d）：%s",
        action, status, (error != NULL) ? error : "没有说明");
    if (error != NULL) api.free_mem(error);
    LOGE("%s", message);
    throw_java(env, "java/io/IOException", message);
}

static void release_error(char *error) {
    if (error != NULL) api.free_mem(error);
}

/* 拼 {"address":"..."}。地址是 base64url，正常情况下不需转义；脏数据也得如实拒掉而不是拼出坏 JSON。 */
static char *build_config(const char *address) {
    size_t length = strlen(address);
    size_t capacity = length * 2 + 32;
    char *out = malloc(capacity);
    if (out == NULL) return NULL;
    size_t at = (size_t)snprintf(out, capacity, "{\"address\":\"");
    for (size_t i = 0; i < length; i++) {
        unsigned char c = (unsigned char)address[i];
        if (c == '"' || c == '\\') {
            out[at++] = '\\';
            out[at++] = (char)c;
        } else if (c < 0x20) {
            at += (size_t)snprintf(out + at, capacity - at, "\\u%04x", c);
        } else {
            out[at++] = (char)c;
        }
    }
    snprintf(out + at, capacity - at, "\"}");
    return out;
}

JNIEXPORT jint JNICALL
Java_com_dsh_botcrew_TailcatNative_nativeAbiVersion(JNIEnv *env, jobject self) {
    (void)self;
    if (!ensure_api()) {
        throw_unavailable(env);
        return 0;
    }
    return (jint)api.abi_version();
}

JNIEXPORT jlong JNICALL
Java_com_dsh_botcrew_TailcatNative_nativeClientNew(JNIEnv *env, jobject self, jstring address) {
    (void)self;
    if (!ensure_api()) {
        throw_unavailable(env);
        return 0;
    }
    if (address == NULL) {
        throw_java(env, "java/lang/IllegalArgumentException", "地址是空的");
        return 0;
    }
    const char *raw = (*env)->GetStringUTFChars(env, address, NULL);
    if (raw == NULL) return 0; /* 已经挂了 OutOfMemoryError */

    char *config = build_config(raw);
    (*env)->ReleaseStringUTFChars(env, address, raw);
    if (config == NULL) {
        throw_java(env, "java/lang/OutOfMemoryError", "拼不出客户端配置");
        return 0;
    }

    tc_handle client = 0;
    char *error = NULL;
    int32_t status = api.client_new(config, &client, &error);
    free(config);
    if (status != TC_OK) {
        if (client != 0) api.close(client, NULL);
        throw_status(env, "tc_client_new", status, error);
        return 0;
    }
    return (jlong)client;
}

/*
 * timeoutMs > 0 时用一个带期限的 token 兜住建连：dial 里有注册、路径发现和握手，
 * 电脑不在线时它能卡很久。没有期限就只能靠关闭句柄来打断，那对「探测一下通不通」太笨重。
 */
JNIEXPORT jlong JNICALL
Java_com_dsh_botcrew_TailcatNative_nativeDial(JNIEnv *env, jobject self,
        jlong client, jint port, jint timeout_ms) {
    (void)self;
    if (!ensure_api()) {
        throw_unavailable(env);
        return 0;
    }
    if (client == 0) {
        throw_java(env, "java/lang/IllegalArgumentException", "client 句柄是 0");
        return 0;
    }
    if (port < 1 || port > 65535) {
        throw_java(env, "java/lang/IllegalArgumentException", "端口越界");
        return 0;
    }

    tc_handle token = TC_NO_CANCEL;
    char *error = NULL;
    if (timeout_ms > 0) {
        int32_t status = api.token_new((int64_t)timeout_ms * 1000000LL, &token, &error);
        if (status != TC_OK) {
            throw_status(env, "tc_token_new", status, error);
            return 0;
        }
    }

    tc_handle connection = 0;
    int32_t status = api.client_dial((tc_handle)client, token, (uint16_t)port, TC_TCP,
        &connection, &error);
    if (token != TC_NO_CANCEL) {
        char *ignored = NULL;
        api.close(token, &ignored);
        release_error(ignored);
    }
    if (status != TC_OK) {
        if (connection != 0) api.close(connection, NULL);
        throw_status(env, "tc_client_dial", status, error);
        return 0;
    }
    return (jlong)connection;
}

/*
 * 读一段。返回读到的字节数；-1 表示对端发了 FIN（这条流读完了）。
 *
 * 先读进原生缓冲再写回 Java 数组：直接对着 Java 数组做阻塞读会长时间钉住 GC。
 */
JNIEXPORT jint JNICALL
Java_com_dsh_botcrew_TailcatNative_nativeRead(JNIEnv *env, jobject self,
        jlong connection, jbyteArray buffer) {
    (void)self;
    if (!ensure_api()) {
        throw_unavailable(env);
        return -1;
    }
    if (buffer == NULL) {
        throw_java(env, "java/lang/IllegalArgumentException", "缓冲是空的");
        return -1;
    }
    jsize capacity = (*env)->GetArrayLength(env, buffer);
    if (capacity <= 0) return 0;

    void *scratch = malloc((size_t)capacity);
    if (scratch == NULL) {
        throw_java(env, "java/lang/OutOfMemoryError", "分配读缓冲失败");
        return -1;
    }

    size_t count = 0;
    char *error = NULL;
    int32_t status = api.conn_read((tc_handle)connection, TC_NO_CANCEL, scratch,
        (size_t)capacity, &count, &error);
    jint result = -1;
    if (count > 0) {
        (*env)->SetByteArrayRegion(env, buffer, 0, (jsize)count, (const jbyte *)scratch);
        result = (jint)count;
    }
    free(scratch);

    /* 先看字节再看状态：状态是错的时候 count 里也可能已经有数据了。 */
    if (status == TC_OK || status == TC_EOF) {
        release_error(error);
        return result;
    }
    throw_status(env, "tc_conn_read", status, error);
    return -1;
}

/*
 * 写完 length 个字节，返回实际写出去的数目。
 *
 * 循环留在原生层：TCP 写本来就可能短写，让 Kotlin 每短写一次就跨一次 JNI 不划算。
 */
JNIEXPORT jint JNICALL
Java_com_dsh_botcrew_TailcatNative_nativeWrite(JNIEnv *env, jobject self,
        jlong connection, jbyteArray buffer, jint length) {
    (void)self;
    if (!ensure_api()) {
        throw_unavailable(env);
        return 0;
    }
    if (buffer == NULL || length < 0) {
        throw_java(env, "java/lang/IllegalArgumentException", "要写的字节数不对");
        return 0;
    }
    jsize capacity = (*env)->GetArrayLength(env, buffer);
    if (length > capacity) {
        throw_java(env, "java/lang/IllegalArgumentException", "要写的字节数比缓冲还长");
        return 0;
    }

    jbyte *bytes = (*env)->GetByteArrayElements(env, buffer, NULL);
    if (bytes == NULL) return 0;

    size_t written = 0;
    char *error = NULL;
    int32_t status = TC_OK;
    while (written < (size_t)length) {
        size_t step = 0;
        status = api.conn_write((tc_handle)connection, TC_NO_CANCEL, bytes + written,
            (size_t)length - written, &step, &error);
        written += step;
        if (status != TC_OK) break;
        /* 状态是成功却一个字节也没写出去：再转下去没有意义，交给上层判失败。 */
        if (step == 0) break;
    }
    (*env)->ReleaseByteArrayElements(env, buffer, bytes, JNI_ABORT);

    if (status != TC_OK) {
        throw_status(env, "tc_conn_write", status, error);
    } else {
        release_error(error);
    }
    return (jint)written;
}

/* 关掉写端（发 FIN），读那半条还留着。给 HTTP 用：请求写完，等回应。 */
JNIEXPORT void JNICALL
Java_com_dsh_botcrew_TailcatNative_nativeCloseWrite(JNIEnv *env, jobject self, jlong connection) {
    (void)self;
    if (!ensure_api()) {
        throw_unavailable(env);
        return;
    }
    char *error = NULL;
    int32_t status = api.conn_close_write((tc_handle)connection, TC_NO_CANCEL, &error);
    if (status == TC_OK || status == TC_CLOSED) {
        release_error(error);
        return;
    }
    throw_status(env, "tc_conn_close_write", status, error);
}

/*
 * 释放一个句柄。已经关过的一律安静返回 TC_CLOSED ——
 * 连接两头各收各尾时必然有第二次关闭，那不是错误。
 */
JNIEXPORT void JNICALL
Java_com_dsh_botcrew_TailcatNative_nativeClose(JNIEnv *env, jobject self, jlong handle) {
    (void)self;
    if (handle == 0 || !ensure_api()) return;
    char *error = NULL;
    int32_t status = api.close((tc_handle)handle, &error);
    if (status == TC_OK || status == TC_CLOSED) {
        release_error(error);
        return;
    }
    /* 关闭失败也要说一声：句柄已经退役，但没静默吞掉。 */
    LOGE("tc_close 失败（status=%d）：%s", status, (error != NULL) ? error : "没有说明");
    release_error(error);
}
