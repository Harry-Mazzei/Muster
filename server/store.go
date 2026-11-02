package main

import (
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// ---------- data types ----------

type Track struct {
	ID         string    `json:"id"`
	File       string    `json:"file"`
	Title      string    `json:"title"`
	Category   string    `json:"category"`
	Order      int       `json:"order"`
	Duration   float64   `json:"duration"`
	BPM        float64   `json:"bpm"`
	BPM2       float64   `json:"bpm2"`      // second tempo after a slow→quick change
	Change     float64   `json:"change"`    // time of the tempo change in seconds (0 = none)
	AV         int       `json:"av"`        // beat analysis version
	TrimStart  float64   `json:"trimStart"` // where playback starts (seconds)
	TrimEnd    float64   `json:"trimEnd"`   // where playback ends; 0 = not worked out yet
	TrimSet    bool      `json:"trimSet"`   // trim adjusted by hand
	Beats      []float64 `json:"beats"`
	Points     []float64 `json:"points"`
	Confidence float64   `json:"confidence"`
	Gain       float64   `json:"gain"`
	Analysed   bool      `json:"analysed"`
	Checked    bool      `json:"checked"`
	Missing    bool      `json:"missing"`
}

type Item struct {
	UID        string `json:"uid"`
	TrackID    string `json:"trackId"`
	Label      string `json:"label"`
	Cue        string `json:"cue"`
	Loop       bool   `json:"loop"`
	Auto       bool   `json:"auto"`       // roll straight into the next movement when this one finishes
	Transition string `json:"transition"` // "beat" | "now"
}

type Parade struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Notes   string    `json:"notes"`
	Created time.Time `json:"created"`
	Updated time.Time `json:"updated"`
	Items   []Item    `json:"items"`
}

type ParadeSummary struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Updated time.Time `json:"updated"`
	Count   int       `json:"count"`
}

type Settings struct {
	Theme       string   `json:"theme"` // day | night | system
	FadeSeconds float64  `json:"fadeSeconds"`
	OffsetMs    float64  `json:"offsetMs"`
	Volume      float64  `json:"volume"`
	BeatFlash   bool     `json:"beatFlash"`
	LastParade  string   `json:"lastParade"`
	Favourites  []string `json:"favourites"` // up to 9 track ids for emergency keys 1-9
}

func defaultSettings() Settings {
	return Settings{Theme: "system", FadeSeconds: 5, OffsetMs: 0, Volume: 1, BeatFlash: true, Favourites: []string{}}
}

// ---------- store ----------

type Store struct {
	mu         sync.Mutex
	root       string
	musicDir   string
	dataDir    string
	tracks     map[string]*Track
	settings   Settings
	lastBackup map[string]time.Time
}

var (
	audioExt  = regexp.MustCompile(`(?i)\.(m4a|mp3|wav|aac|flac|ogg|oga|opus)$`)
	idRe      = regexp.MustCompile(`^[0-9a-f]{8,32}$`)
	numPrefix = regexp.MustCompile(`^(\d+)[\s._-]+(.*)$`)
)

var categoryRules = []struct {
	re  *regexp.Regexp
	cat string
}{
	{regexp.MustCompile(`(?i)salute|point of war|schedule`), "Salutes"},
	{regexp.MustCompile(`(?i)advance australia fair|god save|anthem`), "National Anthems"},
	{regexp.MustCompile(`(?i)drum`), "Drums"},
	{regexp.MustCompile(`(?i)slow to quick|dignified occasion`), "Slow to Quick Time"},
	{regexp.MustCompile(`(?i)slow march|scipio|duke of york|golden spurs|preobrajensky`), "Slow March"},
	{regexp.MustCompile(`(?i)advance in rev`), "Advance in Review Order"},
	{regexp.MustCompile(`(?i)march`), "Quick March"},
	{regexp.MustCompile(`(?i)reveille|alert|carry on|long g|last post|lights out|rouse|retreat|bugle`), "Bugle Calls"},
	{regexp.MustCompile(`(?i)hymn|abide with me|sunset|eternal father`), "Hymns & Sunset"},
}

