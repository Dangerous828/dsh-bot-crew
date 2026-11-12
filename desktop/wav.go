// 把录音整理成后端 voice.ts 收的那一种：16kHz / 单声道 / 16 位 PCM，标准 44 字节 WAV 头。
// AVAudioRecorder 已经按这个规格录，但系统写出的头可能带额外 chunk、声道/采样率也可能跟着设备走；
// 交给识别器之前统一一遍，才不会让一段能录不能认的音频变成「没听出字来」。
package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

const (
	voiceSampleRate = 16000
	// 与 backend/src/app/voice.ts 的 MAX_SECONDS / MAX_WAV_BYTES 对齐。
	maxVoiceSeconds = 120
	maxVoiceBytes   = 8 * 1024 * 1024
)

type pcmInfo struct {
	sampleRate int
	channels   int
	bits       int
	data       []byte
}

// readPCM 从 WAV 里取 fmt 与 data。只认整数 PCM：压缩或浮点格式不猜。
func readPCM(raw []byte) (pcmInfo, error) {
	var info pcmInfo
	if !isWav(raw) {
		return info, errors.New("录出来的不是 WAV（缺 RIFF/WAVE 头）")
	}
	at := 12
	foundFmt := false
	for at+8 <= len(raw) {
		id := string(raw[at : at+4])
		size := int(binary.LittleEndian.Uint32(raw[at+4 : at+8]))
		body := at + 8
		if size < 0 || body > len(raw) {
			break
		}
		end := body + size
		if end > len(raw) {
			end = len(raw)
		}
		switch id {
		case "fmt ":
			if size < 16 {
				return info, errors.New("WAV 的 fmt 块太短")
			}
			format := int(binary.LittleEndian.Uint16(raw[body : body+2]))
			info.channels = int(binary.LittleEndian.Uint16(raw[body+2 : body+4]))
			info.sampleRate = int(binary.LittleEndian.Uint32(raw[body+4 : body+8]))
			info.bits = int(binary.LittleEndian.Uint16(raw[body+14 : body+16]))
			if format != 1 {
				return info, fmt.Errorf("录音是格式 %d（不是整数 PCM），后端只收 PCM WAV", format)
			}
			foundFmt = true
		case "data":
			info.data = raw[body:end]
		}
		at = body + size + (size % 2)
	}
	if !foundFmt {
		return info, errors.New("WAV 里没有 fmt 块")
	}
	if info.channels < 1 || info.channels > 8 || info.sampleRate <= 0 || info.bits != 16 {
		return info, fmt.Errorf("录音规格不是 16 位 PCM（%d 声道 / %d Hz / %d 位）", info.channels, info.sampleRate, info.bits)
	}
	if len(info.data) < 2 {
		return info, errors.New("录音里没有声音数据")
	}
	return info, nil
}

// normalizeVoiceWav 混成单声道、重采样到 16kHz、重写标准 WAV 头。
// 过大、过长、格式不对的录音在这里就被拦下，不白跑一次识别。
func normalizeVoiceWav(raw []byte) ([]byte, error) {
	if len(raw) > maxVoiceBytes {
		return nil, fmt.Errorf("录音 %d KB，一次最多 %d MB", len(raw)/1024, maxVoiceBytes/1024/1024)
	}
	info, err := readPCM(raw)
	if err != nil {
		return nil, err
	}
	mono := pcm16Mono(info.data, info.channels)
	seconds := float64(len(mono)) / float64(info.sampleRate)
	if seconds > maxVoiceSeconds {
		return nil, fmt.Errorf("录音约 %d 秒，一次最多 %d 秒", int(math.Ceil(seconds)), maxVoiceSeconds)
	}
	out := encodeWav(resample16(mono, info.sampleRate, voiceSampleRate))
	if len(out) > maxVoiceBytes {
		return nil, fmt.Errorf("整理后的录音 %d KB，超过后端一次 %d MB 的上限", len(out)/1024, maxVoiceBytes/1024/1024)
	}
	return out, nil
}

func pcm16Mono(data []byte, channels int) []int16 {
	frames := len(data) / (2 * channels)
	out := make([]int16, frames)
	for i := 0; i < frames; i++ {
		var sum int32
		for ch := 0; ch < channels; ch++ {
			at := (i*channels + ch) * 2
			if at+2 > len(data) {
				break
			}
			sum += int32(int16(binary.LittleEndian.Uint16(data[at : at+2])))
		}
		out[i] = int16(sum / int32(channels))
	}
	return out
}

func resample16(in []int16, from, to int) []int16 {
	if from == to || len(in) == 0 {
		return in
	}
	count := int(math.Round(float64(len(in)) * float64(to) / float64(from)))
	if count < 1 {
		count = 1
	}
	out := make([]int16, count)
	for i := 0; i < count; i++ {
		position := float64(i) * float64(from) / float64(to)
		left := int(position)
		if left >= len(in)-1 {
			out[i] = in[len(in)-1]
			continue
		}
		fraction := position - float64(left)
		out[i] = int16(float64(in[left])*(1-fraction) + float64(in[left+1])*fraction)
	}
	return out
}

func encodeWav(samples []int16) []byte {
	out := make([]byte, 44+len(samples)*2)
	copy(out[0:4], "RIFF")
	binary.LittleEndian.PutUint32(out[4:8], uint32(36+len(samples)*2))
	copy(out[8:12], "WAVE")
	copy(out[12:16], "fmt ")
	binary.LittleEndian.PutUint32(out[16:20], 16)
	binary.LittleEndian.PutUint16(out[20:22], 1) // PCM
	binary.LittleEndian.PutUint16(out[22:24], 1) // mono
	binary.LittleEndian.PutUint32(out[24:28], voiceSampleRate)
	binary.LittleEndian.PutUint32(out[28:32], voiceSampleRate*2)
	binary.LittleEndian.PutUint16(out[32:34], 2)
	binary.LittleEndian.PutUint16(out[34:36], 16)
	copy(out[36:40], "data")
	binary.LittleEndian.PutUint32(out[40:44], uint32(len(samples)*2))
	for i, sample := range samples {
		binary.LittleEndian.PutUint16(out[44+i*2:46+i*2], uint16(sample))
	}
	return out
}
