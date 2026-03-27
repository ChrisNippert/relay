package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Host           string   `yaml:"host"`
	Port           string   `yaml:"port"`
	DatabasePath   string   `yaml:"database_path"`
	JWTSecret      string   `yaml:"jwt_secret"`
	UploadDir      string   `yaml:"upload_dir"`
	MaxUploadMB    int      `yaml:"max_upload_mb"`
	TLSCert        string   `yaml:"tls_cert"`
	TLSKey         string   `yaml:"tls_key"`
	StaticDir      string   `yaml:"static_dir"`
	AllowedOrigins []string `yaml:"allowed_origins"`
}

var insecureDefaults = []string{
	"change-me-in-production",
	"change-me-in-production-use-a-random-string",
}

func generateSecret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("failed to generate random secret: %v", err))
	}
	return hex.EncodeToString(b)
}

func Load(path string) (*Config, error) {
	cfg := &Config{
		Host:         "0.0.0.0",
		Port:         "8080",
		DatabasePath: "relay.db",
		JWTSecret:    "",
		UploadDir:    "uploads",
		MaxUploadMB:  50,
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			cfg.JWTSecret = loadOrGenerateSecret(path)
			return cfg, nil
		}
		return nil, err
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, err
	}

	// Reject insecure default secrets
	trimmed := strings.TrimSpace(cfg.JWTSecret)
	for _, bad := range insecureDefaults {
		if trimmed == bad {
			cfg.JWTSecret = loadOrGenerateSecret(path)
			log.Println("WARNING: jwt_secret in config is an insecure default. Please set a strong jwt_secret in config.yaml.")
			break
		}
	}
	if trimmed == "" {
		cfg.JWTSecret = loadOrGenerateSecret(path)
	}

	return cfg, nil
}

// loadOrGenerateSecret reads a persisted secret from .jwt_secret next to the
// config file, or generates a new one and saves it so tokens survive restarts.
func loadOrGenerateSecret(configPath string) string {
	secretPath := filepath.Join(filepath.Dir(configPath), ".jwt_secret")

	if data, err := os.ReadFile(secretPath); err == nil {
		if s := strings.TrimSpace(string(data)); s != "" {
			log.Println("INFO: Using persisted JWT secret from", secretPath)
			return s
		}
	}

	secret := generateSecret()
	if err := os.WriteFile(secretPath, []byte(secret+"\n"), 0600); err != nil {
		log.Printf("WARNING: Could not persist JWT secret to %s: %v (secret will be lost on restart)", secretPath, err)
	} else {
		log.Printf("INFO: Generated and saved JWT secret to %s", secretPath)
	}
	return secret
}
