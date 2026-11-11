package main

import "testing"

// 通道必须都 make 过。
//
// 这不是假想的风险：arrived/failed 一开始是 nil，而 nil 通道上的发送会永久阻塞。
// 表现是「数据早就到了，界面却永远停在正在读对话…」—— 编译过、go vet 过、
// 不报错、不崩，只是永远读不到东西。只有看见画面才会发现。
func TestTheChannelsAreWired(t *testing.T) {
	s := newApp(New("http://127.0.0.1:1", "t", ""))
	if s.arrived == nil {
		t.Fatal("arrived 是 nil：刷新拿到的对话永远送不到界面")
	}
	if s.failed == nil {
		t.Fatal("failed 是 nil：出错信息永远送不到界面")
	}
	if s.tree == nil {
		t.Fatal("tree 是 nil：子代理树永远显示不出来")
	}
	if s.paired == nil {
		t.Fatal("paired 是 nil：配对码永远显示不出来")
	}
	if s.steps == nil {
		t.Fatal("steps 是 nil：工单经过永远显示不出来")
	}
	if s.withdrawn == nil {
		t.Fatal("withdrawn 是 nil：撤回的结果永远送不到界面")
	}
}
