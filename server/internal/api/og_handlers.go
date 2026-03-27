package api

import (
	"context"
	"encoding/json"
	"io"
	"net"
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
const ogMaxCacheSize = 1000       // maximum cache entries to prevent memory exhaustion

var metaTagRe = regexp.MustCompile(`<meta\s[^>]*>`)
var attrRe = regexp.MustCompile(`(property|name|content)\s*=\s*"([^"]*)"`)

// YouTube URL patterns
var ytLongRe = regexp.MustCompile(`(?:youtube\.com/watch\?.*v=)([\w-]{11})`)
var ytShortRe = regexp.MustCompile(`(?:youtu\.be/)([\w-]{11})`)

func OGHandler() http.HandlerFunc {
	// Custom dialer that validates resolved IPs to prevent SSRF via DNS rebinding
	safeDialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			// Resolve the hostname
			ips, err := net.LookupIP(host)
			if err != nil {
				return nil, err
			}
			// Check ALL resolved IPs — block if any is private/internal
			for _, ip := range ips {
				if isPrivateIP(ip) {
					return nil, &net.OpError{Op: "dial", Err: &net.AddrError{Err: "private IP blocked", Addr: ip.String()}}
				}
			}
			// Connect to the first non-private IP
			return safeDialer.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
		},
	}

	client := &http.Client{
		Timeout:   8 * time.Second,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return http.ErrUseLastResponse
			}
			// Re-validate the redirect target hostname
			host := req.URL.Hostname()
			if isBlockedHostname(host) {
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

		// Block obviously private/internal hostnames before DNS resolution
		host := parsed.Hostname()
		if isBlockedHostname(host) {
			http.Error(w, `{"error":"url not allowed"}`, http.StatusBadRequest)
			return
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
	if len(ogCache) > ogMaxCacheSize {
		now := time.Now()
		for k, v := range ogCache {
			if now.Sub(v.fetchedAt) > ogCacheTTL {
				delete(ogCache, k)
			}
		}
		// If still over limit after TTL eviction, drop oldest entries
		if len(ogCache) > ogMaxCacheSize {
			for k := range ogCache {
				delete(ogCache, k)
				if len(ogCache) <= ogMaxCacheSize/2 {
					break
				}
			}
		}
	}
	ogCacheMu.Unlock()
}

func writeOGResult(w http.ResponseWriter, data *ogData) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

// isPrivateIP checks if an IP address is in a private, loopback, link-local, or otherwise internal range.
func isPrivateIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() || ip.IsMulticast() {
		return true
	}
	// Block IPv4-mapped IPv6 addresses that wrap private IPs (e.g. ::ffff:127.0.0.1)
	if ip4 := ip.To4(); ip4 != nil {
		return ip4.IsLoopback() || ip4.IsPrivate() || ip4.IsLinkLocalUnicast() || ip4.IsUnspecified()
	}
	// Block 100.64.0.0/10 (Carrier-Grade NAT / CGNAT)
	if ip4 := ip.To4(); ip4 != nil && ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127 {
		return true
	}
	// Block 169.254.169.254 (cloud metadata)
	if ip.Equal(net.ParseIP("169.254.169.254")) {
		return true
	}
	return false
}

// isBlockedHostname does a fast pre-DNS check on the raw hostname string.
func isBlockedHostname(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" || h == "localhost" || h == "metadata.google.internal" {
		return true
	}
	// Raw IP literals
	if ip := net.ParseIP(h); ip != nil {
		return isPrivateIP(ip)
	}
	// Bracketed IPv6
	if strings.HasPrefix(h, "[") {
		trimmed := strings.Trim(h, "[]")
		if ip := net.ParseIP(trimmed); ip != nil {
			return isPrivateIP(ip)
		}
	}
	return false
}
