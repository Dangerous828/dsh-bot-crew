package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// timelineJSON is a slice of what the message surface actually returns, captured from the gateway: two people's
// messages and one Bot reply, plus a field this client does not know about.
const timelineJSON = `{
  "items": [
    {"id": "m1", "role": "user", "text": "@写手 你好", "at": "2026-11-09T11:47:23.000Z", "request_id": "r-1"},
    {"id": "r1", "role": "agent", "bot_id": "scribbler", "text": "在的", "at": "2026-11-09T11:47:31.000Z"},
    {"id": "m2", "role": "user", "text": "还有人吗", "at": "2026-11-09T11:48:02.000Z", "future_field": {"n": 1}}
  ],
  "bots": [
    {"id": "lead", "name": "大哥", "role": "default"},
    {"id": "scribbler", "name": "写手", "role": "member", "persona": "负责文案"}
  ],
  "default_bot_id": "lead",
  "tasks": [],
  "status": {"runtime": "ready", "mobile": "on", "paused": false}
}`

func serve(t *testing.T, body string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-GW-Token"); got != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path != "/timeline" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server
}

func TestTimelineReadsBothSidesOfTheConversation(t *testing.T) {
	server := serve(t, timelineJSON)
	client := New(server.URL, "secret")

	conversation, err := client.Timeline(context.Background())
	if err != nil {
		t.Fatalf("Timeline returned an error: %v", err)
	}
	if len(conversation.Messages) != 3 {
		t.Fatalf("got %d messages, want 3", len(conversation.Messages))
	}
	if conversation.Messages[0].Role != "user" || conversation.Messages[0].Text != "@写手 你好" {
		t.Errorf("first message = %+v, want a person's message", conversation.Messages[0])
	}
	reply := conversation.Messages[1]
	if reply.Role != "agent" || reply.BotID != "scribbler" || reply.Text != "在的" {
		t.Errorf("reply = %+v, want the scribbler's answer", reply)
	}
	if len(conversation.Bots) != 2 || conversation.Bots[1].Persona != "负责文案" {
		t.Errorf("bots = %+v, want both cards with their persona", conversation.Bots)
	}
	if conversation.DefaultBotID != "lead" {
		t.Errorf("default bot = %q, want lead", conversation.DefaultBotID)
	}
}

func TestTimelineRejectsAWrongToken(t *testing.T) {
	server := serve(t, timelineJSON)
	client := New(server.URL, "wrong")

	if _, err := client.Timeline(context.Background()); err == nil {
		t.Fatal("Timeline accepted a request the surface refused")
	}
}

// A field the client does not know must survive a read and a write back out, so a newer backend can add one without
// this build dropping it.
func TestUnknownMessageFieldsSurvive(t *testing.T) {
	server := serve(t, timelineJSON)
	conversation, err := New(server.URL, "secret").Timeline(context.Background())
	if err != nil {
		t.Fatalf("Timeline returned an error: %v", err)
	}
	raw, err := json.Marshal(conversation.Messages[2])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back map[string]any
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := back["future_field"]; !ok {
		t.Errorf("message lost the field it did not know: %s", raw)
	}
}

// A retry has to arrive as the same send, or the conversation shows the message twice.
func TestRetryReusesTheRequestID(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ RequestID string `json:"request_id"` }
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		seen = append(seen, body.RequestID)
		if len(seen) == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"ok": true}`))
	}))
	t.Cleanup(server.Close)

	client := New(server.URL, "secret")
	requestID, err := client.Send(context.Background(), "在吗", nil)
	if err == nil {
		t.Fatal("Send reported success on a 502")
	}
	if requestID == "" {
		t.Fatal("Send returned no request id, so a retry has nothing to reuse")
	}
	if err := client.SendAgain(context.Background(), requestID, "在吗", nil); err != nil {
		t.Fatalf("SendAgain: %v", err)
	}
	if len(seen) != 2 || seen[0] != seen[1] {
		t.Fatalf("request ids = %v, want the same value twice", seen)
	}
}
