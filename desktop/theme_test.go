package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

// The palette the design boards use. A test that only checked the struct existed would prove nothing, so these
// check the two properties the boards actually rely on: light and dark differ where it matters, and every token
// is set in both.
func TestLightAndDarkAreBothComplete(t *testing.T) {
	for name, palette := range map[string]Palette{"light": LightPalette, "dark": DarkPalette} {
		empty := ui.Color{}
		if palette.Surface == empty || palette.Card == empty || palette.Ink == empty || palette.Muted == empty ||
			palette.Accent == empty || palette.AccentInk == empty || palette.Line == empty || palette.Warn == empty ||
			palette.Danger == empty || palette.UserBubble == empty || palette.UserInk == empty {
			t.Errorf("%s palette has an empty token: %+v", name, palette)
		}
	}
}

func TestTheTwoThemesDifferWhereItMatters(t *testing.T) {
	// A dark theme whose surface is the light theme's surface is a bug nobody notices until they switch.
	if LightPalette.Surface == DarkPalette.Surface {
		t.Error("light and dark share a surface colour")
	}
	if LightPalette.Ink == DarkPalette.Ink {
		t.Error("light and dark share an ink colour")
	}
	// Contrast direction: dark ink on a light surface, light ink on a dark surface.
	if LightPalette.Ink == LightPalette.Surface || DarkPalette.Ink == DarkPalette.Surface {
		t.Error("a palette draws its text in its own background colour")
	}
	if LightPalette.Accent == DarkPalette.Accent {
		t.Error("the accent must be lifted for the dark surface or it disappears into it")
	}
}

func TestPaletteForFollowsTheSystemSetting(t *testing.T) {
	// The argument is "is the system dark", so true must hand back the dark palette.
	if PaletteFor(true) != DarkPalette {
		t.Error("a dark system got the light palette")
	}
	if PaletteFor(false) != LightPalette {
		t.Error("a light system got the dark palette")
	}
}
