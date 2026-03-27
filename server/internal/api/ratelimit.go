package api

import (
	"net/http"
	"sync"
	"time"
)

// rateLimiter is a simple per-IP sliding window rate limiter.
type rateLimiter struct {
	mu       sync.Mutex
	visitors map[string]*visitorEntry
	limit    int
	window   time.Duration
}

type visitorEntry struct {
	timestamps []time.Time
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	rl := &rateLimiter{
		visitors: make(map[string]*visitorEntry),
		limit:    limit,
		window:   window,
	}
	// Periodically clean up expired entries
	go func() {
		for {
			time.Sleep(window)
			rl.cleanup()
		}
	}()
	return rl
}

func (rl *rateLimiter) cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	for ip, v := range rl.visitors {
		cutoff := now.Add(-rl.window)
		remaining := v.timestamps[:0]
		for _, t := range v.timestamps {
			if t.After(cutoff) {
				remaining = append(remaining, t)
			}
		}
		if len(remaining) == 0 {
			delete(rl.visitors, ip)
		} else {
			v.timestamps = remaining
		}
	}
}

func (rl *rateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-rl.window)

	v, ok := rl.visitors[ip]
	if !ok {
		rl.visitors[ip] = &visitorEntry{timestamps: []time.Time{now}}
		return true
	}

	// Trim expired timestamps
	remaining := v.timestamps[:0]
	for _, t := range v.timestamps {
		if t.After(cutoff) {
			remaining = append(remaining, t)
		}
	}
	v.timestamps = remaining

	if len(v.timestamps) >= rl.limit {
		return false
	}

	v.timestamps = append(v.timestamps, now)
	return true
}

// RateLimitMiddleware returns middleware that rate limits requests by IP.
func RateLimitMiddleware(limit int, window time.Duration) func(http.Handler) http.Handler {
	rl := newRateLimiter(limit, window)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := r.RemoteAddr
			if forwarded := r.Header.Get("X-Real-Ip"); forwarded != "" {
				ip = forwarded
			}
			if !rl.allow(ip) {
				http.Error(w, `{"error":"too many requests"}`, http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RateLimitHandler wraps a single handler with per-IP rate limiting.
func RateLimitHandler(limit int, window time.Duration, handler http.HandlerFunc) http.HandlerFunc {
	rl := newRateLimiter(limit, window)
	return func(w http.ResponseWriter, r *http.Request) {
		ip := r.RemoteAddr
		if forwarded := r.Header.Get("X-Real-Ip"); forwarded != "" {
			ip = forwarded
		}
		if !rl.allow(ip) {
			http.Error(w, `{"error":"too many requests"}`, http.StatusTooManyRequests)
			return
		}
		handler(w, r)
	}
}