func trackID(file string) string {
	h := sha1.Sum([]byte(strings.ToLower(file)))
	return hex.EncodeToString(h[:])[:12]
}

func newID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func NewStore(root string) (*Store, error) {
	s := &Store{
		root:       root,
		musicDir:   filepath.Join(root, "music"),
		dataDir:    filepath.Join(root, "data"),
		tracks:     map[string]*Track{},
		settings:   defaultSettings(),
		lastBackup: map[string]time.Time{},
	}
	for _, d := range []string{s.musicDir, s.dataDir, s.paradeDir(), s.backupDir()} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}
	var lib []*Track
	if err := readJSON(filepath.Join(s.dataDir, "library.json"), &lib); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("library.json is damaged (%v); restore it from data/backups", err)
	}
	for _, t := range lib {
		s.tracks[t.ID] = t
	}
	if err := readJSON(filepath.Join(s.dataDir, "settings.json"), &s.settings); err != nil && !errors.Is(err, os.ErrNotExist) {
		logf("settings.json unreadable, using defaults: %v", err)
		s.settings = defaultSettings()
	}
	s.sanitiseSettings(&s.settings)
	if _, err := s.Rescan(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) paradeDir() string { return filepath.Join(s.dataDir, "parades") }
func (s *Store) backupDir() string { return filepath.Join(s.dataDir, "backups") }

// ---------- files ----------

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// writeJSON writes atomically: temp file in the same folder, sync, rename.
func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err = tmp.Write(b); err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(name, path)
		if err != nil { // Windows: rename over an open/locked file can fail; retry once after removing
			_ = os.Remove(path)
			err = os.Rename(name, path)
		}
	}
	if err != nil {
		_ = os.Remove(name)
	}
	return err
}

// backup copies an existing file into data/backups at most every 5 minutes per key,
// keeping the newest 20 copies per key.
func (s *Store) backup(key, path string, force bool) {
	if !force && time.Since(s.lastBackup[key]) < 5*time.Minute {
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	s.lastBackup[key] = time.Now()
	dst := filepath.Join(s.backupDir(), fmt.Sprintf("%s-%s.json", key, time.Now().Format("20060102-150405")))
	if err := os.WriteFile(dst, b, 0o644); err != nil {
		logf("backup failed: %v", err)
		return
	}
	matches, _ := filepath.Glob(filepath.Join(s.backupDir(), key+"-*.json"))
	sort.Strings(matches)
	for len(matches) > 20 {
		_ = os.Remove(matches[0])
		matches = matches[1:]
	}
}

// ---------- library ----------

func (s *Store) saveLibraryLocked() error {
	p := filepath.Join(s.dataDir, "library.json")
	s.backup("library", p, false)
	return writeJSON(p, s.libraryLocked())
}

func (s *Store) libraryLocked() []*Track {
	out := make([]*Track, 0, len(s.tracks))
	for _, t := range s.tracks {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title)
	})
	return out
}

func (s *Store) Library() []*Track {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.libraryLocked()
}

func (s *Store) TrackFile(id string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tracks[id]
	if !ok || t.Missing {
		return "", false
	}
	return filepath.Join(s.musicDir, t.File), true
}

func guessTrack(file string) *Track {
	base := strings.TrimSuffix(file, filepath.Ext(file))
	order := 1000
	title := base
	if m := numPrefix.FindStringSubmatch(base); m != nil {
		fmt.Sscanf(m[1], "%d", &order)
		title = m[2]
	}
	title = strings.TrimSpace(strings.ReplaceAll(title, "_", " "))
	cat := "Other"
	for _, r := range categoryRules {
		if r.re.MatchString(title) {
			cat = r.cat
			break
		}
	}
	return &Track{ID: trackID(file), File: file, Title: title, Category: cat, Order: order, Gain: 1, Beats: []float64{}, Points: []float64{}}
}

