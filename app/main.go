package main

import (
	"fmt"
	"os"
)

func main() {
	// Default to GUI when double-clicked (no args)
	if len(os.Args) < 2 {
		runGUI()
		return
	}

	switch os.Args[1] {
	case "gui":
		runGUI()
	case "serve":
		runServer()
	case "mcp":
		runMCP()
	case "help", "-h", "--help":
		printUsage()
	default:
		fmt.Printf("Unknown command: %s\n", os.Args[1])
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Printf(`PixelQ %s - Automated ChatGPT Image Generation

Usage:
  pixelq [command]

Commands:
  (none)  Launch the desktop GUI application (default when double-clicking)
  gui     Launch the desktop GUI application (Wails)
  serve   Run the background service only (API + WebSocket)
  mcp     Run as MCP server on stdio

Examples:
  pixelq                  # Open the desktop app
  pixelq gui              # Open the desktop app
  pixelq serve            # Run headless service
  pixelq mcp              # Run MCP server for Claude integration
`, AppDisplayVersion)
}
