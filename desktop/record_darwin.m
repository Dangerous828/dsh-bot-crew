#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#include <string.h>

// 单例录音器：Go 侧用 micSession 的锁串行访问，这里不再自己加锁。
static char g_error[512];
static AVAudioRecorder *g_recorder = nil;

static void crew_set_error(NSString *message) {
    const char *text = message ? [message UTF8String] : NULL;
    if (!text) text = "unknown recorder error";
    strncpy(g_error, text, sizeof(g_error) - 1);
    g_error[sizeof(g_error) - 1] = '\0';
}

const char *crew_last_error(void) { return g_error; }

// 0 未决定 / 1 受限 / 2 拒绝 / 3 已授权，与 Go 侧 micNotDetermined..micGranted 对齐。
static int crew_auth_status(void) {
    if (@available(macOS 10.14, *)) {
        AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
        switch (status) {
            case AVAuthorizationStatusNotDetermined: return 0;
            case AVAuthorizationStatusRestricted: return 1;
            case AVAuthorizationStatusDenied: return 2;
            case AVAuthorizationStatusAuthorized: return 3;
        }
    }
    return 3; // 旧系统没有这套 TCC 查询，交给 record 自己报
}

int crew_mic_status(void) { return crew_auth_status(); }

// 同步等系统的权限回话。不用 dispatch semaphore：这里没开 ARC，NSCondition 更直白。
int crew_mic_request(void) {
    if (@available(macOS 10.14, *)) {
        __block int grantedStatus = -2; // 每次请求独立，迟到的权限回调不影响下一次请求。
        NSCondition *condition = [[NSCondition alloc] init];
        [condition lock];
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
            [condition lock];
            grantedStatus = granted ? 1 : 0;
            [condition signal];
            [condition unlock];
        }];
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:60];
        while (grantedStatus == -2 && [deadline timeIntervalSinceNow] > 0) {
            [condition waitUntilDate:deadline];
        }
        [condition unlock];
        [condition release];
        if (grantedStatus == 1) return 3;
        if (grantedStatus == 0) return 2;
        return -1; // 60 秒没等到回话，如实说查不出来
    } else {
        return 3;
    }
}

// 16kHz / 单声道 / 16 位线性 PCM，写到 path 指的那个 .wav。
int crew_record_start(const char *path) {
    @autoreleasepool {
        if (g_recorder) { crew_set_error(@"上一次录音还没结束"); return 0; }
        g_error[0] = '\0';
        NSString *target = path ? [NSString stringWithUTF8String:path] : nil;
        if (!target) { crew_set_error(@"录音路径不合法"); return 0; }
        NSURL *url = [NSURL fileURLWithPath:target];
        NSDictionary *settings = [NSDictionary dictionaryWithObjectsAndKeys:
            [NSNumber numberWithUnsignedInt:kAudioFormatLinearPCM], AVFormatIDKey,
            [NSNumber numberWithFloat:16000.0f], AVSampleRateKey,
            [NSNumber numberWithUnsignedInt:1], AVNumberOfChannelsKey,
            [NSNumber numberWithUnsignedInt:16], AVLinearPCMBitDepthKey,
            [NSNumber numberWithBool:NO], AVLinearPCMIsFloatKey,
            [NSNumber numberWithBool:NO], AVLinearPCMIsBigEndianKey,
            nil];
        NSError *error = nil;
        AVAudioRecorder *recorder = [[AVAudioRecorder alloc] initWithURL:url settings:settings error:&error];
        if (!recorder) {
            crew_set_error([NSString stringWithFormat:@"建不起录音器：%@", error ? [error localizedDescription] : @"未知原因"]);
            return 0;
        }
        if (![recorder prepareToRecord] || ![recorder record]) {
            crew_set_error([NSString stringWithFormat:@"开不了麦克风：%@", error ? [error localizedDescription] : @"系统没有给出原因（可能没给麦克风权限）"]);
            [recorder release];
            return 0;
        }
        g_recorder = [recorder retain];
        [recorder release];
        return 1;
    }
}

// stop 会把 WAV 落盘；之后 Go 侧读文件、删临时文件。
int crew_record_stop(void) {
    @autoreleasepool {
        g_error[0] = '\0';
        if (!g_recorder) { crew_set_error(@"录音已经结束"); return 0; }
        [g_recorder stop];
        [g_recorder release];
        g_recorder = nil;
        return 1;
    }
}

// 取消：停止、删掉没交出去的录音、释放录音器，一个都不留。
void crew_record_cancel(void) {
    @autoreleasepool {
        if (!g_recorder) return;
        [g_recorder stop];
        [g_recorder deleteRecording];
        [g_recorder release];
        g_recorder = nil;
    }
}
