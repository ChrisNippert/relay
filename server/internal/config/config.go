package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
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
			cfg.JWTSecret = generateSecret()
			log.Println("WARNING: No config file found. Generated a random JWT secret for this session. Set jwt_secret in config.yaml for persistence across restarts.")
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
			cfg.JWTSecret = generateSecret()
			log.Println("WARNING: jwt_secret in config is an insecure default. Generated a random secret for this session. Please set a strong jwt_secret in config.yaml.")
			break
		}
	}
	if trimmed == "" {
		cfg.JWTSecret = generateSecret()
		log.Println("WARNING: jwt_secret is empty. Generated a random secret for this session.")
	}

	return cfg, nil
}
