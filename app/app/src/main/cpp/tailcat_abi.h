/*
 * tailcat C ABI v1 里这个 App 用到的那一部分。
 *
 * 为什么不直接 include 上游的 tailcat.h：那个头随上游一起变，而我们只接受一个固定 ABI
 * （见 tailcat_jni.c 里的版本校验）。这里抄下确切的签名，上游改了参数时编译期就会对不上，
 * 而不是运行期把栈搞坏。库本体由 backend/scripts/build-tailcat 编出来，只放 arm64。
 */

#ifndef BOTCREW_TAILCAT_ABI_H
#define BOTCREW_TAILCAT_ABI_H

#include <stddef.h>
#include <stdint.h>

typedef uint64_t tc_handle;

/* 同步调用不带取消/期限时用这个哨兵；它不是一个可释放的句柄。 */
#define TC_NO_CANCEL ((tc_handle)0)

enum {
    TC_OK = 0,
    TC_INVALID_ARGUMENT = 1,
    TC_CLOSED = 2,
    TC_TIMEOUT = 3,
    TC_CANCELLED = 4,
    TC_FAILURE = 5,
    TC_EOF = 6
};

enum {
    TC_TCP = 1,
    TC_UDP = 2
};

uint32_t tc_abi_version(void);

int32_t tc_token_new(int64_t timeout_ns, tc_handle *out, char **error);

int32_t tc_close(tc_handle resource, char **error);

void tc_free(void *allocation);

int32_t tc_client_new(char *config_json, tc_handle *out, char **error);

int32_t tc_client_dial(tc_handle client, tc_handle cancellation_token,
    uint16_t port, int32_t network, tc_handle *out, char **error);

int32_t tc_conn_read(tc_handle connection, tc_handle cancellation_token,
    void *buffer, size_t capacity, size_t *count, char **error);

int32_t tc_conn_write(tc_handle connection, tc_handle cancellation_token,
    void *buffer, size_t length, size_t *count, char **error);

int32_t tc_conn_close_write(tc_handle connection, tc_handle cancellation_token,
    char **error);

#endif
