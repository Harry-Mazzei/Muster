package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const version = "1.1.0"

//go:embed web
var webFS embed.FS

var logger = log.New(os.Stdout, "", log.LstdFlags)

func logf(format string, a ...any) { logger.Printf(format, a...) }

func main() {
	port := flag.Int("port", 8765, "first port to try")
	rootFlag := flag.String("root", "", "Muster folder (contains music/ and data/)")
	noBrowser := flag.Bool("no-browser", false, "do not open the browser")
	flag.Parse()

	root := *rootFlag
	if root == "" {
		exe, err := os.Executable()
		if err == nil {
			exe, _ = filepath.EvalSymlinks(exe)
			root = filepath.Dir(exe)
			if filepath.Base(root) == "bin" {
				root = filepath.Dir(root)
			}
		} else {
			root, _ = os.Getwd()
		}
	}

	if lf, err := os.OpenFile(filepath.Join(root, "data", "muster.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
		if st, _ := lf.Stat(); st != nil && st.Size() > 1<<20 {
			lf.Truncate(0)
		}
		logger.SetOutput(io.MultiWriter(os.Stdout, lf))
	}

	fmt.Println("==============================================")
	fmt.Println("  MUSTER  -  parade music console  v" + version)
	fmt.Println("==============================================")

	store, err := NewStore(root)
	if err != nil {
		fail("Could not start: %v", err)
	}

	ln, url, err := listen(*port)
	if err != nil {
		if url != "" { // Muster is already running: just show it
			fmt.Println("Muster is already running. Opening it in your browser.")
			openBrowser(url)
			time.Sleep(time.Second)
			return
		}
		fail("Could not open a local port: %v", err)
	}

	quit := make(chan struct{}, 1)
	srv := &http.Server{Handler: newAPI(store, ln.Addr().(*net.TCPAddr).Port, quit), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Hour}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fail("Server stopped: %v", err)
		}
	}()
	logf("Music folder: %s (%d tracks)", store.musicDir, len(store.Library()))
	logf("Running at %s", url)
	fmt.Println("\nKeep this window open while you use Muster.")
	fmt.Println("To quit: close this window, or use Settings > Quit Muster.")
	if !*noBrowser {
		openBrowser(url)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	select {
	case <-sig:
	case <-quit:
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	logf("Muster closed.")
}

func fail(format string, a ...any) {
	logf("ERROR: "+format, a...)
	fmt.Println("\nPress Enter to close.")
	fmt.Scanln()
	os.Exit(1)
}

// listen binds to 127.0.0.1 only. If the first port is taken by another Muster,
// it returns that URL with an error so the caller can just open it.
func listen(first int) (net.Listener, string, error) {
	var lastErr error
	for p := first; p < first+10; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			return ln, fmt.Sprintf("http://localhost:%d/", p), nil
		}
		lastErr = err
		url := fmt.Sprintf("http://localhost:%d/", p)
		c := http.Client{Timeout: 700 * time.Millisecond}
		if r, err := c.Get(url + "api/health"); err == nil {
			b, _ := io.ReadAll(r.Body)
			r.Body.Close()
			if strings.Contains(string(b), `"muster"`) {
				return nil, url, errors.New("already running")
			}
		}
	}
	return nil, "", lastErr
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		logf("Open %s in your browser.", url)
	}
}

// ---------- HTTP API ----------

