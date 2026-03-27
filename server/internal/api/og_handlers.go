package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

type ogData struct {
	URL         string `json:"url"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Image       string `json:"image,omitempty"`
	SiteName    string `json:"site_name,omitempty"`
	VideoEmbed  string `json:"video_embed,omitempty"`
}

var (
	ogCache   = make(map[string]*ogCacheEntry)
	ogCacheMu sync.RWMutex
)

type ogCacheEntry struct {
	data      *ogData
	fetchedAt time.Time
}

const ogCacheTTL = 30 * time.Minute
const ogMaxBodyBytes = 256 * 1024 // only read first 256 KB of HTML

var metaTagRe = regexp.MustCompile(`<meta\s[^>]*>`)
var attrRe = regexp.MustCompile(`(property|name|content)\s*=\s*"([^"]*)"`)

// YouTube URL patterns
var ytLongRe = regexp.MustCompile(`(?:youtube\.com/watch\?.*v=)([\w-]{11})`)
var ytShortRe = regexp.MustCompile(`(?:youtu\.be/)([\w-]{11})`)

func OGHandler() http.HandlerFunc {
	client := &http.Client{
		Timeout: 8 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}

	return func(w http.ResponseWriter, r *http.Request) {
		rawURL := r.URL.Query().Get("url")
		if rawURL == "" {
			http.Error(w, `{"error":"missing url param"}`, http.StatusBadRequest)
			return
		}

		// Validate URL format
		parsed, err := url.Parse(rawURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			http.Error(w, `{"error":"invalid url"}`, http.StatusBadRequest)
			return
		}

		// Block private/internal IPs to prevent SSRF
		host := strings.ToLower(parsed.Hostname())
		if host == "localhost" || host == "127.0.0.1" || host == "::1" ||
			host == "0.0.0.0" || host == "" ||
			strings.HasPrefix(host, "10.") || strings.HasPrefix(host, "192.168.") ||
			strings.HasPrefix(host, "0.") || host == "metadata.google.internal" ||
			strings.HasPrefix(host, "169.254.") ||
			strings.HasPrefix(host, "fc00:") || strings.HasPrefix(host, "fd") ||
			strings.HasPrefix(host, "fe80:") ||
			strings.HasPrefix(host, "[::ffff:") ||
			strings.Contains(host, "[:") {
			http.Error(w, `{"error":"url not allowed"}`, http.StatusBadRequest)
			return
		}
		// Block 172.16.0.0/12
		if strings.HasPrefix(host, "172.") {
			parts := strings.SplitN(host, ".", 4)
			if len(parts) >= 2 {
				var second int
				for _, c := range parts[1] {
					if c >= '0' && c <= '9' {
						second = second*10 + int(c-'0')
					}
				}
				if second >= 16 && second <= 31 {
					http.Error(w, `{"error":"url not allowed"}`, http.StatusBadRequest)
					return
				}
			}
		}

		// Check cache
		ogCacheMu.RLock()
		entry, ok := ogCache[rawURL]
		ogCacheMu.RUnlock()
		if ok && time.Since(entry.fetchedAt) < ogCacheTTL {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(entry.data)
			return
		}

		// Check for YouTube embed
		data := &ogData{URL: rawURL}
		ytID := extractYouTubeID(rawURL)
		if ytID != "" {
			data.VideoEmbed = "https://www.youtube.com/embed/" + ytID
			data.SiteName = "YouTube"
		}

		// Fetch the URL
		req, err := http.NewRequest("GET", rawURL, nil)
		if err != nil {
			writeOGResult(w, data)
			cacheOG(rawURL, data)
			return
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; RelayBot/1.0)")
		req.Header.Set("Accept", "text/html")

		resp, err := client.Do(req)
		if err != nil {
			writeOGResult(w, data)
			cacheOG(rawURL, data)
			return
		}
		defer resp.Body.Close()

		ct := resp.Header.Get("Content-Type")
		if !strings.Contains(ct, "text/html") && !strings.Contains(ct, "application/xhtml") {
			writeOGResult(w, data)
			cacheOG(rawURL, data)
			return
		}

		body, err := io.ReadAll(io.LimitReader(resp.Body, ogMaxBodyBytes))
		if err != nil {
			writeOGResult(w, data)
			cacheOG(rawURL, data)
			return
		}

		html := string(body)
		parseOGMeta(html, data)

		// Fallback: parse <title> tag if no og:title
		if data.Title == "" {
			if idx := strings.Index(html, "<title"); idx >= 0 {
				if end := strings.Index(html[idx:], ">"); end >= 0 {
					rest := html[idx+end+1:]
					if closeIdx := strings.Index(rest, "</title>"); closeIdx >= 0 {
						data.Title = strings.TrimSpace(rest[:closeIdx])
					}
				}
			}
		}

		cacheOG(rawURL, data)
		writeOGResult(w, data)
	}
}

func extractYouTubeID(rawURL string) string {
	if m := ytLongRe.FindStringSubmatch(rawURL); len(m) > 1 {
		return m[1]
	}
	if m := ytShortRe.FindStringSubmatch(rawURL); len(m) > 1 {
		return m[1]
	}
	return ""
}

func parseOGMeta(html string, data *ogData) {
	metas := metaTagRe.FindAllString(html, -1)
	for _, tag := range metas {
		attrs := attrRe.FindAllStringSubmatch(tag, -1)
		propOrName := ""
		content := ""
		for _, a := range attrs {
			switch a[1] {
			case "property", "name":
				propOrName = strings.ToLower(a[2])
			case "content":
				content = a[2]
			}
		}
		if content == "" {
			continue
		}
		switch propOrName {
		case "og:title":
			if data.Title == "" {
				data.Title = content
			}
		case "og:description":
			if data.Description == "" {
				data.Description = content
			}
		case "og:image":
			if data.Image == "" {
				data.Image = content
			}
		case "og:site_name":
			if data.SiteName == "" {
				data.SiteName = content
			}
		case "description":
			if data.Description == "" {
				data.Description = content
			}
		}
	}
}

func cacheOG(rawURL string, data *ogData) {
	ogCacheMu.Lock()
	ogCache[rawURL] = &ogCacheEntry{data: data, fetchedAt: time.Now()}
	// Evict old entries if cache grows too large
	if len(ogCache) > 500 {
		now := time.Now()
		for k, v := range ogCache {
			if now.Sub(v.fetchedAt) > ogCacheTTL {
				delete(ogCache, k)
			}
		}
	}
	ogCacheMu.Unlock()
}

func writeOGResult(w http.ResponseWriter, data *ogData) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}