// Rescan syncs the library with the music folder. Returns the number of new tracks.
func (s *Store) Rescan() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.musicDir)
	if err != nil {
		return 0, err
	}
	var presets map[string]*Track
	_ = readJSON(filepath.Join(s.dataDir, "presets.json"), &presets)
	seen := map[string]bool{}
	added, upgraded := 0, 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || strings.HasPrefix(name, ".") || !audioExt.MatchString(name) {
			continue
		}
		id := trackID(name)
		seen[id] = true
		if t, ok := s.tracks[id]; ok {
			t.Missing = false
			t.File = name
			// newer prepared beat data replaces older automatic data (never hand-checked tracks)
			if p, ok := presets[name]; ok && t.TrimEnd == 0 && !t.TrimSet && p.TrimEnd > 0 {
				t.TrimStart, t.TrimEnd = p.TrimStart, p.TrimEnd
				upgraded++
			}
			if p, ok := presets[name]; ok && p.AV > t.AV && !t.Checked {
				t.BPM, t.BPM2, t.Change, t.Confidence, t.AV = p.BPM, p.BPM2, p.Change, p.Confidence, p.AV
				t.Beats, t.Points = cleanTimes(p.Beats, 0), cleanTimes(p.Points, 0)
				upgraded++
			}
			continue
		}
		t := guessTrack(name)
		if p, ok := presets[name]; ok {
			p.ID, p.File, p.Gain = id, name, 1
			if p.Beats == nil {
				p.Beats = []float64{}
			}
			if p.Points == nil {
				p.Points = []float64{}
			}
			t = p
		}
		s.tracks[id] = t
		added++
	}
	changed := added > 0 || upgraded > 0
	for id, t := range s.tracks {
		if !seen[id] && !t.Missing {
			t.Missing = true
			changed = true
		}
	}
	if changed {
		if err := s.saveLibraryLocked(); err != nil {
			return added, err
		}
	}
	return added, nil
}

type TrackPatch struct {
	Title      *string    `json:"title"`
	Category   *string    `json:"category"`
	Duration   *float64   `json:"duration"`
	BPM        *float64   `json:"bpm"`
	BPM2       *float64   `json:"bpm2"`
	Change     *float64   `json:"change"`
	AV         *int       `json:"av"`
	TrimStart  *float64   `json:"trimStart"`
	TrimEnd    *float64   `json:"trimEnd"`
	TrimSet    *bool      `json:"trimSet"`
	Beats      *[]float64 `json:"beats"`
	Points     *[]float64 `json:"points"`
	Confidence *float64   `json:"confidence"`
	Gain       *float64   `json:"gain"`
	Analysed   *bool      `json:"analysed"`
	Checked    *bool      `json:"checked"`
}

func cleanTimes(v []float64, max float64) []float64 {
	out := make([]float64, 0, len(v))
	for _, x := range v {
		if x >= 0 && (max <= 0 || x <= max+1) && x == x {
			out = append(out, float64(int64(x*1000+0.5))/1000)
		}
	}
	sort.Float64s(out)
	if len(out) > 20000 {
		out = out[:20000]
	}
	return out
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	r := []rune(s)
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}

func (s *Store) PatchTrack(id string, p TrackPatch) (*Track, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tracks[id]
	if !ok {
		return nil, errNotFound
	}
	if p.Title != nil && clip(*p.Title, 120) != "" {
		t.Title = clip(*p.Title, 120)
	}
	if p.Category != nil && clip(*p.Category, 60) != "" {
		t.Category = clip(*p.Category, 60)
	}
	if p.Duration != nil && *p.Duration > 0 && *p.Duration < 36000 {
		t.Duration = *p.Duration
	}
	if p.BPM != nil && *p.BPM >= 0 && *p.BPM < 400 {
		t.BPM = *p.BPM
	}
	if p.BPM2 != nil && *p.BPM2 >= 0 && *p.BPM2 < 400 {
		t.BPM2 = *p.BPM2
	}
	if p.Change != nil && *p.Change >= 0 {
		t.Change = *p.Change
	}
	if p.AV != nil {
		t.AV = *p.AV
	}
	if p.TrimStart != nil || p.TrimEnd != nil {
		ts, te := t.TrimStart, t.TrimEnd
		if p.TrimStart != nil {
			ts = *p.TrimStart
		}
		if p.TrimEnd != nil {
			te = *p.TrimEnd
		}
		if ts < 0 || te < 0 || (te > 0 && te < ts+0.2) || (t.Duration > 0 && (ts > t.Duration || te > t.Duration+1)) {
			return nil, fmt.Errorf("those start and end points don't fit this track")
		}
		t.TrimStart, t.TrimEnd = ts, te
	}
	if p.TrimSet != nil {
		t.TrimSet = *p.TrimSet
	}
	if p.Beats != nil {
		t.Beats = cleanTimes(*p.Beats, t.Duration)
	}
	if p.Points != nil {
		t.Points = cleanTimes(*p.Points, t.Duration)
	}
	if p.Confidence != nil {
		t.Confidence = *p.Confidence
	}
	if p.Gain != nil && *p.Gain >= 0 && *p.Gain <= 4 {
		t.Gain = *p.Gain
	}
	if p.Analysed != nil {
		t.Analysed = *p.Analysed
	}
	if p.Checked != nil {
		t.Checked = *p.Checked
	}
	return t, s.saveLibraryLocked()
}