func newAPI(s *Store, port int, quit chan struct{}) http.Handler {
	mux := http.NewServeMux()
	web, _ := fs.Sub(webFS, "web")
	static := http.FileServer(http.FS(web))

	mux.Handle("GET /", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		static.ServeHTTP(w, r)
	}))
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		send(w, map[string]string{"app": "muster", "version": version})
	})
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		send(w, map[string]any{"version": version, "settings": s.Settings(), "library": s.Library(), "parades": s.Parades(), "musicDir": s.musicDir})
	})

	// music
	mux.HandleFunc("GET /audio/{id}", func(w http.ResponseWriter, r *http.Request) {
		path, ok := s.TrackFile(r.PathValue("id"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		f, err := os.Open(path)
		if err != nil {
			http.Error(w, "music file could not be opened", http.StatusNotFound)
			return
		}
		defer f.Close()
		st, _ := f.Stat()
		w.Header().Set("Content-Type", audioType(path))
		http.ServeContent(w, r, filepath.Base(path), st.ModTime(), f)
	})
	mux.HandleFunc("POST /api/rescan", func(w http.ResponseWriter, r *http.Request) {
		n, err := s.Rescan()
		if err != nil {
			fault(w, 500, err)
			return
		}
		send(w, map[string]any{"added": n, "library": s.Library()})
	})
	mux.HandleFunc("POST /api/music", func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 2<<30)
		mr, err := r.MultipartReader()
		if err != nil {
			fault(w, 400, err)
			return
		}
		saved, problems := []string{}, []string{}
		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				fault(w, 400, err)
				return
			}
			if part.FileName() == "" {
				continue
			}
			name, err := s.SaveUpload(part.FileName(), func(f *os.File) error {
				_, err := io.Copy(f, part)
				return err
			})
			if err != nil {
				problems = append(problems, err.Error())
			} else {
				saved = append(saved, name)
			}
		}
		if _, err := s.Rescan(); err != nil {
			fault(w, 500, err)
			return
		}
		logf("Imported %d file(s)", len(saved))
		send(w, map[string]any{"saved": saved, "problems": problems, "library": s.Library()})
	})
	mux.HandleFunc("PATCH /api/tracks/{id}", func(w http.ResponseWriter, r *http.Request) {
		var p TrackPatch
		if !decode(w, r, &p) {
			return
		}
		t, err := s.PatchTrack(r.PathValue("id"), p)
		if err != nil {
			fault(w, code(err), err)
			return
		}
		send(w, t)
	})

	// parades
	mux.HandleFunc("GET /api/parades/{id}", func(w http.ResponseWriter, r *http.Request) {
		p, err := s.Parade(r.PathValue("id"))
		if err != nil {
			fault(w, code(err), err)
			return
		}
		send(w, p)
	})
	mux.HandleFunc("POST /api/parades", func(w http.ResponseWriter, r *http.Request) {
		var p Parade
		if !decode(w, r, &p) {
			return
		}
		p.ID = ""
		saved, err := s.SaveParade(p)
		if err != nil {
			fault(w, 400, err)
			return
		}
		send(w, saved)
	})
	mux.HandleFunc("PUT /api/parades/{id}", func(w http.ResponseWriter, r *http.Request) {
		var p Parade
		if !decode(w, r, &p) {
			return
		}
		p.ID = r.PathValue("id")
		saved, err := s.SaveParade(p)
		if err != nil {
			fault(w, 400, err)
			return
		}
		send(w, saved)
	})
	mux.HandleFunc("DELETE /api/parades/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := s.DeleteParade(r.PathValue("id")); err != nil {
			fault(w, code(err), err)
			return
		}
		send(w, map[string]bool{"ok": true})
	})

	// settings, backup, quit
	mux.HandleFunc("PUT /api/settings", func(w http.ResponseWriter, r *http.Request) {
		var v Settings
		if !decode(w, r, &v) {
			return
		}
		out, err := s.SaveSettings(v)
		if err != nil {
			fault(w, 500, err)
			return
		}
		send(w, out)
	})
	mux.HandleFunc("GET /api/backup", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="muster-backup-%s.json"`, time.Now().Format("2006-01-02")))
		send(w, s.Export())
	})
	mux.HandleFunc("POST /api/restore", func(w http.ResponseWriter, r *http.Request) {
		var b BackupFile
		if !decode(w, r, &b) {
			return
		}
		msg, err := s.Restore(b)
		if err != nil {
			fault(w, 400, err)
			return
		}
		send(w, map[string]string{"message": msg})
	})
	mux.HandleFunc("POST /api/quit", func(w http.ResponseWriter, r *http.Request) {
		send(w, map[string]bool{"ok": true})
		go func() { time.Sleep(300 * time.Millisecond); quit <- struct{}{} }()
	})

	return guard(port, mux)
}

// guard blocks requests from other websites: the Host must be this machine,
// and anything that changes data must carry the X-Muster header (which a
// cross-site page cannot send without a preflight we never approve).
func guard(port int, next http.Handler) http.Handler {
	okHosts := map[string]bool{
		fmt.Sprintf("localhost:%d", port): true,
		fmt.Sprintf("127.0.0.1:%d", port): true,
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !okHosts[r.Host] {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("X-Muster") != "1" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		defer func() {
			if v := recover(); v != nil {
				logf("panic on %s %s: %v", r.Method, r.URL.Path, v)
				http.Error(w, "internal error", 500)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func audioType(p string) string {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".m4a", ".aac":
		return "audio/mp4"
	case ".mp3":
		return "audio/mpeg"
	case ".wav":
		return "audio/wav"
	case ".flac":
		return "audio/flac"
	case ".opus", ".ogg", ".oga":
		return "audio/ogg"
	}
	return "application/octet-stream"
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		fault(w, 400, fmt.Errorf("could not read request: %v", err))
		return false
	}
	return true
}

func send(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func fault(w http.ResponseWriter, status int, err error) {
	if status >= 500 {
		logf("error: %v", err)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

func code(err error) int {
	if errors.Is(err, errNotFound) {
		return 404
	}
	return 500
}
