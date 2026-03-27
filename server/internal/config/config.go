package config

import (
	"os"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Host         string `yaml:"host"`
	Port         string `yaml:"port"`
	DatabasePath string `yaml:"database_path"`
	JWTSecret    string `yaml:"jwt_secret"`
	UploadDir    string `yaml:"upload_dir"`
	MaxUploadMB  int    `yaml:"max_upload_mb"`
	TLSCert      string `yaml:"tls_cert"`
	TLSKey       string `yaml:"tls_key"`
	StaticDir    string `yaml:"static_dir"`
}

func Load(path string) (*Config, error) {
	cfg := &Config{
		Host:         "0.0.0.0",
		Port:         "8080",
		DatabasePath: "relay.db",
		JWTSecret:    "change-me-in-production",
		UploadDir:    "uploads",
		MaxUploadMB:  50,
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, err
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, err
	}

	return cfg, nil
}
