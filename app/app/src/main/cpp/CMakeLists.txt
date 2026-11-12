# 只编 JNI 包装；隧道本体是预先编好的 libtailcat.so，随 jniLibs 一起进包。
#
# 包装库对每个 ABI 都编：模拟器是 x86_64，让包装能装进去，P2P 那条路在运行期才报不可用
# （见 tailcat_jni.c 的 dlopen）。libtailcat.so 目前只有 arm64-v8a —— 真机架构；
# 要出别的 ABI 就用 backend/scripts/build-tailcat 交叉编一份放进对应目录。
cmake_minimum_required(VERSION 3.22.1)

project(tailcatjni C)

add_library(tailcatjni SHARED tailcat_jni.c)

# liblog 是 NDK 自带的系统库，用来把失败原因写进 logcat。
find_library(log-lib log)
target_link_libraries(tailcatjni ${log-lib} dl)

# C 源码只用到 JNI 与 libc，不需要 C++ 运行时。
set_target_properties(tailcatjni PROPERTIES C_STANDARD 11)
