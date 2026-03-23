package main

import (
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/rs/cors"

	"github.com/pixelq/app/internal/api"
	"github.com/pixelq/app/internal/config"
	"github.com/pixelq/app/internal/service"
)

func runServer() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	svc, err := service.New()
	if err != nil {
		log.Fatalf("Failed to initialize service: %v", err)
	}
	defer svc.Stop()
	svc.Start()

	apiHandler := api.New(svc)
	mux := http.NewServeMux()
	apiHandler.RegisterRoutes(mux)

	handler := cors.New(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: true,
	}).Handler(mux)

	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		if errors.Is(err, syscall.EADDRINUSE) {
			log.Fatalf("PixelQ daemon already running on %s", addr)
		}
		log.Fatalf("Failed to listen on %s: %v", addr, err)
	}

	server := &http.Server{Handler: handler}
	log.Printf("PixelQ service on http://%s", addr)

	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	<-done
	log.Println("Shutting down...")
}
