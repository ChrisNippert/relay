package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/relay-chat/relay/internal/auth"
	"github.com/relay-chat/relay/internal/config"
)

type contextKey string

const userIDKey contextKey = "userID"

func AuthMiddleware(cfg *config.Config) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			if header == "" {
				http.Error(w, `{"error":"missing authorization header"}`, http.StatusUnauthorized)
				return
			}

			parts := strings.SplitN(header, " ", 2)
			if len(parts) != 2 || parts[0] != "Bearer" {
				http.Error(w, `{"error":"invalid authorization format"}`, http.StatusUnauthorized)
				return
			}

			claims, err := auth.ValidateToken(parts[1], cfg.JWTSecret)
			if err != nil {
				http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), userIDKey, claims.UserID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func GetUserID(r *http.Request) string {
	if id, ok := r.Context().Value(userIDKey).(string); ok {
		return id
	}
	return ""
}
