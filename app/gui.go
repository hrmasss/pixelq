package main

import "log"

func runGUI() {
	if err := ensureDaemonRunning(true); err != nil {
		log.Fatalf("Failed to start PixelQ daemon: %v", err)
	}
	if err := runDesktopApp(); err != nil {
		log.Fatalf("Failed to launch PixelQ desktop: %v", err)
	}
}
