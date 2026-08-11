// Readerr sync backend.
//
// Single-user, self-hosted, no auth. The client (frontend/) is local-first;
// this server is a sync target: POST /sync/push (LWW on updated_at, stamps
// server_seq from one global counter), GET /sync/pull?since=<server_seq>,
// GET /sync/stats and POST /sync/reset (the Settings sync card), GET
// /healthz, GET /backup (sqlite file), GET /dbsize (on-disk size for the
// stats page), plus optional static serving of the built frontend so
// everything runs on one origin. GET /title is the one deliberate extension
// beyond sync: it fetches a page title server-side because browsers can't
// (CORS).
package main

import (
	"compress/gzip"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

type gzipResponseWriter struct {
	io.Writer
	http.ResponseWriter
}

func (w gzipResponseWriter) Write(b []byte) (int, error) { return w.Writer.Write(b) }

// withGzip compresses the response when the client accepts it. Applied to
// /sync/pull only — its JSON bodies compress ~8:1, while
// /backup goes through http.ServeFile, whose Content-Length and range
// handling don't mix with on-the-fly compression.
func withGzip(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		defer gz.Close()
		next.ServeHTTP(gzipResponseWriter{Writer: gz, ResponseWriter: w}, r)
	})
}

// Permissive CORS so a separately-hosted frontend (or dev server) can sync.
// Fine for a single-user LAN app; tighten if ever exposed publicly.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	dbPath := envOr("DB_PATH", "readerr.db")
	db, err := openDB(dbPath)
	if err != nil {
		slog.Error("open database", "path", dbPath, "error", err)
		os.Exit(1)
	}
	defer db.Close()

	srv := &server{db: db, dbPath: dbPath}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("POST /sync/push", srv.handlePush)
	mux.Handle("GET /sync/pull", withGzip(http.HandlerFunc(srv.handlePull)))
	mux.HandleFunc("GET /sync/stats", srv.handleSyncStats)
	mux.HandleFunc("POST /sync/reset", srv.handleSyncReset)
	mux.HandleFunc("GET /backup", srv.handleBackup)
	mux.HandleFunc("GET /title", srv.handleTitle)
	// On-disk database size (main file + WAL), for the client's stats page.
	mux.HandleFunc("GET /dbsize", func(w http.ResponseWriter, r *http.Request) {
		var total int64
		for _, p := range []string{dbPath, dbPath + "-wal"} {
			if fi, err := os.Stat(p); err == nil {
				total += fi.Size()
			}
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"bytes":%d}`, total)
	})

	if staticDir := envOr("STATIC_DIR", ""); staticDir != "" {
		if _, err := os.Stat(staticDir); err == nil {
			mux.Handle("/", http.FileServer(http.Dir(staticDir)))
			slog.Info("serving static frontend", "dir", staticDir)
		} else {
			slog.Warn("STATIC_DIR not found, skipping static serving", "dir", staticDir)
		}
	}

	addr := ":" + envOr("PORT", "8080")
	slog.Info("readerr backend listening", "addr", addr, "db", dbPath)
	if err := http.ListenAndServe(addr, withCORS(mux)); err != nil {
		slog.Error("server exited", "error", err)
		os.Exit(1)
	}
}
