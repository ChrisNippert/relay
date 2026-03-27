package main

import (
	"flag"
	"log"
	"net/http"
	"time"

	"github.com/relay-chat/relay/internal/api"
	"github.com/relay-chat/relay/internal/config"
	"github.com/relay-chat/relay/internal/db"
	"github.com/relay-chat/relay/internal/ws"
)

func main() {
	configPath := flag.String("config", "config.yaml", "path to config file")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	database, err := db.New(cfg.DatabasePath)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer database.Close()

	// Periodically clean up expired revoked tokens
	go func() {
		for {
			time.Sleep(1 * time.Hour)
			if err := database.CleanExpiredTokens(); err != nil {
				log.Printf("Failed to clean expired tokens: %v", err)
			}
		}
	}()

	hub := ws.NewHub(database)
	go hub.Run()

	router := api.NewRouter(cfg, database, hub)

	addr := cfg.Host + ":" + cfg.Port
	if cfg.TLSCert != "" && cfg.TLSKey != "" {
		log.Printf("Relay server listening on %s (HTTPS)", addr)
		if err := http.ListenAndServeTLS(addr, cfg.TLSCert, cfg.TLSKey, router); err != nil {
			log.Fatalf("Server failed: %v", err)
		}
	} else {
		log.Printf("Relay server listening on %s (HTTP)", addr)
		if err := http.ListenAndServe(addr, router); err != nil {
			log.Fatalf("Server failed: %v", err)
		}
	}
}
