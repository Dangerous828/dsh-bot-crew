package main

import "testing"

// 后端 work 端点只发 said / did / checked（backend/src/app/work.ts:16）。
// 三种都要在点的颜色上分得开；全落到默认最弱那一档等于没画种类。
func TestWorkDotUsesBackendStepKinds(t *testing.T) {
	for name, p := range map[string]Palette{"light": LightPalette, "dark": DarkPalette} {
		t.Run(name, func(t *testing.T) {
			did := workDot("did", p)
			said := workDot("said", p)
			checked := workDot("checked", p)
			if did == p.Faint || said == p.Faint || checked == p.Faint {
				t.Fatalf("真实 kind 落到了默认色：did=%v said=%v checked=%v faint=%v", did, said, checked, p.Faint)
			}
			if did == said || did == checked || said == checked {
				t.Fatalf("三种 kind 没区分开：did=%v said=%v checked=%v", did, said, checked)
			}
		})
	}
}

// 旧的那组 tool / error / say 不是后端契约，认不出来就留最弱一档，别假装认得。
func TestWorkDotLeavesUnknownKindsFaint(t *testing.T) {
	p := LightPalette
	for _, kind := range []string{"tool", "error", "say", "", "whatever"} {
		if got := workDot(kind, p); got != p.Faint {
			t.Errorf("未知 kind %q = %v，应落 %v", kind, got, p.Faint)
		}
	}
}