// SaveUpload stores an uploaded audio file in the music folder under a safe, unique name.
func (s *Store) SaveUpload(name string, write func(f *os.File) error) (string, error) {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`<>:"/\|?*`, r) || r < 32 {
			return '_'
		}
		return r
	}, name)
	if !audioExt.MatchString(name) || strings.HasPrefix(name, ".") {
		return "", fmt.Errorf("%s is not a supported audio file (m4a, mp3, wav, aac, flac, ogg)", name)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	final := name
	for i := 2; ; i++ {
		if _, err := os.Stat(filepath.Join(s.musicDir, final)); errors.Is(err, os.ErrNotExist) {
			break
		}
		final = fmt.Sprintf("%s (%d)%s", stem, i, ext)
	}
	tmp, err := os.CreateTemp(s.musicDir, ".upload-*")
	if err != nil {
		return "", err
	}
	err = write(tmp)
	tmp.Close()
	if err == nil {
		err = os.Rename(tmp.Name(), filepath.Join(s.musicDir, final))
	}
	if err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	return final, nil
}

// ---------- settings ----------

func (s *Store) sanitiseSettings(v *Settings) {
	switch v.Theme {
	case "day", "night", "system":
	default:
		v.Theme = "system"
	}
	if v.FadeSeconds < 0.5 || v.FadeSeconds > 30 {
		v.FadeSeconds = 5
	}
	if v.OffsetMs < -500 || v.OffsetMs > 500 {
		v.OffsetMs = 0
	}
	if v.Volume < 0 || v.Volume > 1 {
		v.Volume = 1
	}
	favs, seen := []string{}, map[string]bool{}
	for _, id := range v.Favourites {
		if idRe.MatchString(id) && !seen[id] && len(favs) < 9 {
			seen[id] = true
			favs = append(favs, id)
		}
	}
	v.Favourites = favs
	if v.LastParade != "" && !idRe.MatchString(v.LastParade) {
		v.LastParade = ""
	}
}

func (s *Store) Settings() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settings
}

func (s *Store) SaveSettings(v Settings) (Settings, error) {
	s.sanitiseSettings(&v)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.settings = v
	return v, writeJSON(filepath.Join(s.dataDir, "settings.json"), v)
}

// ---------- parades ----------

var errNotFound = errors.New("not found")

func (s *Store) paradePath(id string) (string, error) {
	if !idRe.MatchString(id) {
		return "", errNotFound
	}
	return filepath.Join(s.paradeDir(), id+".json"), nil
}

func (s *Store) Parades() []ParadeSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	files, _ := filepath.Glob(filepath.Join(s.paradeDir(), "*.json"))
	out := []ParadeSummary{}
	for _, f := range files {
		var p Parade
		if err := readJSON(f, &p); err != nil || p.ID == "" {
			logf("skipping unreadable parade %s: %v", filepath.Base(f), err)
			continue
		}
		out = append(out, ParadeSummary{p.ID, p.Name, p.Updated, len(p.Items)})
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

func (s *Store) Parade(id string) (*Parade, error) {
	path, err := s.paradePath(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var p Parade
	if err := readJSON(path, &p); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, errNotFound
		}
		return nil, err
	}
	return &p, nil
}

