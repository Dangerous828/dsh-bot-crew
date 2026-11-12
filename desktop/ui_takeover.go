package main

import (
	"context"
	"strings"
	"time"
)

// takeoverTask 接手一张工单。没有在跑的票时如实说没活儿，不调接口、不冒充接手。
// 回执严格按 mobile-http.ts:640-649 的 {ok, stopped} 展示。
func (s *app) takeoverTask(task Task) {
	a := s.actions
	if a == nil || strings.TrimSpace(task.ID) == "" {
		return
	}
	if !task.Open {
		a.takeoverNote[task.ID] = "这张票已经结束，没有可接手的活儿"
		return
	}
	if s.client == nil {
		a.takeoverNote[task.ID] = "还没连上队伍，接不了工单"
		return
	}
	if a.takeoverBusy[task.ID] {
		return
	}
	a.takeoverBusy[task.ID] = true
	a.takeoverNote[task.ID] = "正在接手…"
	id := task.ID
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		ack, err := s.client.Takeover(ctx, id)
		s.deliver(actionResult{
			kind: "takeover", name: id,
			note: takeoverNote(ack, err),
			ok:   takeoverOK(ack, err),
		})
	}()
}
