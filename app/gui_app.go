package main

import (
	"context"
	"embed"
	"fmt"
	"os"
	"os/exec"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	windowsoptions "github.com/wailsapp/wails/v2/pkg/options/windows"

	"github.com/pixelq/app/internal/config"
)

//go:embed all:frontend/dist
var desktopAssets embed.FS

type DesktopApp struct {
	ctx context.Context
}

func NewDesktopApp() *DesktopApp {
	return &DesktopApp{}
}

func (a *DesktopApp) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *DesktopApp) GetDesktopConfig() map[string]interface{} {
	cfg := config.Get()
	return map[string]interface{}{
		"libraryRoot":    cfg.LibraryRoot,
		"downloadsInbox": cfg.DownloadsInbox,
		"port":           cfg.Port,
		"theme":          cfg.Theme,
		"keepAwake":      cfg.KeepAwake,
		"version":        AppVersion,
		"versionLabel":   AppDisplayVersion,
	}
}

func (a *DesktopApp) OpenPath(path string) error {
	if path == "" {
		return nil
	}
	if _, err := os.Stat(path); err != nil {
		return err
	}
	return exec.Command("explorer.exe", path).Start()
}

func (a *DesktopApp) OpenLibrary() error {
	return a.OpenPath(config.Get().LibraryRoot)
}

func (a *DesktopApp) OpenInbox() error {
	return a.OpenPath(config.Get().DownloadsInbox)
}

func runDesktopApp() error {
	app := NewDesktopApp()

	return wails.Run(&options.App{
		Title:     fmt.Sprintf("PixelQ %s", AppDisplayVersion),
		Width:     1120,
		Height:    760,
		MinWidth:  860,
		MinHeight: 600,
		Frameless: false,
		AssetServer: &assetserver.Options{
			Assets: desktopAssets,
		},
		BackgroundColour: &options.RGBA{R: 0, G: 0, B: 0, A: 0},
		OnStartup:        app.startup,
		Windows: &windowsoptions.Options{
			ZoomFactor:           1.0,
			Theme:                windowsoptions.SystemDefault,
			BackdropType:         windowsoptions.Tabbed,
			WebviewIsTransparent: true,
			WindowIsTranslucent:  true,
			CustomTheme: &windowsoptions.ThemeSettings{
				DarkModeTitleBar:           windowsoptions.RGB(33, 34, 38),
				DarkModeTitleBarInactive:   windowsoptions.RGB(41, 42, 46),
				DarkModeTitleText:          windowsoptions.RGB(245, 245, 245),
				DarkModeTitleTextInactive:  windowsoptions.RGB(168, 168, 170),
				DarkModeBorder:             windowsoptions.RGB(72, 74, 78),
				DarkModeBorderInactive:     windowsoptions.RGB(58, 60, 64),
				LightModeTitleBar:          windowsoptions.RGB(244, 244, 245),
				LightModeTitleBarInactive:  windowsoptions.RGB(236, 236, 238),
				LightModeTitleText:         windowsoptions.RGB(32, 32, 34),
				LightModeTitleTextInactive: windowsoptions.RGB(104, 104, 108),
				LightModeBorder:            windowsoptions.RGB(199, 204, 212),
				LightModeBorderInactive:    windowsoptions.RGB(214, 218, 224),
			},
		},
		Bind: []interface{}{
			app,
		},
	})
}