func (s *Store) SaveParade(p Parade) (*Parade, error) {
	if p.ID == "" {
		p.ID = newID()
	}
	path, err := s.paradePath(p.ID)
	if err != nil {
		return nil, fmt.Errorf("invalid parade id")
	}
	p.Name = clip(p.Name, 100)
	if p.Name == "" {
		p.Name = "Untitled parade"
	}
	p.Notes = clip(p.Notes, 2000)
	if len(p.Items) > 500 {
		return nil, fmt.Errorf("a parade can hold at most 500 movements")
	}
	if p.Items == nil {
		p.Items = []Item{}
	}
	for i := range p.Items {
		it := &p.Items[i]
		if !idRe.MatchString(it.UID) {
			it.UID = newID()
		}
		if !idRe.MatchString(it.TrackID) {
			return nil, fmt.Errorf("movement %d has no music selected", i+1)
		}
		it.Label = clip(it.Label, 120)
		it.Cue = clip(it.Cue, 500)
		if it.Transition != "now" {
			it.Transition = "beat"
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var old Parade
	if readJSON(path, &old) == nil {
		p.Created = old.Created
		s.backup("parade-"+p.ID, path, false)
	}
	if p.Created.IsZero() {
		p.Created = time.Now()
	}
	p.Updated = time.Now()
	return &p, writeJSON(path, p)
}

func (s *Store) DeleteParade(id string) error {
	path, err := s.paradePath(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := os.Stat(path); err != nil {
		return errNotFound
	}
	s.backup("deleted-"+id, path, true)
	return os.Remove(path)
}

// ---------- full backup / restore ----------

type BackupFile struct {
	App      string    `json:"app"`
	Version  string    `json:"version"`
	Exported time.Time `json:"exported"`
	Settings *Settings `json:"settings,omitempty"`
	Library  []*Track  `json:"library,omitempty"`
	Parades  []Parade  `json:"parades"`
}

func (s *Store) Export() BackupFile {
	b := BackupFile{App: "muster", Version: version, Exported: time.Now(), Parades: []Parade{}}
	set := s.Settings()
	b.Settings = &set
	b.Library = s.Library()
	for _, sum := range s.Parades() {
		if p, err := s.Parade(sum.ID); err == nil {
			b.Parades = append(b.Parades, *p)
		}
	}
	return b
}

// Restore merges a backup: parades are added/replaced by id, settings replaced,
// track details (title, category, beat points, gain) applied to tracks with the same file name.
func (s *Store) Restore(b BackupFile) (string, error) {
	if b.App != "muster" {
		return "", fmt.Errorf("this file is not a Muster backup or parade file")
	}
	np := 0
	for _, p := range b.Parades {
		if _, err := s.SaveParade(p); err != nil {
			return "", fmt.Errorf("parade %q: %v", p.Name, err)
		}
		np++
	}
	if b.Settings != nil {
		if _, err := s.SaveSettings(*b.Settings); err != nil {
			return "", err
		}
	}
	nt := 0
	if len(b.Library) > 0 {
		s.mu.Lock()
		for _, in := range b.Library {
			if t, ok := s.tracks[trackID(in.File)]; ok {
				t.Title, t.Category = clip(in.Title, 120), clip(in.Category, 60)
				t.Beats, t.Points = cleanTimes(in.Beats, 0), cleanTimes(in.Points, 0)
				t.BPM, t.Confidence, t.Analysed, t.Checked = in.BPM, in.Confidence, in.Analysed, in.Checked
				t.BPM2, t.Change, t.AV = in.BPM2, in.Change, in.AV
				t.TrimStart, t.TrimEnd, t.TrimSet = in.TrimStart, in.TrimEnd, in.TrimSet
				if in.Gain >= 0 && in.Gain <= 4 {
					t.Gain = in.Gain
				}
				nt++
			}
		}
		err := s.saveLibraryLocked()
		s.mu.Unlock()
		if err != nil {
			return "", err
		}
	}
	return fmt.Sprintf("Restored %d parade(s) and details for %d track(s).", np, nt), nil
}
